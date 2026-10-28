import { CliError, type OwnerChoice } from './errors.js';

export type BulkResult = {
  id: string; ok: boolean; result?: unknown;
  /** `choices`: who may own a row that needs its owner chosen (AVI-1197). */
  error?: { code?: string; message: string; choices?: OwnerChoice[] };
};

export type BulkRun = {
  /** The items done and the per-item refusals; never the stopping item. */
  results: BulkResult[];
  /**
   * The refusal that ended the run early, and the item it came on. That item
   * is not also in `results`, so the refusal is reported once (AVI-1125).
   */
  stopped?: { at: string; error: CliError };
};

/**
 * Refusals about one item only; the run goes on to the next item. Every other
 * refusal stops the run (AVI-1125): launches off for the company, a trial,
 * agent access off, a token problem, the playbook's authority or quota, the
 * company's builds-at-once cap — or a code this CLI does not know yet, which
 * is more likely a gate than an item problem. Sending the same request for
 * every remaining item would only repeat the refusal, and 200 of them in a
 * minute locked the agent out (limit 120 a minute).
 */
export const PER_ITEM_REFUSALS = new Set([
  'PLAYBOOK_STORY_REQUIRED',
  'PLAYBOOK_OWNER_MISSING',
  'PLAYBOOK_BUILD_PACE_REACHED',
  'PLAYBOOK_ALREADY_STARTED',
  // The row needs its owner chosen (`items build --owner`); other rows build.
  'owner_choice_required',
  'assignee_unavailable',
  'item_not_found',
]);

/** The longest `Retry-After` the run waits out; a longer limit stops it. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

type BulkOptions = {
  /**
   * The least time between two requests. A run of per-item refusals still
   * sends one request per item; at one a second it can never take the
   * agent's whole minute limit (120), so the user's next command works.
   */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told before a rate-limit wait, so a pause is not silent. */
  onWait?: (seconds: number) => void;
};

/**
 * Run one action per id, in order, and report every outcome. A per-item
 * refusal is recorded and the run goes on; any other refusal ends it. A
 * minute rate limit is waited out once (Retry-After, at most 60 s) and the
 * same item tried again.
 */
export async function runBulk(
  ids: string[],
  action: (id: string) => Promise<unknown>,
  options: BulkOptions = {},
): Promise<BulkRun> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const results: BulkResult[] = [];
  let lastStart: number | undefined;
  for (const id of ids) {
    let waited = false;
    for (;;) {
      if (options.minIntervalMs && lastStart !== undefined) {
        const gap = options.minIntervalMs - (now() - lastStart);
        if (gap > 0) await sleep(gap);
      }
      lastStart = now();
      try {
        results.push({ id, ok: true, result: await action(id) });
        break;
      } catch (error) {
        const cli = error instanceof CliError ? error : new CliError((error as Error).message, 1);
        const code = cli.details?.code;
        const wait = cli.details?.retry_after;
        if (code === 'rate_limited' && !waited && wait !== undefined && wait <= MAX_RATE_LIMIT_WAIT_SECONDS) {
          waited = true;
          options.onWait?.(wait);
          await sleep(wait * 1000);
          continue;
        }
        if (!code || !PER_ITEM_REFUSALS.has(code)) return { results, stopped: { at: id, error: cli } };
        const choices = cli.details?.choices;
        results.push({ id, ok: false, error: { code, message: cli.message, ...(choices ? { choices } : {}) } });
        break;
      }
    }
  }
  return { results };
}

/** Items never sent: all but those in `results` and the one the run stopped on. */
export function notTried(run: BulkRun, total: number): number {
  return total - run.results.length - (run.stopped ? 1 : 0);
}

/**
 * The command's error after the report: the stopping refusal itself (its
 * message once, its exit code and hint), or a partial failure when only
 * per-item refusals happened.
 */
export function bulkFailure(run: BulkRun, total: number): CliError | null {
  if (run.stopped) {
    const { error } = run.stopped;
    const done = run.results.filter(item => item.ok).length;
    return new CliError(
      `${error.message} (stopped at ${run.stopped.at}: ${done} of ${total} done, ${notTried(run, total)} not tried)`,
      error.exitCode,
      error.details,
      error.status,
    );
  }
  const failed = run.results.filter(item => !item.ok);
  if (!failed.length) return null;
  return new CliError(
    `${failed.length} of ${run.results.length} failed: ${failed.map(item => item.id).join(', ')}`,
    6,
    { code: 'partial_failure' },
  );
}
