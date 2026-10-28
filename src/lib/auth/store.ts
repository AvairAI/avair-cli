import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { CliError } from '../errors.js';
import { configDir } from '../config.js';

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  kind: 'oauth' | 'pat';
  /** The API origin this sign-in may be sent to (A4). Missing on 0.1.0 sign-ins. */
  apiOrigin?: string;
  /** The Auth0 domain that issued an OAuth sign-in (A4). */
  authDomain?: string;
  /** Read from AVAIR_TOKEN, never saved. */
  fromEnv?: boolean;
};

export interface SecretStore {
  get(environment: string): Promise<StoredCredential | null>;
  set(environment: string, value: StoredCredential): Promise<void>;
  delete(environment: string): Promise<void>;
}

type KeyringEntry = {
  getPassword(): Promise<string | null> | string | null;
  setPassword(value: string): Promise<void> | void;
  deletePassword(): Promise<boolean> | boolean;
};

type ChunkManifest = { version: 1; id: string; chunks: number };

// Credential Manager's generic-password payload limit is 2,560 bytes. The
// Windows backend stores JavaScript strings as UTF-16, so stay below 1,280
// characters and leave room for backend metadata.
const WINDOWS_CHUNK_SIZE = 1000;

function isChunkManifest(value: unknown): value is ChunkManifest {
  const item = value as ChunkManifest;
  return item?.version === 1 && typeof item.id === 'string'
    && Number.isInteger(item.chunks) && item.chunks > 0;
}

async function entry(environment: string): Promise<KeyringEntry> {
  const keyring = await import('@napi-rs/keyring');
  return new keyring.Entry('avair-cli', environment);
}

const credentialPath = () => join(configDir(), 'credentials.json');

export class CredentialStore implements SecretStore {
  constructor(
    private readonly platform = process.platform,
    private readonly makeEntry = entry,
    private readonly file = credentialPath(),
  ) {}

  /** The fallback file's entries, or null when there is no file or it holds no JSON object. */
  private async fallbackValues(): Promise<Record<string, StoredCredential> | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const values = JSON.parse(text) as unknown;
      return values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, StoredCredential> : null;
    } catch {
      return null;
    }
  }

  private async fromFallback(environment: string): Promise<StoredCredential | null> {
    // A damaged file reads as "not signed in", as writeFallback treats it.
    const values = await this.fallbackValues();
    if (!values?.[environment]) return null;
    // Other users may read a file that is not private: do not trust its token.
    if ((await stat(this.file)).mode & 0o077) {
      process.stderr.write(`Warning: ignoring ${this.file} because other users can read it. Run \`avair auth logout\` and sign in again.\n`);
      return null;
    }
    return values[environment];
  }

  /**
   * Remove this environment's fallback entry, whatever the file's mode. A file
   * left with no entry, or with no JSON object, is deleted.
   */
  private async removeFallback(environment: string): Promise<void> {
    let exists = true;
    try { await stat(this.file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) return;
    const values = await this.fallbackValues();
    if (values && !(environment in values)) return;
    if (!values || Object.keys(values).every(key => key === environment)) {
      await unlink(this.file);
      return;
    }
    await chmod(this.file, 0o600);
    await this.writeFallback(environment, null);
  }

  async get(environment: string): Promise<StoredCredential | null> {
    if (process.env.AVAIR_TOKEN) return { accessToken: process.env.AVAIR_TOKEN, kind: 'pat', fromEnv: true };
    try {
      const value = await (await this.makeEntry(environment)).getPassword();
      if (!value) return this.platform === 'win32' ? null : this.fromFallback(environment);
      const parsed = JSON.parse(value) as StoredCredential | ChunkManifest;
      if (!isChunkManifest(parsed)) return parsed;
      const chunks = await Promise.all(
        Array.from({ length: parsed.chunks }, (_, index) =>
          this.makeEntry(`${environment}:${parsed.id}:${index}`).then(item => item.getPassword())),
      );
      if (chunks.some(chunk => chunk === null)) {
        throw new CliError('Stored Windows credential is incomplete. Run `avair auth login` again.', 3);
      }
      return JSON.parse(chunks.join('')) as StoredCredential;
    } catch (error) {
      // An incomplete Windows entry says so; it is not "Not signed in" (S12).
      if (error instanceof CliError) throw error;
      if (this.platform === 'win32') return null;
      return this.fromFallback(environment);
    }
  }

  private async writeFallback(environment: string, value: StoredCredential | null): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let values: Record<string, StoredCredential> = {};
    try { values = JSON.parse(await readFile(this.file, 'utf8')); } catch { /* new file */ }
    if (value) values[environment] = value;
    else delete values[environment];
    let created = false;
    let handle;
    try {
      handle = await open(this.file, 'wx+', 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const mode = (await stat(this.file)).mode & 0o077;
      if (mode !== 0) throw new CliError('Credential file is not private; refusing to store a token.', 1);
      handle = await open(this.file, 'r+');
    }
    try {
      const mode = (await handle.stat()).mode & 0o077;
      if (mode !== 0) throw new CliError('Credential file is not private; refusing to store a token.', 1);
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify(values, null, 2));
    } catch (error) {
      await handle.close();
      if (created) await unlink(this.file).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  async set(environment: string, value: StoredCredential): Promise<void> {
    if (this.platform === 'win32') {
      const serialized = JSON.stringify(value);
      const id = randomUUID();
      const chunks = Array.from(
        { length: Math.ceil(serialized.length / WINDOWS_CHUNK_SIZE) },
        (_, index) => serialized.slice(index * WINDOWS_CHUNK_SIZE, (index + 1) * WINDOWS_CHUNK_SIZE),
      );
      let oldManifest: ChunkManifest | null = null;
      try {
        const oldValue = await (await this.makeEntry(environment)).getPassword();
        if (oldValue) {
          const oldParsed = JSON.parse(oldValue) as unknown;
          if (isChunkManifest(oldParsed)) oldManifest = oldParsed;
        }
        await Promise.all(chunks.map((chunk, index) =>
          this.makeEntry(`${environment}:${id}:${index}`).then(item => item.setPassword(chunk))));
        await (await this.makeEntry(environment)).setPassword(JSON.stringify({ version: 1, id, chunks: chunks.length }));
        if (oldManifest) {
          await Promise.all(Array.from({ length: oldManifest.chunks }, (_, index) =>
            this.makeEntry(`${environment}:${oldManifest.id}:${index}`).then(item => item.deletePassword()).catch(() => false)));
        }
        return;
      } catch {
        await Promise.all(chunks.map((_, index) =>
          this.makeEntry(`${environment}:${id}:${index}`).then(item => item.deletePassword()).catch(() => false)));
        throw new CliError('Windows Credential Manager is unavailable. Set AVAIR_TOKEN for CI; plaintext storage is disabled.', 1);
      }
    }
    try {
      await (await this.makeEntry(environment)).setPassword(JSON.stringify(value));
    } catch {
      process.stderr.write('Warning: system keychain unavailable; using a mode-0600 credential file.\n');
      await this.writeFallback(environment, value);
      return;
    }
    // An older copy from a keychain outage must not come back as this
    // sign-in if the keychain entry is later lost.
    await this.removeFallback(environment).catch(() => undefined);
  }

  /**
   * Remove the saved sign-in. Throws `credential_delete_incomplete` when a copy
   * may be left on this computer, so logout does not report success.
   */
  async delete(environment: string): Promise<void> {
    let incomplete = false;
    let value: string | null = null;
    try {
      const item = await this.makeEntry(environment);
      value = await item.getPassword();
      if (value) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(value); } catch { /* not a manifest; the entry is deleted below */ }
        if (isChunkManifest(parsed)) {
          const removed = await Promise.all(Array.from({ length: parsed.chunks }, (_, index) =>
            this.makeEntry(`${environment}:${parsed.id}:${index}`).then(chunk => chunk.deletePassword()).then(() => true, () => false)));
          if (removed.includes(false)) incomplete = true;
        }
      }
      await item.deletePassword();
    } catch {
      // A keychain that cannot be read on macOS or Linux holds nothing the
      // CLI saved (it used the file). One that held a value, or Windows with
      // no file, may still hold the token.
      if (value || this.platform === 'win32') incomplete = true;
    }
    // A previous keychain outage may have left a second copy on disk. Logout
    // must remove it even when deleting the current keychain entry succeeds.
    if (this.platform !== 'win32') {
      try { await this.removeFallback(environment); } catch { incomplete = true; }
    }
    if (incomplete) {
      throw new CliError(
        `The saved sign-in could not be fully removed from this computer. Remove "avair-cli/${environment}" from the system keychain${this.platform === 'win32' ? '' : ` and check ${this.file}`}.`,
        1, { code: 'credential_delete_incomplete' },
      );
    }
  }
}
