import { describe, expect, it, vi } from 'vitest';

import { AvairClient } from '../../src/lib/http.js';
import type { SecretStore } from '../../src/lib/auth/store.js';

const store: SecretStore = {
  get: async () => ({ accessToken: 'avp_secret', kind: 'pat' }),
  set: async () => undefined,
  delete: async () => undefined,
};
const globals = { environment: 'local' as const, yes: true };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('AvairClient', () => {
  it('retries reads twice and keeps authentication out of output', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(503, { error: 'down' }))
      .mockResolvedValueOnce(response(502, { error: 'down' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const result = await new AvairClient(globals, store, fetcher, async () => undefined).request('/campaigns/');
    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer avp_secret');
  });

  it('does not retry an ordinary write', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(503, { error: 'down' }));
    await expect(new AvairClient(globals, store, fetcher).request('/campaigns/x/start', { method: 'POST' })).rejects.toMatchObject({ exitCode: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends server confirmation and masks dry-run credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { ok: true }));
    await new AvairClient(globals, store, fetcher).request('/campaigns/x/start', { method: 'POST' });
    expect(fetcher.mock.calls[0][1].headers['X-Avair-Confirm']).toBe('yes');
    const dry = await new AvairClient({ ...globals, dryRun: true }, store, fetcher).request('/x') as Record<string, any>;
    expect(dry.headers.Authorization).toBe('Bearer ***');
  });

  it('waits what Retry-After asks before retrying a read, else 1 s then 2 s (B1)', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const asked = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'Retry-After': '7' } }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await new AvairClient(globals, store, asked, sleep).request('/campaigns/');
    expect(sleeps).toEqual([7000]);
    sleeps.length = 0;
    const plain = vi.fn()
      .mockResolvedValueOnce(response(502, {})).mockResolvedValueOnce(response(502, {}))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await new AvairClient(globals, store, plain, sleep).request('/campaigns/');
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('gives up on a request that hears nothing back, and says a write may have happened (B1)', async () => {
    const hang = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    await expect(new AvairClient(globals, store, hang as typeof fetch).request('/campaigns/x/start', { method: 'POST', timeoutMs: 20 }))
      .rejects.toMatchObject({ exitCode: 10, details: { code: 'request_timeout' } });
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it('names the idempotency key when a keyed write times out or the network fails, so a retry can reuse it (F19)', async () => {
    const hang = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const keyed = { method: 'POST', headers: { 'Idempotency-Key': 'key-123' }, timeoutMs: 20 };
    const timedOut = new AvairClient(globals, store, hang as typeof fetch).request('/tools/find-accounts/runs', keyed);
    await expect(timedOut).rejects.toMatchObject({ exitCode: 10, details: { code: 'request_timeout', hint: 'To retry, pass --idempotency-key key-123.' } });
    await expect(new AvairClient(globals, store, hang as typeof fetch).request('/tools/find-accounts/runs', keyed)).rejects.toThrow('--idempotency-key key-123');

    const offline = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new AvairClient(globals, store, offline, async () => undefined).request('/tools/find-accounts/runs', { ...keyed, retryWrite: true }))
      .rejects.toMatchObject({ exitCode: 10, details: { code: 'network_error', hint: 'To retry, pass --idempotency-key key-123.' } });
    expect(offline).toHaveBeenCalledTimes(3);
    expect(new Set(offline.mock.calls.map(call => call[1].headers['Idempotency-Key']))).toEqual(new Set(['key-123']));
  });

  it('a write without a key says nothing about one (F19)', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const error = await new AvairClient(globals, store, offline).request('/campaigns/x/start', { method: 'POST' }).catch((caught: Error) => caught) as Error;
    expect(error.message).not.toContain('idempotency');
  });

  it('--debug prints method, path, status, time and request id, never the token (B1)', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'X-Request-ID': 'req-1' } }));
    await new AvairClient({ ...globals, debug: true }, store, fetcher).request('/campaigns/', { query: { scope: 'mine' } });
    expect(lines.join('')).toMatch(/^\[debug\] GET \/api\/v1\/campaigns\/\?scope=mine -> 200 \d+ ms request_id=req-1\n$/);
    expect(lines.join('')).not.toContain('avp_secret');
    vi.restoreAllMocks();
  });
});
