import { describe, expect, it, vi } from 'vitest';

import {
  beginDeviceFlow,
  pollDeviceFlow,
  refreshAccessToken,
  resolveDeviceConfig,
  revokeRefreshToken,
} from '../../src/lib/auth/device.js';

const config = { domain: 'login.example', clientId: 'cli-id', audience: 'https://app.example/mcp' };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('device authentication', () => {
  it('discovers public Auth0 settings without requiring local environment values', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, {
      resource: 'https://app.example/mcp',
      avair_agent_audience: 'https://agent-api.example',
      authorization_servers: ['https://tenant.example.auth0.com/'],
      avair_cli_client_id: 'public-cli-id',
    }));
    await expect(resolveDeviceConfig('https://api.example/api/v1', {}, fetcher)).resolves.toEqual({
      domain: 'tenant.example.auth0.com', clientId: 'public-cli-id', audience: 'https://agent-api.example',
    });
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example/.well-known/oauth-protected-resource/mcp');
  });

  it('reports HTML discovery failures without a JSON parser crash', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>not found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    await expect(resolveDeviceConfig('https://api.example/api/v1', {}, fetcher))
      .rejects.toThrow('metadata is unavailable');
  });

  it('polls through authorization_pending and stores expiry metadata', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(response(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
    const credential = await pollDeviceFlow(config, {
      device_code: 'device', user_code: 'CODE', verification_uri: 'https://login.example/activate', expires_in: 60, interval: 1,
    }, fetcher, async () => undefined);
    expect(credential).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', kind: 'oauth' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the old refresh token when Auth0 rotates only the access token', async () => {
    const credential = await refreshAccessToken(config, 'old-refresh', vi.fn().mockResolvedValue(response(200, {
      access_token: 'new-access', expires_in: 600,
    })));
    expect(credential).toMatchObject({ accessToken: 'new-access', refreshToken: 'old-refresh', kind: 'oauth' });
  });

  it('reports non-JSON Auth0 responses for every device-flow call', async () => {
    const html = () => new Response('<html>proxy error</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
    const fetcher = vi.fn().mockImplementation(async () => html());
    const device = {
      device_code: 'device', user_code: 'CODE',
      verification_uri: 'https://login.example/activate', expires_in: 1, interval: 1,
    };

    await expect(beginDeviceFlow(config, fetcher)).rejects.toThrow('non-JSON response');
    await expect(pollDeviceFlow(config, device, fetcher, async () => undefined)).rejects.toThrow('non-JSON response');
    await expect(refreshAccessToken(config, 'refresh', fetcher)).rejects.toThrow('non-JSON response');
    await expect(revokeRefreshToken(config, 'refresh', fetcher)).rejects.toThrow('non-JSON response');
  });

  it('gives every sign-in request its own deadline and names a stalled one (F7)', async () => {
    const stalled = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const device = { device_code: 'd', user_code: 'C', verification_uri: 'https://login.example/activate', expires_in: 60, interval: 1 };
    const calls: Array<[string, Promise<unknown>]> = [
      ['metadata', resolveDeviceConfig('https://api.example/api/v1', {}, stalled)],
      ['device authorization', beginDeviceFlow(config, stalled)],
      ['device token polling', pollDeviceFlow(config, device, stalled, async () => undefined)],
      ['token refresh', refreshAccessToken(config, 'refresh', stalled)],
      ['token revocation', revokeRefreshToken(config, 'refresh', stalled)],
    ];
    for (const [operation, call] of calls) {
      await expect(call).rejects.toMatchObject({ message: expect.stringContaining(operation), details: { code: 'auth_timeout' } });
    }
  });

  it('never polls past the device code lifetime', async () => {
    const fetcher = vi.fn();
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(pollDeviceFlow(config, {
        device_code: 'd', user_code: 'C', verification_uri: 'https://login.example/activate', expires_in: 5, interval: 1,
      }, fetcher as unknown as typeof fetch, async () => { now += 6000; })).rejects.toThrow('Device sign-in expired');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a body that stalls after the headers as no answer, not as bad JSON', async () => {
    const stalledBody = { ok: true, status: 200, json: async () => { throw new DOMException('aborted', 'TimeoutError'); } } as unknown as Response;
    await expect(refreshAccessToken(config, 'refresh', vi.fn().mockResolvedValue(stalledBody)))
      .rejects.toMatchObject({ details: { code: 'auth_timeout' } });
    await expect(resolveDeviceConfig('https://api.example/api/v1', {}, vi.fn().mockResolvedValue(stalledBody)))
      .rejects.toMatchObject({ details: { code: 'auth_timeout' } });
  });

  it('a poll cut short by the end of the device code says the code expired', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fetcher = vi.fn(async () => { throw new DOMException('aborted', 'TimeoutError'); });
      await expect(pollDeviceFlow(config, {
        device_code: 'd', user_code: 'C', verification_uri: 'https://login.example/activate', expires_in: 5, interval: 1,
      }, fetcher as unknown as typeof fetch, async () => { now += 1000; })).rejects.toThrow('Device sign-in expired');
      expect(fetcher).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
