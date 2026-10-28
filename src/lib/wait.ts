import type { Command } from 'commander';

import { CliError } from './errors.js';

// A job is still working while its status holds one of these words (whole
// words, so a finished PROCESSED does not count). FINALIZING and APPLYING are
// the content preview's windows after GENERATING (F37).
const RUNNING = /(^|_)(PROCESSING|RUNNING|PENDING|QUEUED|IN_PROGRESS|GENERATING|FINALIZING|APPLYING|ANALYZING|SUBMITTING|CANCEL_REQUESTED)(_|$)/i;

export const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * The "nothing started" window for a job whose running status is set by the
 * worker, after the request returns (campaign build steps, playbook analysis):
 * a worker can start a few seconds late.
 */
export const WORKER_QUIET_MS = 10_000;

export function isRunningStatus(status: unknown): boolean {
  return typeof status === 'string' && RUNNING.test(status);
}

export function addWaitOptions(command: Command): Command {
  return command
    .option('--wait', 'wait until the server finishes this step')
    .option('--timeout <seconds>', 'give up waiting after this many seconds', String(DEFAULT_TIMEOUT_SECONDS));
}

export type WaitSettings = {
  timeoutSeconds: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function waitSettings(options: { timeout?: string }): WaitSettings {
  const seconds = Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError('--timeout must be a positive number of seconds.', 2);
  return { timeoutSeconds: seconds };
}

/**
 * "Done" for a job a request only queued: it was seen running and has stopped,
 * or nothing has started for `quietMs` (a step that finished at once). Time,
 * not a poll count: three quiet 5 s polls made every quick step wait 10 s (B2).
 */
export function finishedAfterStart<T>(
  running: (value: T) => boolean,
  quietMs = 3000,
  now: () => number = Date.now,
): (value: T) => boolean {
  let sawRunning = false;
  let quietSince: number | undefined;
  return value => {
    if (running(value)) { sawRunning = true; quietSince = undefined; return false; }
    if (sawRunning) return true;
    quietSince ??= now();
    return now() - quietSince >= quietMs;
  };
}

/**
 * Polls start fast and settle at 3.5 s: a step that ends in a second is seen
 * in a second, and the gap stays under undici's 4 s idle limit, so each poll
 * reuses the open connection instead of a new TLS handshake (B2, P1).
 */
export const POLL_SCHEDULE_MS = [1000, 2000, 3000, 3500];

export function pollInterval(poll: number): number {
  return POLL_SCHEDULE_MS[Math.min(poll, POLL_SCHEDULE_MS.length - 1)];
}

/**
 * Poll `read` until `done`. A timeout stops only this local wait: the job keeps
 * running on the server, so the error names the id and how to check it (N15).
 */
export async function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  settings: WaitSettings,
  what: { id: string; check: string },
): Promise<T> {
  const sleep = settings.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = settings.now ?? Date.now;
  const deadline = now() + settings.timeoutSeconds * 1000;
  for (let poll = 0; ; poll += 1) {
    const value = await read();
    if (done(value)) return value;
    const left = deadline - now();
    if (left <= 0) {
      throw new CliError(
        `Still running on the server: ${what.id}. Check with: ${what.check}`,
        11,
        { code: 'wait_timeout', hint: what.check },
      );
    }
    // Never sleep past the deadline: the last read happens at the timeout,
    // not up to one poll interval after it.
    await sleep(Math.min(settings.intervalMs ?? pollInterval(poll), left));
  }
}
