import { CliError } from '../errors.js';
import { defaultApiUrl, type EnvironmentName } from '../config.js';
import type { StoredCredential } from './store.js';

// A saved sign-in is sent only to the API address it was made for, and its
// renewal pass only to the Auth0 domain that issued it (CLI plan A4, S2).
// Otherwise one injected `avair config set api-url.prod https://evil/...`
// would send the token, and on renewal the refresh token, to that host.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocal(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

/** The origin of an API address; https only, except on this computer. */
export function apiOrigin(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new CliError(`Not a valid API address: ${base}.`, 2, { code: 'invalid_input' }); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url))) {
    throw new CliError(`The API address must use https: ${base}.`, 2, { code: 'insecure_api_url' });
  }
  // Every request path is appended to the address: a `?` or `#` in it would
  // push the command's own path out of the route (`…/campaigns/C/start#` turns
  // a cancel into a launch).
  if (/[?#]/.test(base)) {
    throw new CliError(`The API address may not hold a query or fragment: ${base}.`, 2, { code: 'invalid_api_url' });
  }
  return url.origin;
}

/**
 * The origin a credential may be sent to. A sign-in saved by CLI 0.1.0 has
 * none recorded: it belongs to the environment's built-in address.
 */
export function boundOrigin(credential: StoredCredential, environment: EnvironmentName): string | null {
  if (credential.apiOrigin) return credential.apiOrigin;
  const builtIn = defaultApiUrl(environment);
  return builtIn ? new URL(builtIn).origin : null;
}

/**
 * Refuse to send a saved sign-in anywhere but its own API. AVAIR_TOKEN is the
 * caller's own choice for this shell, so only the https rule applies to it.
 */
export function assertCredentialOrigin(credential: StoredCredential, environment: EnvironmentName, base: string): string {
  const origin = apiOrigin(base);
  if (credential.fromEnv) return origin;
  const bound = boundOrigin(credential, environment);
  if (bound !== origin) {
    const owner = bound
      ? `belongs to ${bound}, not ${origin}`
      : 'was made by an older CLI and has no recorded address';
    throw new CliError(
      `The saved sign-in for ${environment} ${owner}. Run \`avair auth login\` to sign in to ${origin}.`,
      3, { code: 'credential_origin_mismatch' },
    );
  }
  return origin;
}

/**
 * Refuse to send a refresh token to an Auth0 domain other than the one that
 * issued it. A sign-in saved by 0.1.0 has no recorded domain: it is trusted
 * only with the domain the bound API's own metadata names, never with the
 * AVAIR_AUTH0_* overrides, which anything that can set a variable can change.
 */
export function assertAuthDomain(credential: StoredCredential, domain: string, env = process.env): void {
  if (!credential.authDomain && env.AVAIR_AUTH0_DOMAIN) {
    throw new CliError(
      'This sign-in was saved by an older CLI and has no recorded sign-in service. Run `avair auth login` again.',
      3, { code: 'credential_origin_mismatch' },
    );
  }
  if (credential.authDomain && credential.authDomain !== domain) {
    throw new CliError(
      `The sign-in was issued by ${credential.authDomain}, not ${domain}. Run \`avair auth login\` again.`,
      3, { code: 'credential_origin_mismatch' },
    );
  }
}
