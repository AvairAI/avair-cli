/**
 * AVI-1127: what a 409 on a reply decision tells the user, for each draft status.
 */
import { describe, expect, it } from 'vitest';

import { describeDecision } from '../../src/commands/resources.js';

const by = { status: 'COMPLETED', completedByUserName: 'Olivia Castell', completedAt: '2026-10-06T16:32:00Z' };

describe('describeDecision', () => {
  it.each([
    ['REJECTED', false, 'This reply was rejected by Olivia Castell at 2026-10-06 16:32 UTC. Nothing was sent.'],
    ['SENT', true, 'This reply was already decided by Olivia Castell at 2026-10-06 16:32 UTC, and a reply was sent.'],
    ['APPROVED', null, 'This reply was already approved by Olivia Castell at 2026-10-06 16:32 UTC; it is about to be sent.'],
    ['SENDING', null, 'This reply was already decided by Olivia Castell at 2026-10-06 16:32 UTC, and a reply is being sent.'],
    ['FAILED', false, 'This reply was already decided by Olivia Castell at 2026-10-06 16:32 UTC, but sending the reply failed.'],
    ['TEMPLATE_SELECTED', null, 'The standard reply was chosen by Olivia Castell at 2026-10-06 16:32 UTC instead of this draft.'],
    ['FALLBACK_SELECTED', null, 'No draft could be written for this message, so the standard reply is used instead.'],
    ['EXPIRED', null, 'Nobody decided this reply in time, so the standard reply is used instead.'],
    ['SOMETHING_NEW', null, 'This reply was already decided by Olivia Castell at 2026-10-06 16:32 UTC (draft status SOMETHING_NEW).'],
  ])('%s', (status, sent, message) => {
    const result = describeDecision({ status, version: 1 }, by);
    expect(result.message).toBe(message);
    expect(result.facts.sent).toBe(sent);
    expect(result.code).toBe('already_decided');
  });

  it('leaves out who and when when the task does not record them (an expiry has no person)', () => {
    expect(describeDecision({ status: 'REJECTED' }, { status: 'COMPLETED' }).message).toBe('This reply was rejected. Nothing was sent.');
  });

  it('reads a time without an offset as UTC', () => {
    expect(describeDecision({ status: 'REJECTED' }, { completedAt: '2026-10-06T16:32:59.123' }).facts.decided_at).toBe('2026-10-06 16:32 UTC');
  });

  it('a pending draft is a stale version, not a decision, and nothing was sent', () => {
    const result = describeDecision({ status: 'PENDING_APPROVAL', version: 4 }, { status: 'OPEN' });
    expect(result.code).toBe('stale_version');
    expect(result.facts.already_decided).toBe(false);
    expect(result.message).toContain('it is now version 4');
    expect(result.message).toContain('Nothing was sent.');
  });
});
