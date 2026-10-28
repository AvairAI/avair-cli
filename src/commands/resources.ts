import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import type { AvairClient } from '../lib/http.js';
import { client, emit, pageSize, toInt } from './shared.js';
import { apiPath } from '../lib/path.js';

// The manual-tasks API counts pages from 0; --page counts from 1. Sending
// page 1 as-is skipped the first page, so a short queue looked empty.
export function taskListQuery(o: { page?: string; limit?: string; channel?: string; campaignId?: string }) {
  return {
    page: Math.max(0, Number(o.page ?? '1') - 1), size: pageSize(o.limit, '--limit', 100, 50), scope: 'mine',
    ...(o.channel ? { channel: o.channel } : {}),
    ...(o.campaignId ? { campaign_id: o.campaignId } : {}),
  };
}

export const EVENT_TYPES = ['campaigns', 'contacts', 'activities'] as const;

type FeedPage = { data?: unknown[]; next_cursor?: string | null };

/**
 * One step of a cursor drain. An empty page returns next_cursor null: keep the
 * cursor you have, or a re-seed would skip everything older (partner guide).
 */
export function nextCursor(current: string | undefined, page: FeedPage): string | undefined {
  return page.data?.length && page.next_cursor ? page.next_cursor : current;
}

export function registerResources(program: Command): void {
  const tasks = program.command('tasks').description('Work the manual task queue');
  tasks.command('list').description('List your manual tasks').option('--limit <n>', 'page size, at most 100', '50').option('--page <n>', 'page number, starting at 1', '1')
    .option('--completed', 'completed tasks instead of open ones').option('--channel <channel>', 'only tasks of this channel').option('--campaign-id <id>', 'only tasks of this campaign')
    .action(async function (this: Command, o) {
      emit(this, await client(this).request(o.completed ? '/manual-tasks/completed' : '/manual-tasks/', { query: taskListQuery(o) }));
    });
  tasks.command('show <id>').description('Show one task').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/manual-tasks/${id}`)); });
  tasks.command('start <id>').description('Claim a task and start working on it').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/manual-tasks/${id}/start`, { method: 'PUT' })); });
  tasks.command('complete <id>').description('Mark a task done with its outcome').requiredOption('--outcome <outcome>', 'the result of the task').option('--notes <notes>', 'notes to save on the task').option('--replied-at <date>', 'for a LinkedIn reply: when the person replied (ISO date or time)').action(async function (this: Command, id: string, o) { emit(this, await client(this).request(apiPath`/manual-tasks/${id}/complete`, { method: 'PUT', body: { outcome: o.outcome, notes: o.notes, replied_at: o.repliedAt } })); });
  tasks.command('skip <id>').description('Skip a task').requiredOption('--reason <reason>', 'why the task is skipped').action(async function (this: Command, id: string, o) { emit(this, await client(this).request(apiPath`/manual-tasks/${id}/skip`, { method: 'PUT', body: { skipReason: o.reason } })); });
  tasks.command('reply <id>').description('Decide on a drafted reply (sending it needs --yes)')
    .requiredOption('--decision <decision>', 'APPROVE, REJECT, REJECT_AND_HOLD or SEND_TEMPLATE (EDIT is an alias for APPROVE)').requiredOption('--draft-version <n>', 'the version from reply-draft')
    .option('--subject <subject>', 'the new subject, for APPROVE').option('--body <body>', 'the new body, for APPROVE').action(async function (this: Command, id: string, o) {
      const api = client(this);
      try {
        emit(this, await api.request(apiPath`/manual-tasks/${id}/reply-decision`, { method: 'POST', body: { decision: o.decision === 'EDIT' ? 'APPROVE' : o.decision, version: toInt(o.draftVersion, '--draft-version'), subject: o.subject, body: o.body } }));
      } catch (error) {
        await explainConflict(this, api, id, error);
      }
    });
  tasks.command('reply-draft <id>').description('Show the drafted reply for a task').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/manual-tasks/${id}/reply-draft`)); });
  tasks.command('reply-decide <id>').description('Send or discard a drafted reply (--send needs --yes)')
    .option('--send', 'send the drafted reply (needs --yes)').option('--discard', 'discard the draft').requiredOption('--draft-version <n>', 'the version from reply-draft')
    .option('--subject <subject>', 'send this subject instead').option('--body <body>', 'send this body instead')
    .action(async function (this: Command, id: string, o) {
      if (Boolean(o.send) === Boolean(o.discard)) throw new CliError('Give --send or --discard.', 2);
      const decision = o.discard ? 'REJECT' : 'APPROVE';
      const api = client(this);
      try {
        emit(this, await api.request(apiPath`/manual-tasks/${id}/reply-decision`, { method: 'POST', body: {
          decision, version: toInt(o.draftVersion, '--draft-version'), subject: o.subject, body: o.body,
        } }));
      } catch (error) {
        await explainConflict(this, api, id, error);
      }
    });

  const events = program.command('events').description('Campaign, contact or activity changes');
  events.command('list').description('Read changes from the feed, page by page')
    .requiredOption('--type <type>', 'campaigns, contacts or activities')
    .option('--cursor <cursor>', 'continue after this position').option('--status <status>', 'only changes with this status').option('--campaign-id <id>', 'only changes of this campaign')
    .option('--limit <n>', 'page size, at most 500', '50').option('--follow', 'keep reading new changes until stopped')
    .action(async function (this: Command, o) {
      if (!(EVENT_TYPES as readonly string[]).includes(o.type)) throw new CliError('Type must be campaigns, contacts, or activities.', 2);
      // The campaigns feed has no campaign filter; the server refuses the field (F17).
      if (o.type === 'campaigns' && o.campaignId) throw new CliError('--campaign-id works with --type contacts or activities only.', 2, { code: 'invalid_input' });
      const limit = pageSize(o.limit, '--limit', 500, 50);
      const api = client(this);
      const read = (cursor?: string) => api.request(apiPath`/external/events/${o.type}`, { query: { cursor, status: o.status, campaign_id: o.campaignId, limit } }) as Promise<FeedPage>;
      let cursor: string | undefined = o.cursor;
      for (let first = true; ; first = false) {
        const page = await read(cursor);
        // While following, an empty page is not news; print the first one only.
        if (first || page.data?.length) emit(this, page);
        cursor = nextCursor(cursor, page);
        if (!o.follow) return;
        if ((page.data?.length ?? 0) < limit) await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    });
}

type ReplyDraftState = { status?: string; version?: number } | null;
type TaskState = { status?: string; outcome?: string; completedAt?: string; completedByUserName?: string } | null;

export type DecisionFacts = {
  already_decided: boolean;
  draft_status: string | null;
  draft_version?: number;
  decided_by: string | null;
  decided_at: string | null;
  /** true only when the draft says SENT; false when nothing was or will be sent; null when not known yet. */
  sent: boolean | null;
  task_status: string | null;
  outcome: string | null;
};

/** "2026-10-06T16:32:05" or "...Z" or "+00:00" -> "2026-10-06 16:32 UTC". A time without an offset is UTC. */
function utcMinute(value: string | undefined): string | null {
  if (!value) return null;
  const time = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(time.getTime()) ? value : `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What a 409 on a reply decision means, from the draft (its status, via Java)
 * and the task (who completed it and when) (AVI-1127). "already decided" and
 * a task status of COMPLETED read like success; this says what happened and
 * whether anything was sent. Never says sent unless the draft says SENT.
 */
export function describeDecision(draft: ReplyDraftState, task: TaskState): { facts: DecisionFacts; message: string; code: string } {
  const status = draft?.status ?? null;
  const by = task?.completedByUserName || null;
  const at = utcMinute(task?.completedAt);
  const facts: DecisionFacts = {
    already_decided: status !== 'PENDING_APPROVAL',
    draft_status: status,
    decided_by: by,
    decided_at: at,
    sent: null,
    task_status: task?.status ?? null,
    outcome: task?.outcome ?? null,
  };
  if (status === 'PENDING_APPROVAL') {
    facts.draft_version = draft?.version;
    return {
      facts, code: 'stale_version',
      message: `The draft changed since you read it${draft?.version !== undefined ? ` (it is now version ${draft.version})` : ''}. Read it again with \`avair tasks reply-draft\` and decide on that version. Nothing was sent.`,
    };
  }
  const who = `${by ? ` by ${by}` : ''}${at ? ` at ${at}` : ''}`;
  let what: string;
  switch (status) {
    case 'REJECTED': facts.sent = false; what = `This reply was rejected${who}. Nothing was sent.`; break;
    // SENDING, SENT and FAILED follow any decision that sends: the draft, an
    // edit, or the standard reply. They say a reply was sent, not which one.
    case 'APPROVED': what = `This reply was already approved${who}; it is about to be sent.`; break;
    case 'SENDING': what = `This reply was already decided${who}, and a reply is being sent.`; break;
    case 'SENT': facts.sent = true; what = `This reply was already decided${who}, and a reply was sent.`; break;
    case 'FAILED': facts.sent = false; what = `This reply was already decided${who}, but sending the reply failed.`; break;
    case 'TEMPLATE_SELECTED': what = `The standard reply was chosen${who} instead of this draft.`; break;
    case 'FALLBACK_SELECTED': what = 'No draft could be written for this message, so the standard reply is used instead.'; break;
    case 'EXPIRED': what = 'Nobody decided this reply in time, so the standard reply is used instead.'; break;
    case null: {
      // The draft could not be read: say only what the task records.
      const outcome = task?.outcome ? ` with outcome ${task.outcome}` : '';
      what = `This reply was already decided${who}${outcome}. Check the task in the app before doing anything else.`;
      break;
    }
    default: what = `This reply was already decided${who} (draft status ${status}).`;
  }
  return { facts, message: what, code: 'already_decided' };
}

/**
 * A 409 on a reply decision: report what was recorded, once — the facts on
 * stdout, the sentence as the error — instead of "already decided" and a
 * bare COMPLETED (AVI-1127). Any other error is re-thrown as it was.
 */
async function explainConflict(command: Command, api: AvairClient, id: string, error: unknown): Promise<never> {
  if (!(error instanceof CliError) || error.status !== 409) throw error;
  const [draft, task] = await Promise.all([
    api.request(apiPath`/manual-tasks/${id}/reply-draft`).then(value => value as ReplyDraftState).catch(() => null),
    api.request(apiPath`/manual-tasks/${id}`).then(value => value as TaskState).catch(() => null),
  ]);
  const { facts, message, code } = describeDecision(draft, task);
  emit(command, facts);
  throw new CliError(message, 6, { code });
}
