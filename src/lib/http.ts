import { CliError, apiError, retryAfterSeconds } from './errors.js';
import type { GlobalOptions } from './config.js';
import type { SecretStore, StoredCredential } from './auth/store.js';
import { assertAuthDomain, assertCredentialOrigin } from './auth/binding.js';
import { assertSafePath } from './path.js';
import { apiUrl } from './config.js';
import { confirmAction } from './confirm.js';
import { CLI_VERSION } from '../version.js';
import { refreshAccessToken, resolveDeviceConfig } from './auth/device.js';

export type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  retryWrite?: boolean;
  /** Multipart upload; sent instead of a JSON body. */
  form?: FormData;
  /** Return the response bytes (downloads) instead of parsed JSON. */
  raw?: boolean;
  /** Give up waiting for the answer after this long (B1). */
  timeoutMs?: number;
};

// A request that hears nothing back fails instead of hanging for undici's
// 300 s (CLI plan B1, P7). Uploads and downloads move a whole file, so they get longer.
export const DEFAULT_TIMEOUT_MS = 120_000;
export const FILE_TIMEOUT_MS = 600_000;
const MAX_RETRY_WAIT_MS = 30_000;

const refreshing = new Map<string, Promise<StoredCredential>>();

export class AvairClient {
  constructor(
    private readonly globals: GlobalOptions,
    private readonly store: SecretStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  /** --debug: one line per request on stderr, never the token (B1). */
  private debug(line: string): void {
    if (this.globals.debug) process.stderr.write(`[debug] ${line}\n`);
  }

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    assertSafePath(path);
    let credential = await this.store.get(this.globals.environment);
    if (!credential) throw new CliError('Not signed in. Run `avair auth login` or set AVAIR_TOKEN.', 3);
    const base = apiUrl(this.globals.environment, this.globals.apiUrl);
    assertCredentialOrigin(credential, this.globals.environment, base);
    // A dry run sends nothing, Auth0 included, and saves nothing: the token
    // is masked in its output, so an expired one does not matter (AVI-1130).
    if (
      !this.globals.dryRun
      && credential.kind === 'oauth' && credential.refreshToken && credential.expiresAt
      && credential.expiresAt <= Date.now() + 60_000
    ) {
      credential = await this.refresh(credential, base);
    }
    const method = (options.method || 'GET').toUpperCase();
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.accessToken}`,
      'X-Avair-Client': `cli/${CLI_VERSION}`,
      ...options.headers,
    };
    if (options.body !== undefined && !options.form) headers['Content-Type'] = 'application/json';
    if (this.globals.yes) headers['X-Avair-Confirm'] = 'yes';
    if (this.globals.dryRun) return { dry_run: true, method, path: `${url.pathname}${url.search}`, headers: { ...headers, Authorization: 'Bearer ***' }, body: options.form ? '<multipart file upload>' : options.body };

    const attempts = method === 'GET' || options.retryWrite ? 3 : 1;
    const timeoutMs = options.timeoutMs ?? (options.raw || options.form ? FILE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const target = `${method} ${url.pathname}${url.search}`;
    // A write that may have happened is retried safely only under the same key (F19).
    const idempotency = headers['Idempotency-Key'];
    const retryWith = idempotency ? ` To retry, pass --idempotency-key ${idempotency}.` : '';
    let confirmationRetried = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = Date.now();
      // Wait before the next try: what Retry-After asks, else 1 s then 2 s.
      const backoff = async (retryAfter?: string | null) => {
        const asked = retryAfterSeconds(retryAfter);
        await this.sleep(Math.min(asked !== undefined ? asked * 1000 : 1000 * 2 ** attempt, MAX_RETRY_WAIT_MS));
      };
      try {
        const response = await this.fetcher(url, {
          method, headers,
          body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        this.debug(`${target} -> ${response.status} ${Date.now() - started} ms request_id=${response.headers.get('X-Request-ID') ?? '-'}`);
        if (options.raw && response.ok) return Buffer.from(await response.arrayBuffer());
        const text = await response.text();
        const value = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
        if (response.ok) return value;
        if (
          response.status === 428 && !confirmationRetried && this.globals.input
          && await confirmAction(String((value as any)?.detail?.message || 'Confirm this action?'))
        ) {
          headers['X-Avair-Confirm'] = 'yes';
          confirmationRetried = true;
          attempt -= 1;
          continue;
        }
        if (attempt < attempts - 1 && [502, 503, 504].includes(response.status)) {
          await backoff(response.headers.get('Retry-After'));
          continue;
        }
        throw apiError(response.status, value, response.headers);
      } catch (error) {
        if (error instanceof CliError) throw error;
        const name = (error as Error).name;
        this.debug(`${target} -> ${name} after ${Date.now() - started} ms`);
        if (name === 'TimeoutError' || name === 'AbortError') {
          // Not retried: a write may have happened, and a read that slow will not get faster.
          throw new CliError(
            `No answer from Avair after ${Math.round(timeoutMs / 1000)} s.${method === 'GET' ? '' : ' The action may still have happened; check before you retry.'}${retryWith}`,
            method === 'GET' ? 1 : 10, { code: 'request_timeout', ...(idempotency ? { hint: retryWith.trim() } : {}) },
          );
        }
        if (attempt === attempts - 1) {
          throw new CliError(`Network request failed: ${(error as Error).message}${retryWith}`, method === 'GET' ? 1 : 10,
            idempotency ? { code: 'network_error', hint: retryWith.trim() } : {});
        }
        await backoff();
      }
    }
    throw new CliError('Request failed', 1);
  }

  /**
   * One renewal per process and environment: parallel requests near expiry
   * share it, so the refresh token is used once (S11).
   */
  private refresh(credential: StoredCredential, base: string): Promise<StoredCredential> {
    const key = this.globals.environment;
    let pending = refreshing.get(key);
    if (!pending) {
      pending = (async () => {
        const config = await resolveDeviceConfig(base, process.env, this.fetcher);
        assertAuthDomain(credential, config.domain);
        const renewed: StoredCredential = {
          ...await refreshAccessToken(config, credential.refreshToken as string, this.fetcher),
          apiOrigin: credential.apiOrigin,
          authDomain: credential.authDomain ?? config.domain,
        };
        await this.store.set(key, renewed);
        return renewed;
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    return pending;
  }
}
