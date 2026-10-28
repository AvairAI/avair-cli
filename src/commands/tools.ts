import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import { confirmAction } from '../lib/confirm.js';
import { idempotencyKey } from '../lib/idempotency.js';
import { addWaitOptions, isRunningStatus, waitSettings, waitUntil } from '../lib/wait.js';
import { client, download, emit, emitWaited, globals, pageSize, toInt } from './shared.js';
import { apiPath } from '../lib/path.js';

const prices = { 'find-accounts': 5, 'find-contacts': 2, 'enrich-contacts': 1, 'phone-tcpa-check': 2 } as const;
const toolSummaries: Record<keyof typeof prices, string> = {
  'find-accounts': 'Find target accounts from a website (reserves 5 credits per requested account; charges 5 per trigger account, 2 per baseline account)',
  'find-contacts': 'Find contacts at one account (2 credits per contact)',
  'enrich-contacts': 'Fill in the details of one contact (1 credit)',
  'phone-tcpa-check': 'Check a phone number for line type, Do Not Call lists, litigators and complainers (2 credits)',
};
type ToolName = keyof typeof prices;
const csv = (value?: string) => value?.split(',').map(item => item.trim()).filter(Boolean) || [];
const aliases: Partial<Record<ToolName, string>> = { 'enrich-contacts': 'enrich', 'phone-tcpa-check': 'phone-check' };

/** What a cancel does and does not promise (AC11). */
export const CANCEL_NOTE = 'Future work is stopped. Provider work already accepted may still finish and be charged. No refund is promised.';

async function cancelRun(command: Command, id: string): Promise<void> {
  const run = await client(command).request(apiPath`/tools/runs/${id}/cancel`, { method: 'POST' }) as Record<string, unknown>;
  emit(command, { ...run, note: CANCEL_NOTE });
}

/**
 * A count the person asked for. Below 1 or not a whole number is refused, not
 * quietly raised: `--cap 0` used to become 1 and start a paid run (AVI-1140
 * E2E, 2026-10-07). Above the plan's maximum is still lowered, with a note.
 */
function askedCount(value: unknown, flag: string, fallback: number): number {
  const asked = toInt(value === undefined ? undefined : String(value), flag) ?? fallback;
  if (asked < 1) throw new CliError(`${flag} must be at least 1.`, 2, { code: 'invalid_input' });
  return asked;
}

function quote(tool: ToolName, options: Record<string, unknown>, trial = false): Record<string, unknown> {
  if (tool === 'find-accounts') {
    const asked = askedCount(options.cap, '--cap', 10);
    const cap = Math.min(asked, trial ? 5 : 40);
    return { reserves_up_to_credits: cap * prices[tool], requested_account_cap: cap, ...(cap !== asked ? { adjusted: `Account cap adjusted from ${asked} to ${cap}.` } : {}) };
  }
  if (tool === 'find-contacts') {
    const asked = askedCount(options.depth, '--depth', 15);
    const depth = Math.min(asked, trial ? 5 : 15);
    return { reserves_up_to_credits: depth * prices[tool], max_contacts_per_account: depth, ...(depth !== asked ? { adjusted: `Search depth adjusted from ${asked} to ${depth}.` } : {}) };
  }
  return { reserves_up_to_credits: prices[tool] };
}

function body(tool: ToolName, o: Record<string, unknown>, proposal: Record<string, unknown>): unknown {
  if (tool === 'find-accounts') return {
    company_website: o.website, requested_account_cap: proposal.requested_account_cap,
    industries: csv(o.industries as string), company_sizes: csv(o.sizes as string), locations: csv(o.locations as string),
  };
  if (tool === 'find-contacts') return {
    input_mode: 'PLAYGROUND', account: { account_name: o.account, domain: o.domain || undefined },
    titles: csv(o.titles as string), max_contacts_per_account: proposal.max_contacts_per_account,
  };
  if (tool === 'enrich-contacts') return { input_mode: 'PLAYGROUND', contact: {
    first_name: o.firstName, last_name: o.lastName, email: o.email, company: o.company,
    domain: o.domain, linkedin_url: o.linkedin,
  } };
  return { input_mode: 'PLAYGROUND', phone_number: o.phone };
}

function addToolOptions(command: Command, tool: ToolName): Command {
  command.option('--idempotency-key <key>', 'a retry with the same key and the same request returns the same run, not a second one; default: a new random key each run');
  if (tool === 'find-accounts') command.requiredOption('--website <url>', 'your company website, used to find matching accounts')
    .option('--cap <n>', 'most accounts to find (up to 40; 5 on a trial)', '10')
    .option('--industries <csv>', 'comma-separated industries to look in').option('--sizes <csv>', 'comma-separated company sizes').option('--locations <csv>', 'comma-separated places');
  if (tool === 'find-contacts') command.requiredOption('--account <name>', 'the company name').requiredOption('--titles <csv>', 'comma-separated job titles to look for')
    .option('--domain <domain>', 'the company web domain').option('--depth <n>', 'most contacts to find for the account (up to 15; 5 on a trial)', '15');
  if (tool === 'enrich-contacts') command.requiredOption('--company <name>', 'the company name').option('--first-name <name>', 'the contact first name').option('--last-name <name>', 'the contact last name')
    .option('--email <email>', 'the contact email').option('--domain <domain>', 'the company web domain').option('--linkedin <url>', 'the contact LinkedIn profile URL');
  if (tool === 'phone-tcpa-check') command.requiredOption('--phone <number>', 'the phone number to check');
  return command;
}

export function registerTools(program: Command): void {
  const tools = program.command('tools').description('Quote and run Avair data tools');
  for (const name of ['credits', 'balance']) {
    tools.command(name).description('Show your Tools credit balance').action(async function (this: Command) { emit(this, await client(this).request('/tools/credits')); });
  }
  const listRuns = async function (this: Command, o: { toolType?: string; status?: string; limit?: string; mine?: boolean }) {
    // The server matches the stored name exactly: find-accounts is FIND_ACCOUNTS (F20).
    const toolType = o.toolType?.trim().toUpperCase().replaceAll('-', '_');
    emit(this, await client(this).request('/tools/runs', { query: { tool_type: toolType, status: o.status, limit: pageSize(o.limit, '--limit', 50, 20), mine: o.mine ? true : undefined } }));
  };
  const runs = tools.command('runs').description('Tools runs: list, show, export, cancel');
  for (const group of [tools, runs]) {
    group.command('list').description('List Tools runs').option('--tool-type <type>', 'only runs of this tool').option('--status <status>', 'only runs with this status').option('--mine', 'only your own runs').option('--limit <n>', 'page size, at most 50', '20').action(listRuns);
  }
  for (const [group, name] of [[runs, 'show'], [tools, 'status']] as const) {
    group.command(`${name} <runId>`).description('Show one Tools run').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/tools/runs/${id}`)); });
  }
  tools.command('results <runId>').description('Show the results of a Tools run, a page at a time')
    .option('--offset <n>', 'rows to skip', '0').option('--limit <n>', 'rows per page, at most 100', '50').option('--all', 'read every page')
    .action(async function (this: Command, id: string, o) {
      // The server gives 50 rows unless asked; without paging the rest stayed out of reach (F33).
      const limit = Math.min(toInt(o.limit, '--limit') ?? 50, 100);
      const offset = toInt(o.offset, '--offset') ?? 0;
      if (limit < 1 || offset < 0) throw new CliError('--limit must be at least 1 and --offset at least 0.', 2, { code: 'invalid_input' });
      type Page = { items?: unknown[]; next_offset?: number | null };
      const read = (from: number) => client(this).request(apiPath`/tools/runs/${id}/items`, { query: { offset: from, limit } }) as Promise<Page>;
      let page = await read(offset);
      if (o.all) {
        const items = [...(page.items ?? [])];
        let from = offset;
        while (typeof page.next_offset === 'number' && page.next_offset > from) {
          from = page.next_offset;
          page = await read(from);
          items.push(...(page.items ?? []));
        }
        page = { ...page, items, next_offset: null };
      }
      emit(this, page);
      if (!globals(this).json && typeof page?.next_offset === 'number') {
        process.stderr.write(`More results: avair tools results ${id} --offset ${page.next_offset}\n`);
      }
    });
  runs.command('export <runId>').description('Download the results of a run as a CSV file').option('-o, --output <file>', 'where to write the CSV')
    .action(async function (this: Command, id: string, o) { await download(this, apiPath`/tools/runs/${id}/download`, o.output); });
  for (const group of [tools, runs]) {
    group.command('cancel <runId>').description('Stop future work of a Tools run').action(async function (this: Command, id: string) { await cancelRun(this, id); });
  }

  for (const tool of Object.keys(prices) as ToolName[]) {
    const group = tools.command(tool).description(toolSummaries[tool]);
    if (aliases[tool]) group.alias(aliases[tool]!);
    addToolOptions(group.command('quote').description('Show the credit cost without starting a run'), tool).action(async function (this: Command, o) {
      quote(tool, o);  // a bad count stops here, before any request
      const identity = await client(this).request('/agent-access/whoami') as { tenant?: { is_trial?: boolean } };
      emit(this, quote(tool, o, Boolean(identity.tenant?.is_trial)));
    });
    addWaitOptions(addToolOptions(group.command('start').description('Start a run and reserve its credits (needs --yes)'), tool)).action(async function (this: Command, o) {
      quote(tool, o);  // a bad count stops here, before any request
      const api = client(this);
      const identity = await api.request('/agent-access/whoami') as { tenant?: { is_trial?: boolean } };
      const proposal = quote(tool, o, Boolean(identity.tenant?.is_trial));
      const g = globals(this);
      if (!g.yes && !g.dryRun && (!g.input || !await confirmAction(`This run may reserve ${proposal.reserves_up_to_credits} credits. Continue?`))) {
        throw new CliError(`This run may reserve ${proposal.reserves_up_to_credits} credits. Re-run with --yes to confirm.`, 4, { code: 'confirmation_required' });
      }
      const run = await client(this).request(apiPath`/tools/${tool}/runs`, {
        method: 'POST', body: body(tool, o, proposal), retryWrite: true,
        headers: { 'Idempotency-Key': idempotencyKey(o.idempotencyKey), 'X-Avair-Confirm': 'yes' },
      }) as { id?: string; status?: string };
      if (!o.wait || !run?.id) { emit(this, run); return; }
      const id = run.id;
      emitWaited(this, await waitUntil(
        () => client(this).request(apiPath`/tools/runs/${id}`) as Promise<{ status?: string }>,
        current => !isRunningStatus(current.status), waitSettings(o), { id, check: `avair tools runs show ${id}` },
      ), `avair tools runs show ${id}`);
    });
  }
}
