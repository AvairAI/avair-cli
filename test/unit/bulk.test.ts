/**
 * AVI-1125: build-all sent a build for every one of 200 items after the
 * company had refused them all, printed 200 identical refusals and once
 * pushed the agent over its 120-a-minute limit.
 */
import { describe, expect, it, vi } from 'vitest';

import { bulkFailure, runBulk } from '../../src/lib/bulk.js';
import { apiError, CliError } from '../../src/lib/errors.js';

const refusal = (code: string, status = 409, extra: Record<string, unknown> = {}) =>
  new CliError(`${code} message`, status === 403 ? 4 : 6, { code, ...extra }, status);

describe('runBulk', () => {
  it('stops at the first refusal that is not about one item, and tries nothing after it', async () => {
    const action = vi.fn(async () => { throw refusal('live_off_for_company', 403); });
    const run = await runBulk(['a', 'b', 'c'], action);
    expect(action).toHaveBeenCalledTimes(1);
    // The stopping item is reported in `stopped` only, not again in `results`.
    expect(run.results).toEqual([]);
    expect(run.stopped?.at).toBe('a');
  });

  it('stops when the monthly creates run out: every later item would get the same refusal', async () => {
    const action = vi.fn(async (id: string) => {
      if (id === 'a') return { id: 'a' };
      throw refusal('PLAYBOOK_QUOTA_EXHAUSTED');
    });
    const run = await runBulk(['a', 'b', 'c', 'd'], action);
    expect(action).toHaveBeenCalledTimes(2);
    expect(run.stopped).toMatchObject({ at: 'b' });
    expect(run.results.map(item => item.id)).toEqual(['a']);
  });

  it('goes on past a row that needs its owner chosen', async () => {
    const action = vi.fn(async (id: string) => {
      if (id === 'b') throw refusal('owner_choice_required', 409, { choices: [{ user_id: 'u7', name: 'Pat', assigned: true }] });
      if (id === 'c') throw refusal('assignee_unavailable');
      return { id };
    });
    const run = await runBulk(['a', 'b', 'c', 'd'], action);
    expect(action).toHaveBeenCalledTimes(4);
    expect(run.stopped).toBeUndefined();
    expect(run.results.filter(item => item.ok).map(item => item.id)).toEqual(['a', 'd']);
    // The row's result says who to pick (AVI-1197); a refusal without a list adds none.
    expect(run.results[1].error).toEqual({ code: 'owner_choice_required', message: 'owner_choice_required message', choices: [{ user_id: 'u7', name: 'Pat', assigned: true }] });
    expect(run.results[2].error).toEqual({ code: 'assignee_unavailable', message: 'assignee_unavailable message' });
  });

  it('goes on past a refusal about one item only', async () => {
    const action = vi.fn(async (id: string) => {
      if (id === 'b') throw refusal('PLAYBOOK_STORY_REQUIRED');
      return { id };
    });
    const run = await runBulk(['a', 'b', 'c'], action);
    expect(action).toHaveBeenCalledTimes(3);
    expect(run.stopped).toBeUndefined();
    expect(run.results.map(item => item.ok)).toEqual([true, false, true]);
  });

  it('stops on a code it does not know', async () => {
    const action = vi.fn(async () => { throw refusal('some_new_gate'); });
    expect((await runBulk(['a', 'b'], action)).stopped?.at).toBe('a');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('waits out a minute rate limit once and tries the same item again', async () => {
    const sleep = vi.fn(async () => {});
    const onWait = vi.fn();
    let calls = 0;
    const action = vi.fn(async (id: string) => {
      calls += 1;
      if (calls === 1) throw refusal('rate_limited', 429, { retry_after: 7 });
      return { id };
    });
    const run = await runBulk(['a', 'b'], action, { sleep, onWait });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
    expect(onWait).toHaveBeenCalledWith(7);
    expect(action.mock.calls.map(([id]) => id)).toEqual(['a', 'a', 'b']);
    expect(run.stopped).toBeUndefined();
  });

  it('stops when the limit refuses again, or asks for longer than a minute', async () => {
    const sleep = vi.fn(async () => {});
    const again = await runBulk(['a', 'b'], async () => { throw refusal('rate_limited', 429, { retry_after: 5 }); }, { sleep });
    expect(again.stopped?.at).toBe('a');
    expect(sleep).toHaveBeenCalledTimes(1);

    sleep.mockClear();
    const hourly = await runBulk(['a'], async () => { throw refusal('rate_limited', 429, { retry_after: 3600 }); }, { sleep });
    expect(hourly.stopped?.at).toBe('a');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('runBulk pacing', () => {
  it('sends at most one request per interval, so a long run cannot use up the minute limit', async () => {
    let time = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); time += ms; };
    const starts: number[] = [];
    const action = async (id: string) => { starts.push(time); time += 200; return { id }; };

    await runBulk(['a', 'b', 'c'], action, { minIntervalMs: 1000, sleep, now: () => time });

    expect(starts).toEqual([0, 1000, 2000]);
    expect(sleeps).toEqual([800, 800]);
  });

  it('without an interval, nothing waits', async () => {
    const sleep = vi.fn(async () => {});
    await runBulk(['a', 'b'], async id => id, { sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('bulkFailure', () => {
  it('a stopped run fails with the refusal itself, once, and says how far it got', () => {
    const error = refusal('live_off_for_company', 403);
    const failure = bulkFailure({ results: [{ id: 'a', ok: true }], stopped: { at: 'b', error } }, 200)!;
    expect(failure.message).toBe('live_off_for_company message (stopped at b: 1 of 200 done, 198 not tried)');
    expect(failure.exitCode).toBe(4);
    expect(failure.details.code).toBe('live_off_for_company');
  });

  it('per-item refusals only are a partial failure, as before', () => {
    const failure = bulkFailure({ results: [{ id: 'a', ok: true }, { id: 'b', ok: false }] }, 2)!;
    expect(failure.details.code).toBe('partial_failure');
    expect(failure.exitCode).toBe(6);
    expect(bulkFailure({ results: [{ id: 'a', ok: true }] }, 1)).toBeNull();
  });
});

describe('apiError', () => {
  it('carries a 429 Retry-After in seconds', () => {
    const error = apiError(429, { detail: { error: 'rate_limited', message: 'Agent minute request limit of 120 exceeded' } },
      new Headers({ 'Retry-After': '42' }));
    expect(error.details.retry_after).toBe(42);
    expect(apiError(429, {}, new Headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })).details.retry_after).toBeUndefined();
  });
});
