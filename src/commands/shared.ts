import type { Command } from 'commander';

import { CredentialStore } from '../lib/auth/store.js';
import { loadSettings, type GlobalOptions } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { saveDownload } from '../lib/files.js';
import { AvairClient } from '../lib/http.js';
import { printValue } from '../lib/output.js';
import { unwrapUntrusted, wrapUntrusted } from '../lib/untrusted.js';

export function globals(command: Command): GlobalOptions {
  const options = command.optsWithGlobals() as Record<string, unknown>;
  return {
    json: Boolean(options.json),
    input: options.input !== false && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    yes: Boolean(options.yes),
    dryRun: Boolean(options.dryRun),
    environment: (options.env || loadSettings().env || 'prod') as GlobalOptions['environment'],
    apiUrl: typeof options.apiUrl === 'string' ? options.apiUrl : undefined,
    debug: Boolean(options.debug),
  };
}

export function client(command: Command): AvairClient {
  return new AvairClient(globals(command), new CredentialStore());
}

export function emit(command: Command, value: unknown): void {
  const json = globals(command).json;
  // A dry run echoes the caller's own request; nothing in it is outside text.
  const dryRun = Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).dry_run === true);
  printValue(json && !dryRun ? wrapUntrusted(value) : value, json);
}

/**
 * Print what a --wait ended on, then exit 1 when the job failed (F14): a
 * script that chains the next step on the exit code must not go on. `status`
 * picks the field that holds the job's own result.
 */
export function emitWaited(
  command: Command, value: unknown, check: string,
  status: (value: Record<string, any>) => unknown = value => value.status,
): void {
  emit(command, value);
  const final = value && typeof value === 'object' ? status(value as Record<string, any>) : undefined;
  if (typeof final === 'string' && endedFailed(final)) {
    throw new CliError(`The job ended ${final}. Check with: ${check}`, 1, { code: 'job_failed', hint: check });
  }
}

/** A failed status, or a build that ended short of its stop (`buildOutcome`). */
export const endedFailed = (final: string): boolean =>
  /(^|_)FAILED(_|$)/i.test(final) || /^BUILD_(STOPPED|EXPIRED|REVOKED)$/.test(final);

/** A campaign wait: the agent build's state first, then the campaign status. */
export const campaignOutcome = (value: Record<string, any>): unknown =>
  value.agent_build?.state === 'failed' ? 'FAILED' : value.status;

/**
 * A build wait (F32): a build that stopped at a blocker, expired or lost its
 * authority did not reach its stop, as one that failed did not.
 */
export const buildOutcome = (value: Record<string, any>): unknown => {
  const state = value.agent_build?.state;
  return ['failed', 'stopped', 'expired', 'revoked'].includes(state) ? `BUILD_${String(state).toUpperCase()}` : value.status;
};

export function parseJson(value: string | undefined, fallback: unknown = {}): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { throw new Error('Expected valid JSON.'); }
}

/** Missing input is caught here, before any request (exit 2, N2). */
export function requireValue<T>(value: T | undefined | null | '', message: string): T {
  if (value === undefined || value === null || value === '') throw new CliError(message, 2, { code: 'missing_input' });
  return value as T;
}

export function csv(value?: string): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
}

export function toInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new CliError(`${flag} must be a whole number.`, 2, { code: 'invalid_input' });
  return number;
}

/**
 * A page size within the route's cap (F35): above it is sent as the cap, as
 * campaigns activity does (F16); below 1 is refused.
 */
export function pageSize(value: string | undefined, flag: string, max: number, fallback: number): number {
  const size = toInt(value, flag) ?? fallback;
  if (size < 1) throw new CliError(`${flag} must be at least 1.`, 2, { code: 'invalid_input' });
  return Math.min(size, max);
}

export async function readJsonFile(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { throw new CliError(`Cannot read file ${path}.`, 2); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CliError(`${path} is not valid JSON.`, 2); }
  // Saved --json output carries model text under `untrusted`; send it back flat.
  return unwrapUntrusted(value);
}

/**
 * Client-side `--yes` for PRD actions the server does not gate itself. A TTY
 * prompts once; --no-input without --yes exits 4 (N3).
 */
export async function requireConfirmation(command: Command, summary: string): Promise<void> {
  const g = globals(command);
  if (g.yes || g.dryRun) return;
  const { confirmAction } = await import('../lib/confirm.js');
  if (g.input && await confirmAction(`${summary} Continue?`)) return;
  throw new CliError(`${summary} Re-run with --yes to confirm.`, 4, { code: 'confirmation_required' });
}

/** A download: written to --output, or refused if none was given. */
export async function download(command: Command, path: string, output: string | undefined, query?: Record<string, string | undefined>): Promise<void> {
  const file = requireValue(output, 'Name the file to write with --output.');
  const bytes = await client(command).request(path, { raw: true, query });
  if (!Buffer.isBuffer(bytes)) { emit(command, bytes); return; } // dry run
  emit(command, await saveDownload(file, bytes));
}
