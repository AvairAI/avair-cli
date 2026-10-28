import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CredentialStore } from '../../src/lib/auth/store.js';

const unavailable = async () => { throw new Error('no keychain'); };

describe('credential storage', () => {
  it.skipIf(process.platform === 'win32')('uses a verified 0600 fallback on POSIX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore('linux', unavailable, file);
    await store.set('qa', { accessToken: 'secret', kind: 'pat' });
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(file, 'utf8')).qa.accessToken).toBe('secret');
  });

  it.skipIf(process.platform === 'win32')('refuses an unsafe existing fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
    const file = join(dir, 'credentials.json');
    await writeFile(file, '{}', { mode: 0o644 });
    const store = new CredentialStore('linux', unavailable, file);
    await expect(store.set('qa', { accessToken: 'secret', kind: 'pat' })).rejects.toThrow('not private');
    expect(await readFile(file, 'utf8')).toBe('{}');
  });

  it('never writes plaintext when Windows keyring access fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore('win32', unavailable, file);
    await expect(store.set('qa', { accessToken: 'secret', kind: 'pat' })).rejects.toThrow('plaintext storage is disabled');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('reads a fallback sign-in when the keychain recovers but has no entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
    const file = join(dir, 'credentials.json');
    const credential = { accessToken: 'saved-pat', kind: 'pat' as const };
    await new CredentialStore('linux', unavailable, file).set('qa', credential);
    const emptyKeyring = async () => ({
      getPassword: async () => null,
      setPassword: async () => {},
      deletePassword: async () => false,
    });

    expect(await new CredentialStore('linux', emptyKeyring, file).get('qa')).toEqual(credential);
  });

  it.skipIf(process.platform === 'win32')('logout removes both stored copies without removing another environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
    const file = join(dir, 'credentials.json');
    const fallback = new CredentialStore('linux', unavailable, file);
    await fallback.set('qa', { accessToken: 'old-pat', kind: 'pat' });
    await fallback.set('local', { accessToken: 'other-pat', kind: 'pat' });
    let keyringValue: string | null = JSON.stringify({ accessToken: 'new-pat', kind: 'pat' });
    const keyring = async () => ({
      getPassword: async () => keyringValue,
      setPassword: async (value: string) => { keyringValue = value; },
      deletePassword: async () => { keyringValue = null; return true; },
    });

    await new CredentialStore('linux', keyring, file).delete('qa');

    expect(keyringValue).toBeNull();
    expect(await fallback.get('qa')).toBeNull();
    expect(await fallback.get('local')).toEqual({ accessToken: 'other-pat', kind: 'pat' });
  });

  it('chunks large OAuth credentials in Windows Credential Manager', async () => {
    const values = new Map<string, string>();
    const makeEntry = async (key: string) => ({
      getPassword: async () => values.get(key) || null,
      setPassword: async (value: string) => { values.set(key, value); },
      deletePassword: async () => values.delete(key),
    });
    const store = new CredentialStore('win32', makeEntry);
    const credential = {
      accessToken: 'a'.repeat(5000),
      refreshToken: 'r'.repeat(3000),
      expiresAt: 123,
      kind: 'oauth' as const,
    };

    await store.set('qa', credential);

    expect(await store.get('qa')).toEqual(credential);
    expect(values.size).toBeGreaterThan(2);
    expect([...values.values()].every(value => value.length * 2 <= 2000)).toBe(true);
  });

  describe('the fallback file next to a working keychain (F11-F13)', () => {
    const posix = it.skipIf(process.platform === 'win32');
    const keychain = () => {
      const state = { value: null as string | null, failDelete: false };
      const makeEntry = async () => ({
        getPassword: async () => state.value,
        setPassword: async (value: string) => { state.value = value; },
        deletePassword: async () => {
          if (state.failDelete) throw new Error('keychain locked');
          state.value = null;
          return true;
        },
      });
      return { state, makeEntry };
    };

    posix('a keychain sign-in removes the old file copy, so a lost keychain entry never brings back another account (F11)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const file = join(dir, 'credentials.json');
      await new CredentialStore('linux', unavailable, file).set('qa', { accessToken: 'old-account', kind: 'pat' });
      await new CredentialStore('linux', unavailable, file).set('local', { accessToken: 'other-env', kind: 'pat' });
      const { state, makeEntry } = keychain();
      const store = new CredentialStore('linux', makeEntry, file);

      await store.set('qa', { accessToken: 'new-account', kind: 'pat' });
      state.value = null; // the keychain entry is lost

      expect(await store.get('qa')).toBeNull();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ local: { accessToken: 'other-env', kind: 'pat' } });
    });

    posix('the file copy is removed when it is the last entry (F11)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const file = join(dir, 'credentials.json');
      await new CredentialStore('linux', unavailable, file).set('qa', { accessToken: 'old-account', kind: 'pat' });
      await new CredentialStore('linux', keychain().makeEntry, file).set('qa', { accessToken: 'new-account', kind: 'pat' });
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    posix('a damaged file reads as not signed in, and logout still works (F12)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const file = join(dir, 'credentials.json');
      await writeFile(file, '', { mode: 0o600 });
      const store = new CredentialStore('linux', keychain().makeEntry, file);

      expect(await store.get('qa')).toBeNull();
      await expect(store.delete('qa')).resolves.toBeUndefined();
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    posix('a file other users can read is not trusted, and logout still removes its token (F13)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const file = join(dir, 'credentials.json');
      await writeFile(file, JSON.stringify({ qa: { accessToken: 'loose', kind: 'pat' }, local: { accessToken: 'other', kind: 'pat' } }), { mode: 0o644 });
      const warnings: string[] = [];
      const write = process.stderr.write;
      process.stderr.write = ((chunk: string) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
      const store = new CredentialStore('linux', keychain().makeEntry, file);
      try {
        expect(await store.get('qa')).toBeNull();
      } finally {
        process.stderr.write = write;
      }
      expect(warnings.join('')).toContain('other users can read it');

      await store.delete('qa');
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ local: { accessToken: 'other', kind: 'pat' } });
    });

    posix('a keychain that keeps the token makes logout report it (F9)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const { state, makeEntry } = keychain();
      state.value = JSON.stringify({ accessToken: 'kept', kind: 'pat' });
      state.failDelete = true;
      await expect(new CredentialStore('linux', makeEntry, join(dir, 'credentials.json')).delete('qa'))
        .rejects.toMatchObject({ exitCode: 1, details: { code: 'credential_delete_incomplete' } });
    });

    posix('no keychain at all is a complete logout when the file copy is gone (F9)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'avair-cli-'));
      const file = join(dir, 'credentials.json');
      await new CredentialStore('linux', unavailable, file).set('qa', { accessToken: 'file-only', kind: 'pat' });
      await expect(new CredentialStore('linux', unavailable, file).delete('qa')).resolves.toBeUndefined();
      expect(await new CredentialStore('linux', unavailable, file).get('qa')).toBeNull();
    });
  });

  it('a Windows chunk that cannot be deleted makes logout report it (F9)', async () => {
    const values = new Map<string, string>([['qa', JSON.stringify({ version: 1, id: 'abc', chunks: 1 })], ['qa:abc:0', '{"accessToken":"x","kind":"pat"}']]);
    const makeEntry = async (key: string) => ({
      getPassword: async () => values.get(key) ?? null,
      setPassword: async (value: string) => { values.set(key, value); },
      deletePassword: async () => { if (key.includes(':')) throw new Error('locked'); return values.delete(key); },
    });
    await expect(new CredentialStore('win32', makeEntry, 'unused').delete('qa'))
      .rejects.toMatchObject({ details: { code: 'credential_delete_incomplete' } });
  });
});
