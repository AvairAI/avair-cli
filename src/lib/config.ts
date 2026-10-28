import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type EnvironmentName = 'prod' | 'qa' | 'local';

const environmentUrls: Partial<Record<EnvironmentName, string>> = {
  // api.avair.ai is the Auth0 audience, not a host; the web host serves the API.
  prod: 'https://www.avair.ai/api/v1',
  local: 'http://localhost:8000/api/v1',
};

export function configDir(platform = process.platform, env = process.env): string {
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'avair');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'avair');
}

/** Non-secret settings saved by `avair config set`. Tokens never go here. */
export type Settings = {
  env?: EnvironmentName;
  api_urls?: Partial<Record<EnvironmentName, string>>;
};

export const ENVIRONMENTS: EnvironmentName[] = ['prod', 'qa', 'local'];

export function settingsPath(platform = process.platform, env = process.env): string {
  return join(configDir(platform, env), 'config.json');
}

export function loadSettings(path = settingsPath()): Settings {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value as Settings : {};
  } catch {
    return {};
  }
}

export function saveSettings(settings: Settings, path = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** The built-in API address of an environment, if it has one. */
export function defaultApiUrl(environment: EnvironmentName): string | undefined {
  return environmentUrls[environment];
}

/** Flags first, then environment variables, then the settings file (design §6.2). */
export function apiUrl(
  environment: EnvironmentName,
  override?: string,
  env = process.env,
  settings: Settings = loadSettings(),
): string {
  const selected = override || env.AVAIR_API_URL || settings.api_urls?.[environment]
    || environmentUrls[environment];
  if (!selected) throw new Error(`No API address is set for the ${environment} environment. Set AVAIR_API_URL or --api-url.`);
  return selected.replace(/\/$/, '');
}

export type GlobalOptions = {
  json?: boolean;
  input?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  environment: EnvironmentName;
  apiUrl?: string;
  debug?: boolean;
};
