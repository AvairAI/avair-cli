import { describe, expect, it } from 'vitest';

import { CliError } from '../../src/lib/errors.js';
import { finishedAfterStart, isRunningStatus, pollInterval, waitUntil } from '../../src/lib/wait.js';

/** A clock that only moves when the wait sleeps. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
  };
}

const what = { id: 'c1', check: 'avair campaigns watch c1' };

describe('waitUntil', () => {
  it('never sleeps past the deadline, and reads once more at it before giving up', async () => {
    const clock = fakeClock();
    let reads = 0;
    const error = await waitUntil(async () => { reads += 1; return 'running'; }, () => false,
      { timeoutSeconds: 0.001, intervalMs: 5000, now: clock.now, sleep: clock.sleep }, what).catch(e => e);

    // The old wait slept a whole interval (5 s) past a 1 ms timeout.
    expect(clock.sleeps).toEqual([1]);
    expect(reads).toBe(2);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(11);
    expect((error as CliError).details.code).toBe('wait_timeout');
  });

  it('polls at the interval while time is left', async () => {
    const clock = fakeClock();
    let reads = 0;
    const value = await waitUntil(async () => (reads += 1), count => count === 3,
      { timeoutSeconds: 60, intervalMs: 5000, now: clock.now, sleep: clock.sleep }, what);

    expect(value).toBe(3);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('a value that is done at the first read returns without sleeping', async () => {
    const clock = fakeClock();
    expect(await waitUntil(async () => 'done', () => true,
      { timeoutSeconds: 0.001, now: clock.now, sleep: clock.sleep }, what)).toBe('done');
    expect(clock.sleeps).toEqual([]);
  });

  it('backs off 1, 2, 3 s, then polls every 3.5 s (B2)', async () => {
    const clock = fakeClock();
    let reads = 0;
    await waitUntil(async () => (reads += 1), count => count === 6,
      { timeoutSeconds: 60, now: clock.now, sleep: clock.sleep }, what);
    expect(clock.sleeps).toEqual([1000, 2000, 3000, 3500, 3500]);
    expect(pollInterval(50)).toBe(3500);
  });
});

describe('a content preview is still running while it finalizes or applies (F37)', () => {
  it('counts FINALIZING and APPLYING as running, READY and FAILED as done', () => {
    expect(['FINALIZING', 'APPLYING'].map(isRunningStatus)).toEqual([true, true]);
    expect(['READY', 'FAILED', 'NONE'].map(isRunningStatus)).toEqual([false, false, false]);
  });

  it('a regenerate wait does not stop at FINALIZING', () => {
    const done = finishedAfterStart<string>(isRunningStatus);
    expect(['GENERATING', 'FINALIZING', 'FAILED'].map(done)).toEqual([false, false, true]);
  });
});
