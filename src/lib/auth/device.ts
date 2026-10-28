import { CliError, apiError } from '../errors.js';
import type { StoredCredential } from './store.js';

export type DeviceConfig = { domain: string; clientId: string; audience: string };
export type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

const form = (values: Record<string, string>) => new URLSearchParams(values);

const isTimeout = (error: unknown) => ['TimeoutError', 'AbortError'].includes((error as Error)?.name);
const noAnswer = (operation: string, timeoutMs = AUTH_TIMEOUT_MS) =>
  new CliError(`No answer from ${operation} after ${Math.round(timeoutMs / 1000)} s. Try again.`, 1, { code: 'auth_timeout' });

/** Each sign-in request has its own deadline (F7): a stalled Auth0 or
 * discovery endpoint must not hold a command past its request budget. */
export const AUTH_TIMEOUT_MS = 30_000;

async function authFetch(
  fetcher: typeof fetch, url: string | URL, init: RequestInit, operation: string,
  timeoutMs = AUTH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isTimeout(error)) throw noAnswer(operation, timeoutMs);
    throw error;
  }
}

async function jsonResponse(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch (error) {
    // The deadline also covers the body: a stalled body is not bad JSON.
    if (isTimeout(error)) throw noAnswer(operation);
    throw new CliError(
      `${operation} returned a non-JSON response (HTTP ${response.status}). Check the Auth0 domain and proxy configuration.`,
      3,
    );
  }
}

export function deviceConfig(env = process.env): DeviceConfig {
  const domain = env.AVAIR_AUTH0_DOMAIN;
  const clientId = env.AVAIR_AUTH0_CLI_CLIENT_ID;
  const audience = env.AVAIR_AUTH0_AGENT_AUDIENCE;
  if (!domain || !clientId || !audience) {
    throw new CliError('Device login is not configured. Set AVAIR_AUTH0_DOMAIN, AVAIR_AUTH0_CLI_CLIENT_ID and AVAIR_AUTH0_AGENT_AUDIENCE, or use --with-token.', 2);
  }
  return { domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''), clientId, audience };
}

export async function resolveDeviceConfig(
  apiBaseUrl: string,
  env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<DeviceConfig> {
  if (env.AVAIR_AUTH0_DOMAIN && env.AVAIR_AUTH0_CLI_CLIENT_ID && env.AVAIR_AUTH0_AGENT_AUDIENCE) {
    return deviceConfig(env);
  }
  const response = await authFetch(fetcher, new URL('/.well-known/oauth-protected-resource/mcp', apiBaseUrl), {}, 'Avair device login metadata');
  if (!response.ok) {
    throw new CliError('Avair device login metadata is unavailable. Use --with-token or configure the Auth0 CLI environment values.', 2);
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = await response.json() as Record<string, unknown>;
  } catch (error) {
    if (isTimeout(error)) throw noAnswer('Avair device login metadata');
    throw new CliError('Avair device login metadata returned an invalid response. Use --with-token or configure the Auth0 CLI environment values.', 2);
  }
  const authorizationServers = metadata.authorization_servers as string[] | undefined;
  const domain = authorizationServers?.[0];
  const clientId = metadata.avair_cli_client_id;
  const audience = metadata.avair_agent_audience ?? metadata.resource;
  if (!domain || typeof clientId !== 'string' || typeof audience !== 'string') {
    throw new CliError('Avair device login metadata is unavailable. Use --with-token or configure the Auth0 CLI environment values.', 2);
  }
  return {
    domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    clientId,
    audience,
  };
}

export async function beginDeviceFlow(config: DeviceConfig, fetcher: typeof fetch = fetch): Promise<DeviceCode> {
  const response = await authFetch(fetcher, `https://${config.domain}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: config.clientId, audience: config.audience, scope: 'openid profile email offline_access' }),
  }, 'Auth0 device authorization');
  const body = await jsonResponse(response, 'Auth0 device authorization');
  if (!response.ok) throw apiError(response.status, body, response.headers);
  return body as DeviceCode;
}

export async function pollDeviceFlow(
  config: DeviceConfig,
  device: DeviceCode,
  fetcher: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<StoredCredential> {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(device.interval || 5, 1) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    // A poll never outlives the device code.
    const left = deadline - Date.now();
    if (left <= 0) break;
    let response: Response;
    try {
      response = await authFetch(fetcher, `https://${config.domain}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: config.clientId }),
      }, 'Auth0 device token polling', Math.min(AUTH_TIMEOUT_MS, left));
    } catch (error) {
      // Cut short by the code's own lifetime: the code expired, Auth0 did not stall.
      if (left < AUTH_TIMEOUT_MS && error instanceof CliError && error.details.code === 'auth_timeout') break;
      throw error;
    }
    const body = await jsonResponse(response, 'Auth0 device token polling');
    if (response.ok) return {
      accessToken: String(body.access_token),
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
      kind: 'oauth',
    };
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { interval += 5000; continue; }
    throw apiError(response.status, body, response.headers);
  }
  throw new CliError('Device sign-in expired. Run `avair auth login` again.', 3);
}

export async function revokeRefreshToken(config: DeviceConfig, token: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await authFetch(fetcher, `https://${config.domain}/oauth/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: config.clientId, token }),
  }, 'Auth0 token revocation');
  if (!response.ok) {
    const body = await jsonResponse(response, 'Auth0 token revocation');
    throw apiError(response.status, body, response.headers);
  }
}

export async function refreshAccessToken(config: DeviceConfig, refreshToken: string, fetcher: typeof fetch = fetch): Promise<StoredCredential> {
  const response = await authFetch(fetcher, `https://${config.domain}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refreshToken }),
  }, 'Auth0 token refresh');
  const body = await jsonResponse(response, 'Auth0 token refresh');
  if (!response.ok) throw apiError(response.status, body, response.headers);
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    kind: 'oauth',
  };
}
