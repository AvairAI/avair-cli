import { Command } from 'commander';

import { bulkFailure, notTried, runBulk } from '../lib/bulk.js';
import { CliError } from '../lib/errors.js';
import { addWaitOptions, finishedAfterStart, isRunningStatus, waitSettings, waitUntil, WORKER_QUIET_MS } from '../lib/wait.js';
import { client, csv, emit, emitWaited, globals, toInt } from './shared.js';
import { apiPath } from '../lib/path.js';

type Playbook = { id?: string; items?: Array<{ id: string; state?: string }> };

/** The item states the server builds from (playbook_execution_service.build_item_now). */
export const BUILDABLE_STATES = new Set(['PROPOSED', 'ACCEPTED']);

const base = (id: string) => apiPath`/playbooks/${id}`;

function waitForPlaybook(command: Command, id: string, o: { timeout?: string }) {
  return waitUntil(
    () => client(command).request(apiPath`/playbooks/${id}/status`) as Promise<{ status?: string }>,
    // The worker sets ANALYZING after the request returns.
    finishedAfterStart<{ status?: string }>(status => isRunningStatus(status.status), WORKER_QUIET_MS), waitSettings(o), { id, check: `avair playbooks status ${id}` },
  );
}

function optionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliError(`${flag} must be a number.`, 2);
  return number;
}

export function registerPlaybooks(program: Command): void {
  const playbooks = program.command('playbooks').description('Plan, build and run playbooks');
  playbooks.command('list').description('List playbooks').action(async function (this: Command) { emit(this, await client(this).request('/playbooks')); });
  playbooks.command('show <id>').description('Show one playbook').action(async function (this: Command, id: string) { emit(this, await client(this).request(base(id))); });
  playbooks.command('status <id>').description('Show the analysis status of a playbook').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/playbooks/${id}/status`)); });

  addWaitOptions(playbooks.command('create').description('Create a playbook from a website')
    .requiredOption('--website <url>', 'the company website to plan from')
    .option('--revenue <amount>', 'annual revenue goal').option('--deal-size <amount>', 'average deal size')
    .option('--icp-notes <text>', 'notes about the ideal customer').option('--no-analyze', 'create without starting the analysis'))
    .action(async function (this: Command, o) {
      const created = await client(this).request('/playbooks', { method: 'POST', body: {
        website_url: o.website, analyze_now: o.analyze !== false,
        ...(o.revenue !== undefined ? { goal_annual_revenue: optionalNumber(o.revenue, '--revenue') } : {}),
        ...(o.dealSize !== undefined ? { goal_average_deal_size: optionalNumber(o.dealSize, '--deal-size') } : {}),
        ...(o.icpNotes ? { icp_notes: o.icpNotes } : {}),
      } }) as Playbook;
      if (!o.wait || !created?.id) { emit(this, created); return; }
      emitWaited(this, await waitForPlaybook(this, created.id, o), `avair playbooks status ${created.id}`);
    });
  addWaitOptions(playbooks.command('analyze <id>').description('Start the analysis of a playbook')).action(async function (this: Command, id: string, o) {
    const started = await client(this).request(apiPath`/playbooks/${id}/analyze`, { method: 'POST' });
    if (o.wait) emitWaited(this, await waitForPlaybook(this, id, o), `avair playbooks status ${id}`); else emit(this, started);
  });
  addWaitOptions(playbooks.command('refine <id>').description('Change the plan with written instructions, or size it to the goal').option('--text <instructions>', 'what to change in the plan').option('--size-to-goal', 'size the plan to the goal (instead of --text)'))
    .action(async function (this: Command, id: string, o) {
      // The server takes one or the other, never both (F29).
      if (Boolean(o.text) === Boolean(o.sizeToGoal)) throw new CliError('Give either --text or --size-to-goal.', 2, { code: 'invalid_input' });
      const started = await client(this).request(apiPath`/playbooks/${id}/refine`, {
        method: 'POST', body: o.sizeToGoal ? { size_to_goal: true } : { user_input: o.text },
      });
      if (o.wait) emitWaited(this, await waitForPlaybook(this, id, o), `avair playbooks status ${id}`); else emit(this, started);
    });

  const goal = playbooks.command('goal').description('The revenue goal of the playbook');
  goal.command('show <id>').description('Show the revenue goal').action(async function (this: Command, id: string) {
    const playbook = await client(this).request(base(id)) as Record<string, unknown>;
    emit(this, Object.fromEntries(Object.entries(playbook).filter(([key]) => key.startsWith('goal'))));
  });
  goal.command('set <id>').description('Set the revenue goal and the funnel it needs')
    .requiredOption('--revenue <amount>', 'annual revenue goal').requiredOption('--deal-size <amount>', 'average deal size')
    .option('--rates <mql,opportunity,proposal>', 'your own funnel rates, as three percentages')
    .action(async function (this: Command, id: string, o) {
      const given = o.rates ? csv(o.rates).map(rate => optionalNumber(rate, '--rates')) : undefined;
      if (given && given.length !== 3) throw new CliError('--rates needs three numbers.', 2);
      const api = client(this);
      // The goal is one complete snapshot: without --rates the saved rates go
      // back, as the Goal tab sends them, and the server applies its own
      // benchmark for the deal size (F4).
      let rates: unknown[] = given ?? [];
      if (!given) {
        const saved = ((await api.request(base(id))) as { goal?: Record<string, unknown> } | null)?.goal ?? {};
        rates = ['mql_to_opportunity_rate', 'opportunity_to_proposal_rate', 'proposal_to_close_rate'].map(key => saved[key]);
        if (globals(this).dryRun) rates = rates.map(rate => rate ?? '<saved rate>');
        else if (!rates.every(rate => typeof rate === 'number')) {
          throw new CliError('Could not read the saved funnel rates. Pass --rates <mql,opportunity,proposal>.', 1, { code: 'goal_rates_missing' });
        }
      }
      emit(this, await api.request(apiPath`/playbooks/${id}/goal`, { method: 'PUT', body: {
        annual_revenue: optionalNumber(o.revenue, '--revenue'), average_deal_size: optionalNumber(o.dealSize, '--deal-size'),
        uses_custom_rates: Boolean(given),
        mql_to_opportunity_rate: rates[0], opportunity_to_proposal_rate: rates[1], proposal_to_close_rate: rates[2],
      } }));
    });

  playbooks.command('pace').description('How many campaigns each person runs').command('set <id>').description('Set the pace for the team').option('--per-person <n>', 'campaigns per person per period').option('--auto', 'let the plan set each person\'s pace')
    .action(async function (this: Command, id: string, o) {
      if (Boolean(o.perPerson) === Boolean(o.auto)) throw new CliError('Give --per-person <n> or --auto.', 2);
      emit(this, await client(this).request(apiPath`/playbooks/${id}/pace`, { method: 'PUT', body: { pace_per_person: o.auto ? null : toInt(o.perPerson, '--per-person') } }));
    });

  const team = playbooks.command('team').description('The people who run the playbook');
  team.command('list <id>').description('List the people').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/playbooks/${id}/team`)); });
  team.command('add <id>').description('Add a person').requiredOption('--name <name>', 'the name of the person').action(async function (this: Command, id: string, o) {
    emit(this, await client(this).request(apiPath`/playbooks/${id}/team`, { method: 'POST', body: { name: o.name } }));
  });
  team.command('rename <id> <participantId>').description('Rename a person').requiredOption('--name <name>', 'the new name').action(async function (this: Command, id: string, participantId: string, o) {
    emit(this, await client(this).request(apiPath`/playbooks/${id}/team/${participantId}`, { method: 'PATCH', body: { name: o.name } }));
  });
  team.command('runs <id> <participantId>').description('Set whether this person runs campaigns')
    .option('--on', 'this person runs campaigns').option('--off', 'this person does not run campaigns').option('--check', 'show the effect without saving')
    .action(async function (this: Command, id: string, participantId: string, o) {
      if (Boolean(o.on) === Boolean(o.off)) throw new CliError('Give --on or --off.', 2);
      emit(this, await client(this).request(apiPath`/playbooks/${id}/team/${participantId}`, {
        // The route needs dry_run on every request, a save included (F4).
        method: 'PUT', body: { runs_campaigns: Boolean(o.on) }, query: { dry_run: Boolean(o.check) },
      }));
    });

  const items = playbooks.command('items').description('The items of the plan, one campaign each');
  items.command('list <id>').description('List the items').action(async function (this: Command, id: string) {
    emit(this, ((await client(this).request(base(id))) as Playbook).items ?? []);
  });
  items.command('set <id> <itemId>').description('Change the state, priority or owner of an item')
    .option('--state <state>', 'the new state').option('--priority <n>', 'the new priority number').option('--assign <participantId>', 'the person who owns the item')
    .action(async function (this: Command, id: string, itemId: string, o) {
      const body = {
        ...(o.state ? { state: o.state } : {}),
        ...(o.priority !== undefined ? { priority: toInt(o.priority, '--priority') } : {}),
        ...(o.assign ? { assigned_participant_id: o.assign } : {}),
      };
      if (!Object.keys(body).length) throw new CliError('Give --state, --priority, or --assign.', 2);
      emit(this, await client(this).request(apiPath`/playbooks/${id}/items/${itemId}`, { method: 'PATCH', body }));
    });
  items.command('bulk-state <id>').description('Set the same state on several items')
    .requiredOption('--items <ids>', 'comma-separated item ids').requiredOption('--state <state>', 'the new state')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/playbooks/${id}/items/bulk`, { method: 'POST', body: { item_ids: csv(o.items), state: o.state } }));
    });
  items.command('build <id> <itemId>').description('Build one campaign from the plan (needs --yes)')
    .option('--owner <userId>', "who owns it: the row's assigned user or you (asked when both can)")
    .option('--no-live-search', 'skip Find More Live: keep the database contacts; run it later from the campaign')
    .action(async function (this: Command, id: string, itemId: string, o) {
      const body = { ...(o.owner ? { owner_user_id: o.owner } : {}), ...(o.liveSearch === false ? { live_contact_search: false } : {}) };
      emit(this, await client(this).request(apiPath`/playbooks/${id}/items/${itemId}/build`, { method: 'POST', ...(Object.keys(body).length ? { body } : {}) }));
    });
  items.command('cancel <id> <itemId>').description('Cancel an item').action(async function (this: Command, id: string, itemId: string) {
    emit(this, await client(this).request(apiPath`/playbooks/${id}/items/${itemId}/cancel`, { method: 'POST' }));
  });

  playbooks.command('build-all <id>').description('Build every proposed or accepted item (needs --yes)')
    .action(async function (this: Command, id: string) {
      const api = client(this);
      const playbook = await api.request(base(id)) as Playbook;
      const ids = (playbook.items ?? []).filter(item => BUILDABLE_STATES.has(String(item.state))).map(item => item.id);
      const g = globals(this);
      const run = await runBulk(ids, itemId => api.request(apiPath`/playbooks/${id}/items/${itemId}/build`, { method: 'POST' }), {
        minIntervalMs: 1000,
        onWait: seconds => { if (!g.json) process.stderr.write(`Rate limited; waiting ${seconds}s before trying again.\n`); },
      });
      // The stopping refusal's message is printed once, by the error below;
      // the report names only the item and the code.
      emit(this, {
        built: run.results.filter(item => item.ok).length,
        total: ids.length,
        ...(run.stopped ? {
          stopped: { at: run.stopped.at, code: run.stopped.error.details.code },
          not_tried: notTried(run, ids.length),
        } : {}),
        results: run.results,
      });
      const failure = bulkFailure(run, ids.length);
      if (failure) throw failure;
    });

  const versions = playbooks.command('versions').description('Saved versions of the plan');
  versions.command('list <id>').description('List the versions').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/playbooks/${id}/versions`)); });
  versions.command('restore <id> <versionId>').description('Restore an earlier version of the plan').action(async function (this: Command, id: string, versionId: string) {
    emit(this, await client(this).request(apiPath`/playbooks/${id}/versions/${versionId}/restore`, { method: 'POST' }));
  });

  const automation = playbooks.command('automation').description('Playbook Automation: build, or build and execute, on a schedule');
  automation.command('on <id>').option('--execute', 'build and launch (default: build only)')
    .description('Turn automation on (needs --yes)')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/playbooks/${id}/automation`, { method: 'PUT', body: { mode: o.execute ? 'BUILD_AND_EXECUTE' : 'BUILD_ONLY' } }));
    });
  automation.command('off <id>').description('Turn automation off (no --yes needed)')
    .action(async function (this: Command, id: string) {
      emit(this, await client(this).request(apiPath`/playbooks/${id}/automation`, { method: 'PUT', body: { mode: 'OFF' } }));
    });
  automation.command('check <id>').option('--execute', 'check build and launch, not only build').description('What would block automation')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/playbooks/${id}/automation/preflight`, { query: { mode: o.execute ? 'BUILD_AND_EXECUTE' : 'BUILD_ONLY' } }));
    });
}

