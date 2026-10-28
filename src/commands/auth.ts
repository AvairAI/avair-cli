import { spawn } from 'node:child_process';
import { Command } from 'commander';

import { beginDeviceFlow, pollDeviceFlow, resolveDeviceConfig, revokeRefreshToken } from '../lib/auth/device.js';
import { CredentialStore, type SecretStore } from '../lib/auth/store.js';
import { apiOrigin, assertAuthDomain, assertCredentialOrigin } from '../lib/auth/binding.js';
import { AvairClient } from '../lib/http.js';
import { CliError } from '../lib/errors.js';
import { apiUrl } from '../lib/config.js';
import { emit, globals } from './shared.js';

async function stdinToken(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('Personal access token: ');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let token = '';
    try {
      for await (const chunk of process.stdin) {
        for (const character of String(chunk)) {
          if (character === '\r' || character === '\n') { process.stderr.write('\n'); return token.trim(); }
          if (character === '\u0003') throw new CliError('Sign-in cancelled.', 2);
          if (character === '\u007f' || character === '\b') token = token.slice(0, -1);
          else token += character;
        }
      }
    } finally {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    }
    return token.trim();
  }
  return readPipedToken(process.stdin);
}

// `fs/promises.readFile` rejects a file descriptor number, so `readFile(0)`
// failed every piped `avair auth login --with-token` (E2E 2026-09-30).
export async function readPipedToken(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Sign in and manage local credentials');
  auth.command('login')
    .description('Sign in with your browser, or with a personal access token')
    .option('--with-token', 'read a personal access token from stdin')
    .action(async function (this: Command, options: { withToken?: boolean }) {
      const g = globals(this);
      if (g.dryRun) {
        // AVI-1130: signing in talks to Auth0 and saves a credential; neither
        // has a dry-run form.
        throw new CliError('Signing in cannot be a dry run: nothing was saved and no browser was opened.', 2, { code: 'dry_run_unsupported' });
      }
      const store = new CredentialStore();
      if (options.withToken) {
        const token = process.env.AVAIR_TOKEN || await stdinToken();
        if (!token.startsWith('avp_')) throw new CliError('Expected an Avair personal access token.', 2);
        const origin = apiOrigin(apiUrl(g.environment, g.apiUrl));
        await store.set(g.environment, { accessToken: token, kind: 'pat', apiOrigin: origin });
      } else {
        if (!g.input) throw new CliError('Device login needs input. Use AVAIR_TOKEN in non-interactive environments.', 2);
        const base = apiUrl(g.environment, g.apiUrl);
        const origin = apiOrigin(base);
        const config = await resolveDeviceConfig(base);
        const device = await beginDeviceFlow(config);
        process.stderr.write(`Open ${device.verification_uri} and enter ${device.user_code}\n`);
        if (device.verification_uri_complete) openBrowser(device.verification_uri_complete);
        // Saved with where it may be sent: this API and this Auth0 domain (A4).
        await store.set(g.environment, { ...await pollDeviceFlow(config, device), apiOrigin: origin, authDomain: config.domain });
      }
      const identity = await new AvairClient(g, store).request('/agent-access/whoami');
      emit(this, identity);
    });

  auth.command('status').description('Check that you are signed in and show who you are').action(async function (this: Command) {
    emit(this, await new AvairClient(globals(this), new CredentialStore()).request('/agent-access/whoami'));
  });

  auth.command('logout').description('Sign out on this computer').action(async function (this: Command) {
    const g = globals(this);
    if (g.dryRun) {
      // AVI-1130: say what a real logout would do; remove and cancel nothing.
      const credential = await new CredentialStore().get(g.environment);
      const message = !credential
        ? 'Dry run: you are not signed in on this computer; there is nothing to sign out.'
        : process.env.AVAIR_TOKEN
          ? 'Dry run: AVAIR_TOKEN is set, so a logout would only remove any sign-in saved on this computer. Nothing was changed.'
          : `Dry run: a logout would remove the ${credential.kind === 'pat' ? 'personal access token' : 'sign-in'} saved on this computer${credential.kind === 'oauth' ? ' and cancel its renewal at Auth0' : ''}. Nothing was changed.`;
      emit(this, g.json ? { dry_run: true, signed_in: Boolean(credential), kind: credential?.kind ?? null, message } : message);
      return;
    }
    const store = new CredentialStore();
    const result = await signOutThisComputer(
      store,
      g.environment,
      async (refreshToken) => {
        // The renewal pass goes only to the API and Auth0 domain it belongs to (A4).
        const credential = await store.get(g.environment);
        const base = apiUrl(g.environment, g.apiUrl);
        if (credential) assertCredentialOrigin(credential, g.environment, base);
        const config = await resolveDeviceConfig(base);
        if (credential) assertAuthDomain(credential, config.domain);
        await revokeRefreshToken(config, refreshToken);
      },
    );
    emit(this, g.json ? result : result.message);
    if (!result.local_copy_removed) process.exitCode = 1;
  });

  program.command('whoami').description('Show the current Avair identity and tenant').action(async function (this: Command) {
    emit(this, await new AvairClient(globals(this), new CredentialStore()).request('/agent-access/whoami'));
  });
}

export type LogoutResult = {
  signed_out: boolean;
  kind: 'oauth' | 'pat' | null;
  /** Always true: the CLI's Avair connection is shared by every computer (RV11). */
  this_computer_only: true;
  /** OAuth only: whether Auth0 cancelled this computer's renewal pass. */
  refresh_token_revoked: boolean | null;
  /** False when a saved copy may be left on this computer; logout then exits 1. */
  local_copy_removed: boolean;
  message: string;
};

/** The store's message when a saved copy may be left behind, else null. */
async function removeSaved(store: SecretStore, environment: string): Promise<string | null> {
  try {
    await store.delete(environment);
    return null;
  } catch (error) {
    if (error instanceof CliError && error.details.code === 'credential_delete_incomplete') return error.message;
    throw error;
  }
}

const EVERYWHERE =
  'Account > AI agents > Connected apps keeps showing the Avair CLI as Active: that entry covers every '
  + 'computer where you use the CLI. To end it everywhere, revoke it there.';

/**
 * Sign this computer out (AVI-1120). The local copy is always removed, even
 * when Auth0 cannot cancel the renewal pass, and the result says what was
 * done. The Avair connection is not revoked: one CLI connection serves every
 * computer of the user, so revoking it would sign them all out (RV11).
 */
export async function signOutThisComputer(
  store: SecretStore,
  environment: string,
  revoke: (refreshToken: string) => Promise<void>,
  envTokenSet: boolean = Boolean(process.env.AVAIR_TOKEN),
): Promise<LogoutResult> {
  if (envTokenSet) {
    // The store answers with AVAIR_TOKEN before any saved sign-in, and the CLI
    // cannot unset a variable in the caller's shell. A sign-in saved on this
    // computer is still removed, as before.
    const left = await removeSaved(store, environment);
    return {
      signed_out: false, kind: 'pat', this_computer_only: true, refresh_token_revoked: null, local_copy_removed: !left,
      message: 'AVAIR_TOKEN is set in this environment, so the CLI keeps using it. '
        + (left ?? 'Any sign-in saved on this computer was removed.')
        + ' Unset AVAIR_TOKEN to stop, and revoke the token in Account > AI agents to disable it everywhere.',
    };
  }
  const credential = await store.get(environment);
  if (!credential) {
    // On Windows an unreadable or incomplete saved entry also reads as null;
    // it is removed all the same, as logout always did.
    const left = await removeSaved(store, environment);
    return {
      signed_out: false, kind: null, this_computer_only: true, refresh_token_revoked: null, local_copy_removed: !left,
      message: left ?? 'You were not signed in on this computer.',
    };
  }
  if (credential.kind === 'pat') {
    const left = await removeSaved(store, environment);
    return {
      signed_out: !left, kind: 'pat', this_computer_only: true, refresh_token_revoked: null, local_copy_removed: !left,
      message: left
        ? `Not signed out: ${left} Revoke the token in Account > AI agents to disable it everywhere.`
        : 'Signed out on this computer: the personal access token was removed from it. '
          + 'The token still works anywhere else it is used. Revoke it in Account > AI agents to disable it everywhere.',
    };
  }
  let revoked: boolean | null = null;
  let failure = '';
  if (credential.refreshToken) {
    try {
      await revoke(credential.refreshToken);
      revoked = true;
    } catch (error) {
      revoked = false;
      const code = error instanceof CliError ? error.details.code : undefined;
      failure = code || (error instanceof Error ? error.message : 'unknown error');
    }
  }
  const left = await removeSaved(store, environment);
  if (left) {
    return {
      signed_out: false, kind: 'oauth', this_computer_only: true, refresh_token_revoked: revoked, local_copy_removed: false,
      message: `Not signed out: ${left} ${revoked ? 'Its sign-in was cancelled, so the saved copy cannot renew. ' : ''}${EVERYWHERE}`,
    };
  }
  const first = revoked === false
    ? `Signed out on this computer, but its sign-in could not be cancelled (${failure}). `
      + 'The access already issued ends within an hour.'
    : revoked
      ? 'Signed out on this computer, and its sign-in was cancelled.'
      : 'Signed out on this computer. The access already issued ends within an hour.';
  return {
    signed_out: true, kind: 'oauth', this_computer_only: true, refresh_token_revoked: revoked, local_copy_removed: true,
    message: `${first} ${EVERYWHERE}`,
  };
}
