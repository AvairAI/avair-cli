import { Command } from 'commander';

import { ENVIRONMENTS, loadSettings, saveSettings, settingsPath, type EnvironmentName, type Settings } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { client, emit, globals, readJsonFile } from './shared.js';

/** The settings `config get/set` understands: the default environment and per-environment API addresses. */
export function settingKeys(): string[] {
  return ['env', ...ENVIRONMENTS.map(name => `api-url.${name}`)];
}

export function applySetting(settings: Settings, key: string, value: string | undefined): Settings {
  const next: Settings = { ...settings, api_urls: { ...(settings.api_urls ?? {}) } };
  if (key === 'env') {
    if (value !== undefined && !ENVIRONMENTS.includes(value as EnvironmentName)) throw new CliError(`Unknown environment: ${value}.`, 2);
    next.env = value as EnvironmentName | undefined;
  } else if (key.startsWith('api-url.') && ENVIRONMENTS.includes(key.slice(8) as EnvironmentName)) {
    const name = key.slice(8) as EnvironmentName;
    if (value !== undefined && !/^https?:\/\//.test(value)) throw new CliError('An API address starts with http:// or https://.', 2);
    if (value === undefined) delete next.api_urls![name];
    else next.api_urls![name] = value.replace(/\/$/, '');
  } else {
    throw new CliError(`Unknown setting ${key}. Use one of: ${settingKeys().join(', ')}.`, 2);
  }
  return next;
}

export function readSetting(settings: Settings, key: string): string | null {
  if (key === 'env') return settings.env ?? null;
  if (key.startsWith('api-url.')) return settings.api_urls?.[key.slice(8) as EnvironmentName] ?? null;
  throw new CliError(`Unknown setting ${key}. Use one of: ${settingKeys().join(', ')}.`, 2);
}

export function registerAccount(program: Command): void {
  program.command('account').description('Your account').command('usage')
    .description('Campaign quota, Tools credits and contact limits, each as its own control')
    .action(async function (this: Command) {
      const api = client(this);
      emit(this, { plan: await api.request('/tenants/me/plan'), tools_credits: await api.request('/tools/credits') });
    });

  const profile = program.command('profile').description('Your user profile');
  profile.command('show').description('Show your user profile').action(async function (this: Command) { emit(this, await client(this).request('/users/me')); });
  profile.command('edit').description('Agents may change name, title and sign-off settings; email, phone and role are refused')
    .option('--first-name <name>', 'your first name').option('--last-name <name>', 'your last name').option('--job-title <title>', 'your job title')
    .option('--booking-link <url>', 'your meeting booking link').option('--signature-mode <mode>', 'AUTO or CUSTOM')
    .option('--signature <text>', 'your own email sign-off text, used when the mode is CUSTOM')
    .action(async function (this: Command, o) {
      const body = Object.fromEntries(Object.entries({
        first_name: o.firstName, last_name: o.lastName, job_title: o.jobTitle, booking_link: o.bookingLink,
        email_signature_mode: o.signatureMode, email_signature_text: o.signature,
      }).filter(([, value]) => value !== undefined));
      if (!Object.keys(body).length) throw new CliError('Give at least one field to change.', 2);
      emit(this, await client(this).request('/users/me', { method: 'PUT', body }));
    });
  const style = profile.command('content-style').description('Your content style and examples');
  style.command('show').description('Show your content style and examples').action(async function (this: Command) { emit(this, await client(this).request('/users/me/content-examples')); });
  style.command('set').description('Replace your content style and examples from a JSON file').requiredOption('--input <file>', 'JSON with selected_style, examples, default_instructions, preferred_language')
    .action(async function (this: Command, o) {
      emit(this, await client(this).request('/users/me/content-examples', { method: 'PUT', body: await readJsonFile(o.input) }));
    });

  // Hidden (AVI-1157): it only chooses an environment or an API address, which
  // is our own team's setup. It still works when typed.
  const config = program.command('config', { hidden: true }).description('Saved CLI settings (no secrets)');
  config.command('list').description('Show the saved settings and where they are stored').action(function (this: Command) {
    const g = globals(this);
    emit(this, {
      environment: g.environment, settings: loadSettings(), file: settingsPath(),
      token_source: process.env.AVAIR_TOKEN ? 'environment' : 'keychain',
      api_url_override: g.apiUrl || process.env.AVAIR_API_URL || null,
    });
  });
  config.command('get <key>').description('Show one saved setting: env or api-url.<name>').action(function (this: Command, key: string) { emit(this, { [key]: readSetting(loadSettings(), key) }); });
  config.command('set <key> [value]').description('Set a value, or clear it by leaving the value out')
    .action(function (this: Command, key: string, value?: string) {
      const next = applySetting(loadSettings(), key, value);
      if (globals(this).dryRun) {
        // AVI-1130: show the value it would save, and save nothing.
        emit(this, { dry_run: true, would_set: { [key]: readSetting(next, key) }, file: settingsPath() });
        return;
      }
      saveSettings(next);
      emit(this, { [key]: readSetting(next, key) });
    });
}
