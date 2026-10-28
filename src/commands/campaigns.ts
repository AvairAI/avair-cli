import { readFile } from 'node:fs/promises';
import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import { fileForm, previewCsv } from '../lib/files.js';
import { idempotencyKey } from '../lib/idempotency.js';
import { addWaitOptions, finishedAfterStart, isRunningStatus, waitSettings, waitUntil, WORKER_QUIET_MS } from '../lib/wait.js';
import {
  buildOutcome, campaignOutcome, client, csv, download, emit, emitWaited, endedFailed, globals, readJsonFile, requireConfirmation, requireValue, toInt,
} from './shared.js';
import { apiPath } from '../lib/path.js';
import type { AvairClient } from '../lib/http.js';

// WhatsApp is not one: the create API refuses it (422 whatsapp_not_supported_by_api_launch).
const channelNames = new Set(['email', 'manual_call', 'ai_call', 'linkedin']);
const campaignStyles = new Set([
  'STANDARD', 'COMPETITOR_REPLACEMENT', 'SINGLE_COMPETITOR_TAKEOUT',
  'EVENT_OUTREACH', 'LOCAL_MARKET_PUSH', 'LIST_STANDARD',
  'EVENT_LIST_FOLLOW_UP', 'WIN_BACK', 'CUSTOMER_EXPANSION',
  'PARTNER_RECRUITMENT',
]);

type CampaignCreateOptions = {
  website?: string;
  location?: string;
  size?: string;
  industry?: string;
  channels?: string;
  contentStyle?: string;
  assess?: string;
};

// Assess this step (docs/step-assessment-plan-2026-10-12.md).
export const assessSteps = ['messaging', 'content', 'targets', 'contacts'];
const buildSteps = ['messaging', 'content', 'targets'];
// One AI review may take 45 s, and an Apply with no suggestions assesses
// first, so these requests wait longer than most (CLI plan B1+).
const ASSESS_TIMEOUT_MS = 120_000;

export function assessStep(value: string): string {
  const step = value.trim().toLowerCase();
  if (!assessSteps.includes(step)) throw new CliError(`Unknown step ${value}. Use ${assessSteps.join(', ')}.`, 2, { code: 'invalid_input' });
  return step;
}

/** --assess for create: all (the default), none, or a comma list of build steps. */
export function assessApplySteps(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().toLowerCase() === 'all') return undefined;
  if (value.trim().toLowerCase() === 'none') return [];
  const steps = csv(value).map(step => step.toLowerCase());
  const unknown = steps.find(step => !buildSteps.includes(step));
  if (unknown) throw new CliError(`Unknown step ${unknown} for --assess. Use all, none, or ${buildSteps.join(', ')}.`, 2, { code: 'invalid_input' });
  return steps;
}

type Assessment = { step?: string; findings?: Array<{ suggestions?: Array<Record<string, unknown>> }>; [field: string]: unknown };

/**
 * Each step's assessment, all at once (F42): one after another, four model
 * reviews took up to about 3 minutes. Kept in step order; a step answered
 * with null (no data yet) is left out.
 */
export async function assessEach<T>(steps: string[], assess: (step: string) => Promise<T | null>): Promise<T[]> {
  return (await Promise.all(steps.map(assess))).filter((result): result is T => result !== null);
}

/** The model wrote the notes and suggestions: they go under `untrusted` (CLI plan A5). */
export function assessmentOutput(result: Assessment): Record<string, unknown> {
  const { findings, ...rest } = result;
  return findings === undefined ? rest : { ...rest, untrusted: { findings } };
}

/** The suggestions named by id in a saved `avair campaigns assess --json` result. */
export function pickSuggestions(saved: unknown, ids: string[]): Array<Record<string, unknown>> {
  const results = (Array.isArray(saved) ? saved : [saved]) as Array<Record<string, any>>;
  const all = results.flatMap(r => (r?.untrusted?.findings ?? r?.findings ?? []) as Array<Record<string, any>>)
    .flatMap(f => (f?.suggestions ?? []) as Array<Record<string, unknown>>);
  return ids.map(id => {
    const found = all.find(s => s.id === id);
    if (!found) throw new CliError(`No suggestion ${id} in the saved assessment.`, 2, { code: 'invalid_input' });
    return found;
  });
}

export function campaignCreateBody(options: CampaignCreateOptions): Record<string, unknown> {
  const selectedChannels = csv(options.channels).map(value => value.toLowerCase().replaceAll('-', '_'));
  if (selectedChannels.includes('whatsapp')) {
    throw new CliError('WhatsApp cannot be chosen when a campaign is created from the CLI or the API. Add it in the app.', 2, { code: 'invalid_input' });
  }
  const unknownChannel = selectedChannels.find(value => !channelNames.has(value));
  if (unknownChannel) {
    throw new CliError(
      `Unknown channel ${unknownChannel}. Use email, manual_call, ai_call, or linkedin.`,
      2,
    );
  }
  const style = options.contentStyle?.trim().toUpperCase().replaceAll('-', '_');
  if (style && !campaignStyles.has(style)) {
    throw new CliError(
      `Unknown campaign style ${options.contentStyle}. Use standard, competitor-replacement, event-outreach, or another published campaign style.`,
      2,
    );
  }
  const selected = selectedChannels.length ? new Set(selectedChannels) : undefined;
  return {
    website_url: options.website,
    targeting: {
      ...(options.location ? { locations: [options.location] } : {}),
      ...(options.size ? { company_sizes: [options.size] } : {}),
      ...(options.industry ? { industries: [options.industry] } : {}),
    },
    ...(selected ? { channels: {
      manual_call: selected.has('manual_call'),
      ai_call: selected.has('ai_call'),
      linkedin: selected.has('linkedin'),
      whatsapp: selected.has('whatsapp'),
    } } : {}),
    ...(style ? { campaign_style: style } : {}),
    ...(assessApplySteps(options.assess) !== undefined ? { assessment_apply_steps: assessApplySteps(options.assess) } : {}),
    stop_at_targets: true,
  };
}

type DispatchStatus = { operation: { created_at?: string; [field: string]: unknown } | null };

/** The newer of a launch's and a test's dispatch operation (either may be null). */
export function newestDispatch(start: DispatchStatus, test: DispatchStatus): DispatchStatus {
  if (!test?.operation) return start;
  if (!start?.operation) return test;
  return Date.parse(test.operation.created_at ?? '') > Date.parse(start.operation.created_at ?? '') ? test : start;
}

export function dispatchKind(value = 'start'): 'START' | 'TEST' {
  const normalized = value.trim().toUpperCase();
  if (normalized !== 'START' && normalized !== 'TEST') {
    throw new CliError('Dispatch kind must be start or test.', 2);
  }
  return normalized;
}

export function testType(o: { quick?: boolean; full?: boolean; type?: string }): string {
  if (o.quick && o.full) throw new CliError('Choose --quick or --full, not both.', 2);
  if (o.full) return 'full';
  if (o.quick) return 'quick';
  return String(o.type ?? 'quick').trim().toLowerCase();
}

type AgentBuild = { state?: string; stop_at?: string; heartbeat_at?: string | null; started_at?: string };
type Campaign = { status?: string; version?: number; agent_build?: AgentBuild | null };

/**
 * A build whose heartbeat is older than 5 minutes is stale; calling agent-build again re-claims it.
 * Design §4.8 says 3; the server restarts a build and sets `stale` only past 5, so an
 * earlier re-POST returns 202 and does nothing, spending the one retry this window allows.
 */
export const STALE_BUILD_MS = 5 * 60 * 1000;

export function isStaleBuild(build: AgentBuild | null | undefined, now = Date.now()): boolean {
  if (!build || build.state !== 'running') return false;
  const last = Date.parse(build.heartbeat_at || build.started_at || '');
  return !Number.isFinite(last) || now - last > STALE_BUILD_MS;
}

const readCampaign = (command: Command, id: string) =>
  client(command).request(apiPath`/campaigns/${id}`) as Promise<Campaign>;

/** The campaign's optimistic-lock version, read only when the caller did not give one. */
async function campaignVersion(command: Command, id: string, given?: string): Promise<number> {
  const explicit = toInt(given, '--campaign-version');
  if (explicit !== undefined) return explicit;
  const version = (await readCampaign(command, id)).version;
  if (typeof version !== 'number') throw new CliError('The campaign has no version; pass --campaign-version.', 2);
  return version;
}

/**
 * A campaign made from a website has finished its first run (targets reached,
 * failed, or ready). Its status shows DRAFT_NEEDS_CONTENT_REVIEW for a moment
 * while targets are still generating: the shared content task sets it and the
 * orchestrator puts DRAFT_GENERATING_TARGETS back, so that status is not done.
 */
export function creationSettled(campaign: Campaign): boolean {
  return !isRunningStatus(campaign.status) && campaign.status !== 'DRAFT_NEEDS_CONTENT_REVIEW';
}

/** POST /external/campaigns, the Create New page's request (stops at targets). */
async function createCampaign(command: Command, o: CampaignCreateOptions & { input?: string; idempotencyKey?: string }) {
  const body = o.input ? await readJsonFile(o.input) : campaignCreateBody({
    ...o, website: requireValue(o.website, 'Give --website, or a full request with --input. Example: avair campaigns create --website example.com'),
  });
  return await client(command).request('/external/campaigns', {
    method: 'POST', body, retryWrite: true,
    headers: { 'Idempotency-Key': idempotencyKey(o.idempotencyKey) },
  }) as { campaign_id?: string };
}

const waitForCreation = (command: Command, id: string, o: { timeout?: string }) => waitUntil(
  () => readCampaign(command, id), creationSettled,
  waitSettings(o), { id, check: `avair campaigns watch ${id}` },
);

type ActivityEntry = { id?: string; activity_type?: string; details?: string | null };
type UploadDetails = Record<string, unknown>;
type DncNotice = { count?: number; operation?: string; upload_id?: string; excluded?: Array<{ email: string; source: string }> };

const asEntries = (value: unknown): ActivityEntry[] => (Array.isArray(value) ? value as ActivityEntry[] : []);

/**
 * The upload result: the activity entry carrying `contacts_uploaded` that is
 * newer than `since` (entries come newest first) and, when the server gave the
 * upload an id, carries that same id, so an overlapping upload to the same
 * campaign is never taken for this one. Null until the task has written it.
 */
export function findUploadResult(entries: ActivityEntry[], since: string | null, uploadId?: string): UploadDetails | null {
  for (const entry of entries) {
    if (since !== null && entry.id === since) return null;
    if (entry.activity_type !== 'CAMPAIGN_UPDATED' || !entry.details) continue;
    let details: UploadDetails;
    try { details = JSON.parse(entry.details) as UploadDetails; } catch { continue; }
    if (!details || details.contacts_uploaded === undefined) continue;
    if (uploadId && details.upload_id !== uploadId) continue;
    return details;
  }
  return null;
}

/** The Review Contacts reasons (ReviewContactsPage DNC_EXCLUSION_REASONS), in CLI words. */
const DNC_REASONS: Record<string, string> = {
  USER_LIST: 'on your Do Not Contact list',
  TENANT_OPT_OUT: 'marked Do Not Contact on an earlier campaign',
  TENANT_UNSUBSCRIBED: 'unsubscribed from your emails',
  GLOBAL_SUPPRESSION: 'suppressed after a privacy request (contact support)',
};

export type UploadSummary = {
  campaign_id: string;
  status?: string;
  added: number;
  updated: number;
  left_out: { invalid: number; do_not_contact: number; over_limit: number; repeated: number };
  /** Contacts already in the campaign that were removed to make room for this upload. */
  removed_to_make_room: { uploaded_earlier: number; avair: number };
  excluded: Array<{ email: string; reason: string }>;
  excluded_more: number;
  message: string;
};

/**
 * What a contact upload added and left out, and why (AVI-1122). The counts
 * come from the upload's activity entry; the Do Not Contact addresses come from
 * the campaign's Review Contacts notice when it belongs to this upload.
 */
export function uploadSummary(id: string, details: UploadDetails, campaign: Campaign & { campaign_content?: { dnc_contact_exclusions_json?: DncNotice | null } | null }): UploadSummary {
  if (details.failure_reason) {
    throw new CliError('The upload failed on the server. Check the file and try again.', 1,
      { code: 'upload_failed', hint: `avair campaigns activity ${id}` });
  }
  const count = (key: string) => (typeof details[key] === 'number' ? details[key] as number : 0);
  // A re-uploaded contact is deleted and created again: it is in
  // contacts_added_to_campaign, but the campaign did not grow by it.
  const updated = Math.min(count('contacts_updated'), count('contacts_added_to_campaign'));
  const added = count('contacts_added_to_campaign') - updated;
  const leftOut = {
    invalid: count('contacts_skipped'),
    do_not_contact: count('contacts_excluded_do_not_contact'),
    over_limit: count('contacts_not_added_over_limit'),
    repeated: count('contacts_duplicate_in_file'),
  };
  const notice = campaign.campaign_content?.dnc_contact_exclusions_json;
  // The notice is replaced by each contact operation and its write may fail
  // softly, so its addresses are shown only when it carries this upload's id.
  const ownNotice = typeof details.upload_id === 'string' && notice?.upload_id === details.upload_id;
  const excluded = ownNotice
    ? (notice?.excluded ?? []).map(({ email, source }) => ({ email, reason: DNC_REASONS[source] ?? 'on a Do Not Contact list' }))
    : [];
  const parts = [
    leftOut.invalid && `${leftOut.invalid} with invalid data`,
    leftOut.do_not_contact && `${leftOut.do_not_contact} on a Do Not Contact list`,
    leftOut.over_limit && `${leftOut.over_limit} over the contact limit`,
    leftOut.repeated && `${leftOut.repeated} repeated in the file`,
  ].filter(Boolean);
  const total = leftOut.invalid + leftOut.do_not_contact + leftOut.over_limit + leftOut.repeated;
  const done = updated ? `${added} added, ${updated} updated` : `${added} added`;
  const removed = {
    uploaded_earlier: count('user_contacts_removed_by_limit'),
    avair: count('avair_contacts_removed_by_limit'),
  };
  const removedParts = [
    removed.uploaded_earlier && `${removed.uploaded_earlier} uploaded earlier`,
    removed.avair && `${removed.avair} found by AvairAI`,
  ].filter(Boolean);
  const room = removedParts.length ? ` To make room, contacts already in the campaign were removed: ${removedParts.join(', ')}.` : '';
  return {
    campaign_id: id,
    status: campaign.status,
    added,
    updated,
    left_out: leftOut,
    removed_to_make_room: removed,
    excluded,
    excluded_more: Math.max(0, leftOut.do_not_contact - excluded.length),
    message: (total ? `${done}, ${total} left out: ${parts.join(', ')}.` : `${done}, none left out.`) + room,
  };
}

export function uploadSummaryText(summary: UploadSummary): string {
  const lines = [summary.message, ...summary.excluded.map(row => `  ${row.email} - ${row.reason}`)];
  if (summary.excluded_more) lines.push(`  and ${summary.excluded_more} more`);
  return lines.join('\n');
}

type MustFix = { id: string; message: string; area?: string };
type LaunchScore = { enabled?: boolean; verdict?: string; must_fix?: MustFix[] };

/**
 * The launch score, or null when there is none to show: the switch is off,
 * the campaign is not ready to launch (400), the server predates the agent
 * route (403, 404), scoring failed, or the request failed. It is advice: it
 * never fails the readiness read or a launch, and the server still asks
 * before a launch.
 */
export async function launchScore(api: AvairClient, id: string): Promise<LaunchScore | null> {
  try {
    const score = await api.request(apiPath`/campaigns/${id}/launch-score`) as LaunchScore;
    return score?.enabled === false ? null : score;
  } catch (error) {
    // Any failure, a network error or a timeout included, means "no score".
    if (error instanceof CliError) return null;
    throw error;
  }
}

/** Run a step, then wait for the campaign to leave its generating status when asked. */
async function stepThenWait(
  command: Command, id: string, o: { wait?: boolean; timeout?: string }, step: () => Promise<unknown>,
): Promise<void> {
  if (!o.wait) { emit(command, await step()); return; }
  // Some steps set their generating status in the worker, after this request
  // returns. A changed status, or a run that was seen and then ended, is done.
  const before = (await readCampaign(command, id)).status;
  await step();
  const settled = finishedAfterStart<Campaign>(campaign => isRunningStatus(campaign.status), WORKER_QUIET_MS);
  emitWaited(command, await waitUntil(
    () => readCampaign(command, id),
    campaign => (!isRunningStatus(campaign.status) && campaign.status !== before) || settled(campaign),
    waitSettings(o), { id, check: `avair campaigns watch ${id}` },
  ), `avair campaigns watch ${id}`);
}

export function registerCampaigns(program: Command): void {
  const campaigns = program.command('campaigns').description('Create, build, review and launch campaigns');
  campaigns.command('list')
    .description('List campaigns')
    .option('--status <status>', 'a campaign status, ALL_DRAFTS or ALL')
    .option('--mine', 'only campaigns you own or are assigned to')
    .option('--search <text>', 'only campaigns that match this text')
    .option('--limit <n>', 'page size', '50')
    .option('--skip <n>', 'rows to skip', '0')
    .action(async function (this: Command, o) {
      const list = (scope: 'mine' | 'all') => client(this).request('/campaigns/', { query: {
        limit: toInt(o.limit, '--limit'), skip: toInt(o.skip, '--skip'),
        status_filter: o.status, search: o.search, scope,
      } });
      if (o.mine) { emit(this, await list('mine')); return; }
      try {
        emit(this, await list('all'));
      } catch (error) {
        // Only an Admin or Manager may list the whole company. A User gets the
        // list's own plain 403 and sees their own campaigns, as in the app
        // (AVI-1135). A gateway refusal carries a code and is not retried.
        if (!(error instanceof CliError && error.status === 403 && error.details.code === 'http_403')) throw error;
        emit(this, await list('mine'));
      }
    });
  campaigns.command('show <id>').description('Show one campaign').action(async function (this: Command, id: string) {
    emit(this, await readCampaign(this, id));
  });
  addWaitOptions(campaigns.command('watch <id>').description('Wait until the campaign stops generating'))
    .action(async function (this: Command, id: string, o) {
      emitWaited(this, await waitUntil(
        () => readCampaign(this, id),
        campaign => !isRunningStatus(campaign.status) && campaign.agent_build?.state !== 'running',
        waitSettings(o), { id, check: `avair campaigns watch ${id}` },
      ), `avair campaigns watch ${id}`, campaignOutcome);
    });
  addWaitOptions(campaigns.command('create')
    .description('Create a campaign from a website; it stops when its targets are ready')
    .option('--input <file>', 'complete JSON request file')
    .option('--website <url>', 'the website of the company to sell for')
    .option('--location <location>', 'one place to target, for example a state')
    .option('--size <size>', 'one company size to target, for example 51-200')
    .option('--industry <industry>', 'one industry to target')
    .option('--channels <channels>', 'comma-separated: email, manual_call, ai_call, linkedin')
    .option('--content-style <style>', 'campaign style, lower case with hyphens: standard, competitor-replacement, single-competitor-takeout, event-outreach, local-market-push, list-standard, event-list-follow-up, win-back, customer-expansion, partner-recruitment')
    .option('--assess <steps>', 'steps the build checks and improves by itself: all (default), none or a comma list of messaging, content and targets')
    .option('--idempotency-key <key>', 'a retry with the same key and the same request returns the same campaign, not a second one; a different request with that key is refused (409); default: a new random key each run'))
    .action(async function (this: Command, o) {
      const created = await createCampaign(this, o);
      if (!o.wait || !created?.campaign_id) { emit(this, created); return; }
      emitWaited(this, await waitForCreation(this, created.campaign_id, o), `avair campaigns watch ${created.campaign_id}`);
    });
  addWaitOptions(campaigns.command('build [id]')
    .description('Build a campaign on the server up to a review stop; never launches. With --website it first creates the campaign (as campaigns create) and waits for its targets, then continues')
    .requiredOption('--stop-at <stage>', 'where to stop: targets, contacts, ready or launchable (launchable also confirms the overview and runs contact verification and phone checks, which cost nothing)')
    .option('--website <url>', 'create a new campaign from this website first (instead of giving an id)')
    .option('--location <location>', 'one place to target, for example a state; only with --website')
    .option('--size <size>', 'one company size to target, for example 51-200; only with --website')
    .option('--industry <industry>', 'one industry to target; only with --website')
    .option('--channels <channels>', 'comma-separated: email, manual_call, ai_call, linkedin; only with --website')
    .option('--content-style <style>', 'campaign style, lower case with hyphens: standard, competitor-replacement, single-competitor-takeout, event-outreach, local-market-push, list-standard, event-list-follow-up, win-back, customer-expansion, partner-recruitment; only with --website')
    .option('--idempotency-key <key>', 'with --website, protects the create step as on create (same key and request returns the same campaign; a different request is refused with 409); not needed for an existing campaign, where the server already returns the build in progress; default: a new random key each run'))
    .action(async function (this: Command, given: string | undefined, o) {
      const targeting = ['location', 'size', 'industry', 'channels', 'contentStyle'].filter(name => o[name] !== undefined);
      if (given && o.website) throw new CliError('Give a campaign id or --website, not both.', 2, { code: 'invalid_input' });
      if (!o.website && targeting.length) {
        throw new CliError('--location, --size, --industry, --channels and --content-style need --website.', 2, { code: 'invalid_input' });
      }
      let id: string;
      if (o.website) {
        // The build can start only once targets exist, so the create step is
        // always waited for, whatever --wait says. From there the server's
        // build takes over; it also reports a failed generation with its fix.
        const created = await createCampaign(this, o);
        if (!created?.campaign_id) { emit(this, created); return; } // dry run
        id = created.campaign_id;
        const campaign = await waitForCreation(this, id, o);
        // A creation that failed has no targets to build on (F32): stop here.
        if (o.stopAt === 'targets' || endedFailed(String(campaign.status ?? ''))) {
          emitWaited(this, { campaign_id: id, status: campaign.status, agent_build: campaign.agent_build ?? null }, `avair campaigns watch ${id}`, campaignOutcome);
          return;
        }
      } else {
        id = requireValue(given, 'Give a campaign id, or --website to start a new campaign. Example: avair campaigns build --website example.com --stop-at targets');
      }
      const started = await client(this).request(apiPath`/campaigns/${id}/agent-build`, {
        method: 'POST', body: { stop_at: o.stopAt }, retryWrite: true,
        headers: { 'Idempotency-Key': idempotencyKey(o.idempotencyKey) },
      });
      if (!o.wait) { emit(this, o.website ? { campaign_id: id, ...(started as object) } : started); return; }
      let lastRestart = 0;
      const done = await waitUntil(async () => {
        const campaign = await readCampaign(this, id);
        // A stale build recovers when agent-build is called again (design §4.8).
        // At most once per stale window: each call counts against the agent
        // generation rate limit.
        if (isStaleBuild(campaign.agent_build) && Date.now() - lastRestart > STALE_BUILD_MS) {
          lastRestart = Date.now();
          await client(this).request(apiPath`/campaigns/${id}/agent-build`, {
            method: 'POST', body: { stop_at: o.stopAt }, retryWrite: true,
            headers: { 'Idempotency-Key': idempotencyKey(o.idempotencyKey) },
          });
        }
        return campaign;
      }, campaign => campaign.agent_build?.state !== 'running',
      waitSettings(o), { id, check: `avair campaigns watch ${id}` });
      emitWaited(this, { campaign_id: id, status: done.status, agent_build: done.agent_build }, `avair campaigns watch ${id}`, buildOutcome);
    });
  campaigns.command('dispatch-status <id>').description('Show the progress of a launch or a test start')
    .option('--kind <kind>', 'start or test (default: whichever is newest)').action(async function (this: Command, id: string, o) {
      const read = (kind: 'START' | 'TEST') => client(this).request(
        apiPath`/campaigns/${id}/agent-dispatch-operation`, { query: { kind } },
      ) as Promise<DispatchStatus>;
      if (o.kind) { emit(this, await read(dispatchKind(o.kind))); return; }
      // AVI-1141: after `campaigns test` the default (start) showed nothing.
      const [start, test] = await Promise.all([read('START'), read('TEST')]);
      emit(this, newestDispatch(start, test));
    });
  campaigns.command('rename <id>').description('Rename a campaign').requiredOption('--name <name>', 'the new campaign name').option('--campaign-version <n>', 'the campaign version you read')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/campaigns/${id}/name`, {
        method: 'PUT', body: { name: o.name, expected_version: await campaignVersion(this, id, o.campaignVersion) },
      }));
    });

  const inputs = campaigns.command('inputs').description('Step 1 inputs: company profile, story, call agent');
  inputs.command('show <id>').description('Show the Step 1 inputs').action(async function (this: Command, id: string) { emit(this, await readCampaign(this, id)); });
  inputs.command('edit <id>').description('Replace the Step 1 inputs from a JSON file').requiredOption('--input <file>', 'JSON with company_profile_json, case_study_json, call_agent_info …')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/campaigns/${id}/step1-review`, { method: 'PUT', body: await readJsonFile(o.input) }));
    });
  addWaitOptions(inputs.command('approve <id>').description('Generate content (legacy wizard campaigns only)'))
    .action(async function (this: Command, id: string, o) {
      await stepThenWait(this, id, o, () => client(this).request(apiPath`/campaigns/${id}/generate-content`, { method: 'POST' }));
    });

  const content = campaigns.command('content').description('Email templates and call scripts');
  content.command('show <id>').description('Show the email templates and call scripts').action(async function (this: Command, id: string) {
    const api = client(this);
    emit(this, {
      email_templates: await api.request(apiPath`/campaigns/${id}/email-templates`),
      call_scripts: await api.request(apiPath`/campaigns/${id}/call-scripts`),
    });
  });
  content.command('keep <id>')
    .description('Keep a template as it is after the content review flagged it (answers the review note; not an edit)')
    .requiredOption('--template <templateId>', 'an email template or call script id from content show')
    .option('--kind <kind>', 'email or call', 'email')
    .option('--content-version <n>', 'content_version from content show')
    .action(async function (this: Command, _id: string, o) {
      const version = requireValue(toInt(o.contentVersion, '--content-version'), 'Give --content-version: the content_version from `avair campaigns content show`.');
      const call = String(o.kind).toLowerCase() === 'call';
      emit(this, await client(this).request(call ? apiPath`/call-script-templates/${o.template}` : apiPath`/email-templates/${o.template}`, {
        method: 'PUT', body: { keep_as_is: true, expected_content_version: version },
      }));
    });
  content.command('edit <id>')
    .description('Change one email template or call script')
    .requiredOption('--template <templateId>', 'an email template or call script id from content show')
    .option('--kind <kind>', 'email or call', 'email')
    .option('--content-version <n>', 'content_version from content show')
    .option('--subject <text>', 'new email subject').option('--body <text>', 'new email body').option('--script <text>', 'new call script text')
    .action(async function (this: Command, _id: string, o) {
      // The version proves the edit is based on what the agent read (B31); it is
      // never fetched here, or a human's newer edit would be overwritten.
      const version = requireValue(toInt(o.contentVersion, '--content-version'), 'Give --content-version: the content_version from `avair campaigns content show`.');
      const call = String(o.kind).toLowerCase() === 'call';
      const body = call
        ? { script_text: requireValue(o.script, 'Give --script for a call script.'), expected_content_version: version }
        : { subject_template: o.subject, body_template: o.body, expected_content_version: version };
      if (!call && o.subject === undefined && o.body === undefined) throw new CliError('Give --subject, --body, or both.', 2);
      emit(this, await client(this).request(call ? apiPath`/call-script-templates/${o.template}` : apiPath`/email-templates/${o.template}`, { method: 'PUT', body }));
    });
  addWaitOptions(content.command('approve <id>').description('Generate targets (legacy wizard campaigns only)'))
    .action(async function (this: Command, id: string, o) {
      await stepThenWait(this, id, o, () => client(this).request(apiPath`/campaigns/${id}/generate-targets`, { method: 'POST' }));
    });
  addWaitOptions(content.command('regenerate <id>').description('Draft new content as a preview')
    .option('--instructions <text>', 'what to change or focus on in the new draft').option('--style <style>', 'content style for the draft')
    .option('--language <language>', 'language for the draft').option('--channels <csv>', 'comma-separated: all (default), email, call, linkedin, whatsapp'))
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const started = await api.request(apiPath`/campaigns/${id}/content-preview`, { method: 'POST', body: {
        ...(o.instructions ? { instructions: o.instructions } : {}),
        ...(o.style ? { selected_style: o.style } : {}),
        ...(o.language ? { language: o.language } : {}),
        ...(o.channels ? { channels: csv(o.channels) } : {}),
      } });
      if (!o.wait) { emit(this, started); return; }
      emitWaited(this, await waitUntil(
        () => api.request(apiPath`/campaigns/${id}/content-preview/status`) as Promise<{ status?: string }>,
        finishedAfterStart<{ status?: string }>(status => isRunningStatus(status.status)), waitSettings(o),
        { id, check: `avair campaigns content preview ${id}` },
      ), `avair campaigns content preview ${id}`);
    });
  content.command('preview <id>').description('Show the draft made by content regenerate').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/content-preview`)); });
  content.command('apply <id>').description('Replace the campaign content with the draft').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/content-preview/apply`, { method: 'POST' })); });
  content.command('discard <id>').description('Throw away the draft (needs --yes)').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/content-preview`, { method: 'DELETE' })); });

  // A/B tests are read-only for agents (v1): set up, start, choose a winner and end in the app.
  const ab = campaigns.command('ab').description('A/B tests of email steps and their results (set up, start and choose a winner in the Avair app)');
  ab.command('list <id>').description('List the A/B tests of the campaign, newest first, with their results').action(async function (this: Command, id: string) {
    emit(this, await client(this).request(apiPath`/campaigns/${id}/ab-tests`));
  });
  ab.command('show <testId>').description('Show one A/B test: its versions, reply rate per version, chance to be best and the badge').action(async function (this: Command, testId: string) {
    emit(this, await client(this).request(apiPath`/ab-tests/${testId}`));
  });

  const targets = campaigns.command('targets').description('Target accounts and job titles');
  targets.command('show <id>').description('Show the target accounts and titles').action(async function (this: Command, id: string) { emit(this, await readCampaign(this, id)); });
  targets.command('edit <id>').description('Replace the target accounts and titles from a JSON file').requiredOption('--input <file>', 'JSON with accounts_json and titles_json')
    .action(async function (this: Command, id: string, o) {
      const body = await readJsonFile(o.input) as Record<string, unknown>;
      if (!body || !('accounts_json' in body) || !('titles_json' in body)) throw new CliError('The file needs accounts_json and titles_json.', 2);
      emit(this, await client(this).request(apiPath`/campaigns/${id}/targets`, { method: 'PUT', body }));
    });
  targets.command('find-more <id>').description('Look for more target accounts').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/find-more-accounts`, { method: 'POST' })); });
  addWaitOptions(targets.command('approve <id>').description('Approve targets and generate contacts'))
    .action(async function (this: Command, id: string, o) {
      await stepThenWait(this, id, o, () => client(this).request(apiPath`/campaigns/${id}/generate-contacts`, { method: 'POST' }));
    });

  const assess = campaigns.command('assess').description('Score a step against the campaign ICP and guidance, and apply the fixes');
  assess.command('run <id>').description('Score one step, or every step that has data, and list what to fix')
    .option('--step <step>', 'messaging, content, targets or contacts; default: every step that has data')
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const steps = o.step ? [assessStep(o.step)] : assessSteps;
      const results = await assessEach(steps, async step => {
        try {
          return assessmentOutput(await api.request(apiPath`/campaigns/${id}/step-assessments/${step}`, {
            method: 'POST', body: { ai: true }, timeoutMs: ASSESS_TIMEOUT_MS,
          }) as Assessment);
        } catch (error) {
          // A step with no data yet is skipped when every step was asked for.
          if (!o.step && error instanceof CliError && error.details?.code === 'step_not_ready') return null;
          throw error;
        }
      });
      emit(this, o.step ? results[0] : results);
    });
  assess.command('apply <id>').description('Apply the fixes: all of a step (assessed now), or the ones named from a saved result. Asks first when a fix redoes later steps (needs --yes without a terminal)')
    .requiredOption('--step <step>', 'messaging, content, targets or contacts')
    .option('--input <file>', 'a result saved from avair campaigns assess --json, with --finding')
    .option('--finding <ids>', 'comma-separated suggestion ids from --input; default: apply all')
    .action(async function (this: Command, id: string, o) {
      const step = assessStep(o.step);
      if (o.finding && !o.input) throw new CliError('--finding needs --input with a saved assessment.', 2, { code: 'invalid_input' });
      const suggestions = o.finding ? pickSuggestions(await readJsonFile(o.input), csv(o.finding)) : null;
      const send = (confirmed: boolean, chosen = suggestions) => client(this).request(apiPath`/campaigns/${id}/step-assessments/${step}/apply`, {
        method: 'POST', body: { suggestions: chosen, confirmed }, timeoutMs: ASSESS_TIMEOUT_MS,
      });
      try {
        emit(this, await send(false));
      } catch (error) {
        if (!(error instanceof CliError) || error.details?.code !== 'needs_confirmation') throw error;
        await requireConfirmation(this, error.message);
        // Apply all: send back the fixes the question was about, so the server
        // does not assess again and apply something else (F30).
        emit(this, await send(true, suggestions ?? error.details.suggestions ?? null));
      }
    });

  const contacts = campaigns.command('contacts').description('Contacts of one campaign');
  for (const name of ['show', 'list']) {
    contacts.command(`${name} <id>`).description('List the contacts of the campaign').option('--limit <n>', 'how many rows to return', '100').option('--skip <n>', 'rows to skip', '0')
      .action(async function (this: Command, id: string, o) {
        emit(this, await client(this).request(apiPath`/campaigns/${id}/contacts/display`, { query: { limit: toInt(o.limit, '--limit'), skip: toInt(o.skip, '--skip') } }));
      });
  }
  contacts.command('import-preview <id>').requiredOption('--file <csv>', 'a CSV with a header row. Needs an email column; optional: first name, last name (or one name column), phone, title, company, LinkedIn URL, website, industry. Header names are matched loosely, ignoring case')
    .description('Show the columns and row count of a CSV; nothing is sent, so it cannot see Do Not Contact rows or the contact limit (contacts add --wait reports those)')
    .action(async function (this: Command, _id: string, o) {
      let text: string;
      try { text = await readFile(o.file, 'utf8'); } catch { throw new CliError(`Cannot read file ${o.file}.`, 2); }
      emit(this, previewCsv(text));
    });
  addWaitOptions(contacts.command('add <id>').description('Upload a CSV of contacts into the campaign. With --wait, prints how many were added and which rows were left out, and why').requiredOption('--file <csv>', 'a CSV with a header row. Needs an email column; optional: first name, last name (or one name column), phone, title, company, LinkedIn URL, website, industry. Header names are matched loosely, ignoring case; rows without a valid email are skipped'))
    .action(async function (this: Command, id: string, o) {
      const form = await fileForm(o.file);
      const api = client(this);
      const upload = () => api.request(apiPath`/campaigns/${id}/upload-contacts`, { method: 'POST', form });
      if (!o.wait || globals(this).dryRun) { emit(this, await upload()); return; }
      // The upload's own activity entry is the result; the campaign's status
      // changes before that entry is written, so it is not waited on.
      const activity = async () => asEntries(await api.request(apiPath`/campaigns/${id}/activity-log`, { query: { limit: 20 } }));
      const before = (await activity())[0]?.id ?? null;
      const accepted = await upload() as { upload_id?: string } | null;
      let details: UploadDetails | null = null;
      await waitUntil(async () => (details = findUploadResult(await activity(), before, accepted?.upload_id)), found => found !== null,
        waitSettings(o), { id, check: `avair campaigns activity ${id}` });
      const summary = uploadSummary(id, details!, await readCampaign(this, id));
      emit(this, globals(this).json ? summary : uploadSummaryText(summary));
    });
  contacts.command('remove <id>').description('Remove contacts from the campaign (needs --yes)').requiredOption('--contact <ids>', 'comma-separated contact ids')
    .action(async function (this: Command, id: string, o) {
      const ids = csv(o.contact);
      if (!ids.length) throw new CliError('Give at least one id with --contact.', 2);
      await requireConfirmation(this, `This removes ${ids.length} contact(s) from the campaign.`);
      // Confirmed once here: the server's own check must not ask again (F23).
      emit(this, await client(this).request(apiPath`/campaigns/${id}/contacts/delta`, {
        method: 'PATCH', body: { deleted_contact_ids: ids }, headers: { 'X-Avair-Confirm': 'yes' },
      }));
    });
  contacts.command('find-more <id>').description('Look for more contacts').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/find-more-contacts`, { method: 'POST' })); });
  contacts.command('approve <id>').description('Finalize contacts (alias of campaigns finalize)')
    .action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/finalize`, { method: 'POST' })); });
  addWaitOptions(contacts.command('verify <id>').description('Check the contact emails before launch').option('--all', 'verify every contact, not only unverified ones'))
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const started = await api.request(apiPath`/email-verification/campaigns/${id}/start`, {
        method: 'POST', query: o.all ? undefined : { verify_mode: 'unverified_only' },
      });
      if (!o.wait) { emit(this, started); return; }
      emitWaited(this, await waitUntil(
        () => api.request(apiPath`/email-verification/campaigns/${id}/status`) as Promise<{ status?: string }>,
        finishedAfterStart<{ status?: string }>(status => isRunningStatus(status.status)), waitSettings(o),
        { id, check: `avair api GET /email-verification/campaigns/${id}/status` },
      ), `avair api GET /email-verification/campaigns/${id}/status`);
    });
  contacts.command('remove-unverified <id>').description('Remove contacts that failed the email check (needs --yes)').option('--no-red', 'keep RED contacts').option('--yellow', 'also remove YELLOW contacts')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/email-verification/campaigns/${id}/remove-unverified`, {
        method: 'POST', body: { remove_red: Boolean(o.red), remove_yellow: Boolean(o.yellow) },
      }));
    });
  contacts.command('skip-verify <id>').description('Attest that contacts need no verification (needs --yes)')
    .action(async function (this: Command, id: string) {
      emit(this, await client(this).request(apiPath`/campaigns/${id}/skip-contact-verification`, { method: 'POST' }));
    });

  const phones = campaigns.command('phones').description('Phone number checks');
  phones.command('classify <id>').description('Classify each phone number from its TCPA checks').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/phone-classification/campaigns/${id}/classify`, { method: 'POST' })); });
  phones.command('status <id>').description('Show the phone check results').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/phone-classification/campaigns/${id}/classification-results`)); });

  campaigns.command('finalize <id>').description('Finalize the contacts step').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/finalize`, { method: 'POST' })); });
  campaigns.command('overview').description('The campaign overview').command('confirm <id>').description('Confirm the campaign overview').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/confirm-overview`, { method: 'POST' })); });

  const mailboxes = campaigns.command('mailboxes').description('Mailboxes that send the campaign');
  mailboxes.command('list <id>').description('List the mailboxes for this campaign').action(async function (this: Command, id: string) {
    const readiness = await client(this).request(apiPath`/campaigns/${id}/launch-readiness`) as { mailboxes?: unknown };
    emit(this, readiness.mailboxes ?? readiness);
  });
  mailboxes.command('set <id>').description('Choose the mailboxes for this campaign').requiredOption('--mailbox <ids>', 'comma-separated mailbox ids')
    .option('--warmup', 'enable warmup on these mailboxes').option('--campaign-version <n>', 'the campaign version you read')
    .action(async function (this: Command, id: string, o) {
      const ids = csv(o.mailbox);
      if (!ids.length) throw new CliError('Give at least one id with --mailbox.', 2);
      emit(this, await client(this).request(apiPath`/campaigns/${id}/mailbox-selection`, { method: 'POST', body: {
        mode: 'MANUAL', expected_version: await campaignVersion(this, id, o.campaignVersion),
        assignments: ids.map(mailbox_id => ({ mailbox_id, enable_warmup: Boolean(o.warmup) })),
      } }));
    });
  campaigns.command('whatsapp-numbers').description('WhatsApp numbers for the campaign').command('set <id>').description('Set the WhatsApp numbers from a JSON file').requiredOption('--input <file>', 'JSON body for the WhatsApp numbers')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/campaigns/${id}/whatsapp-numbers`, { method: 'PUT', body: await readJsonFile(o.input) }));
    });

  campaigns.command('prepare <id>').description('Build the campaign up to launchable (same as build --stop-at launchable)').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/agent-build`, { method: 'POST', body: { stop_at: 'launchable' } })); });
  campaigns.command('readiness <id>').description('Show what blocks launch, with the launch score verdict and its must-fix items').action(async function (this: Command, id: string) {
    const api = client(this);
    const [readiness, score] = await Promise.all([api.request(apiPath`/campaigns/${id}/launch-readiness`), launchScore(api, id)]);
    emit(this, { ...(readiness as Record<string, unknown>), verdict: score?.verdict ?? null, must_fix: score?.must_fix ?? null });
  });
  campaigns.command('launch <id>').description('Start sending the campaign (needs --yes). Lists open must-fix items first').action(async function (this: Command, id: string) {
    const g = globals(this);
    const api = client(this);
    // Show, then confirm (CLI plan C1, Q3): the browser asks once while a
    // must-fix item is open; the CLI names them before the same question.
    const mustFix = g.dryRun ? [] : (await launchScore(api, id))?.must_fix ?? [];
    if (mustFix.length && !g.yes) {
      const list = mustFix.map(item => `${item.id}: ${item.message}`).join(' ');
      if (!g.input) throw new CliError(`Open must-fix items: ${list} Re-run with --yes to launch anyway.`, 4, { code: 'confirmation_required' });
      process.stderr.write(`Open must-fix items:\n${mustFix.map(item => `  ${item.id}: ${item.message}`).join('\n')}\n`);
    }
    const started = await api.request(apiPath`/campaigns/${id}/start`, { method: 'POST' });
    emit(this, mustFix.length && started && typeof started === 'object' ? { ...(started as Record<string, unknown>), must_fix: mustFix } : started);
  });
  campaigns.command('test <id>').description('Run a test of the campaign (needs --yes)')
    .option('--quick', 'quick test, 2 touches (default)').option('--full', 'full test: every step of the sequence, 5 minutes apart').option('--type <type>', 'quick or full')
    .action(async function (this: Command, id: string, o) { emit(this, await client(this).request(apiPath`/campaigns/${id}/test`, { method: 'POST', body: { test_type: testType(o) } })); });
  // No `archive`: the coverage matrix keeps it out of R1 until the app has an archive control.
  const lifecycle = {
    pause: 'Pause a running campaign',
    resume: 'Resume a paused campaign (needs --yes)',
    cancel: 'Cancel the campaign (needs --yes)',
    copy: 'Copy the campaign as a new draft with the same content and no accounts or contacts',
  } as const;
  for (const name of ['pause', 'resume', 'cancel', 'copy'] as const) {
    campaigns.command(`${name} <id>`).description(lifecycle[name]).action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/${name}`, { method: 'POST' })); });
  }
  campaigns.command('delete <id>').description('Delete a draft (needs --yes)')
    .action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}`, { method: 'DELETE' })); });
  addWaitOptions(campaigns.command('retry <id>').description('Retry a failed generation'))
    .action(async function (this: Command, id: string, o) {
      await stepThenWait(this, id, o, () => client(this).request(apiPath`/campaigns/${id}/retry-generation`, { method: 'POST' }));
    });

  // No `disable`: the app has no unshare control, so agents do not get one (coverage matrix).
  const share = campaigns.command('share').description("The campaign's voice-agent share page");
  share.command('enable <id>').description('Turn on the share page').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/agent/share`, { method: 'POST' })); });
  share.command('status <id>').description('Show the share page status').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/campaigns/${id}/agent/share-status`)); });

  campaigns.command('download <id>').description('Download the campaign as a ZIP file').option('-o, --output <file>', 'where to write the ZIP').option('--platforms <csv>', 'comma-separated platform folders to include')
    .action(async function (this: Command, id: string, o) {
      await download(this, apiPath`/campaigns/${id}/download`, o.output, { platforms: o.platforms });
    });
  campaigns.command('activity <id>').description('Show recent campaign activity and agent actions').option('--limit <n>', 'how many rows to return', '50')
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const limit = toInt(o.limit, '--limit');
      emit(this, {
        activity: await api.request(apiPath`/campaigns/${id}/activity-log`, { query: { limit } }),
        // The agent-actions page holds at most 100 rows (F16).
        agent_actions: await api.request(apiPath`/campaigns/${id}/agent-actions`, { query: { size: limit === undefined ? undefined : Math.min(limit, 100) } }),
      });
    });
}

