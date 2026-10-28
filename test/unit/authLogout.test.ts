import { describe, expect, it } from 'vitest';

import { signOutThisComputer } from '../../src/commands/auth.js';
import { CliError } from '../../src/lib/errors.js';
import type { SecretStore, StoredCredential } from '../../src/lib/auth/store.js';

function memoryStore(credential: StoredCredential | null) {
  const state = { credential, deleted: false };
  const store: SecretStore = {
    get: async () => state.credential,
    set: async (_env, value) => { state.credential = value; },
    delete: async () => { state.credential = null; state.deleted = true; },
  };
  return { store, state };
}

const oauth = (refreshToken?: string): StoredCredential =>
  ({ accessToken: 'at', refreshToken, expiresAt: Date.now() + 60_000, kind: 'oauth' }) as StoredCredential;

describe('avair auth logout (AVI-1120)', () => {
  it('cancels this computer\'s sign-in, removes it, and says the shared entry stays Active', async () => {
    const { store, state } = memoryStore(oauth('rt-1'));
    const revoked: string[] = [];

    const result = await signOutThisComputer(store, 'prod', async (token) => { revoked.push(token); }, false);

    expect(revoked).toEqual(['rt-1']);
    expect(state.deleted).toBe(true);
    expect(result).toMatchObject({
      signed_out: true, kind: 'oauth', this_computer_only: true, refresh_token_revoked: true,
    });
    expect(result.message).toMatch(/^Signed out on this computer, and its sign-in was cancelled\./);
    expect(result.message).toContain('Connected apps keeps showing the Avair CLI as Active');
    expect(result.message).toContain('revoke it there');
  });

  it('still signs this computer out when the sign-in cannot be cancelled', async () => {
    const { store, state } = memoryStore(oauth('rt-1'));

    const result = await signOutThisComputer(store, 'prod', async () => {
      throw new CliError('Auth0 down', 1, { code: 'http_503' });
    }, false);

    expect(state.deleted).toBe(true);
    expect(result.refresh_token_revoked).toBe(false);
    expect(result.message).toContain('could not be cancelled (http_503)');
    expect(result.message).toContain('ends within an hour');
    expect(result.message).not.toContain('rt-1');
  });

  it('says plainly when there is nothing to cancel or nothing signed in', async () => {
    const noRefresh = memoryStore(oauth(undefined));
    const withoutPass = await signOutThisComputer(noRefresh.store, 'prod', async () => { throw new Error('not called'); }, false);
    expect(withoutPass).toMatchObject({ signed_out: true, refresh_token_revoked: null });
    expect(noRefresh.state.deleted).toBe(true);

    const nobody = memoryStore(null);
    const none = await signOutThisComputer(nobody.store, 'prod', async () => {}, false);
    expect(none).toMatchObject({ signed_out: false, kind: null });
    expect(none.message).toBe('You were not signed in on this computer.');
    // An unreadable Windows entry also reads as nothing: it is still removed.
    expect(nobody.state.deleted).toBe(true);
  });

  it('removes a saved personal token and says it still works elsewhere', async () => {
    const { store, state } = memoryStore({ accessToken: 'avp_x', kind: 'pat' } as StoredCredential);

    const result = await signOutThisComputer(store, 'prod', async () => { throw new Error('not called'); }, false);

    expect(state.deleted).toBe(true);
    expect(result).toMatchObject({ signed_out: true, kind: 'pat', refresh_token_revoked: null });
    expect(result.message).toContain('Revoke it in Account > AI agents');
  });

  it('cannot sign out a token given through AVAIR_TOKEN, says to unset it, and still removes a saved sign-in', async () => {
    const { store, state } = memoryStore(oauth('rt-1'));

    const result = await signOutThisComputer(store, 'prod', async () => { throw new Error('not called'); }, true);

    expect(result.signed_out).toBe(false);
    expect(result.message).toContain('Unset AVAIR_TOKEN');
    expect(state.deleted).toBe(true);
  });

  it('does not claim a sign-out when a saved copy may be left on this computer (F9)', async () => {
    const left = (credential: StoredCredential) => {
      const store: SecretStore = {
        get: async () => credential,
        set: async () => undefined,
        delete: async () => { throw new CliError('The saved sign-in could not be fully removed from this computer.', 1, { code: 'credential_delete_incomplete' }); },
      };
      return store;
    };

    const pat = await signOutThisComputer(left({ accessToken: 'avp_x', kind: 'pat' }), 'prod', async () => {}, false);
    expect(pat).toMatchObject({ signed_out: false, kind: 'pat', local_copy_removed: false });
    expect(pat.message).toMatch(/^Not signed out: The saved sign-in could not be fully removed/);

    const revoked: string[] = [];
    const signIn = await signOutThisComputer(left(oauth('rt-1')), 'prod', async token => { revoked.push(token); }, false);
    expect(revoked).toEqual(['rt-1']);
    expect(signIn).toMatchObject({ signed_out: false, kind: 'oauth', refresh_token_revoked: true, local_copy_removed: false });
    expect(signIn.message).toContain('cannot renew');
  });

  it('a complete sign-out says the local copy is gone (F9)', async () => {
    const { store } = memoryStore({ accessToken: 'avp_x', kind: 'pat' });
    expect(await signOutThisComputer(store, 'prod', async () => {}, false)).toMatchObject({ signed_out: true, local_copy_removed: true });
  });
});
