import { Command, Option } from 'commander';

import { registerAuth } from './commands/auth.js';
import { registerAccount } from './commands/account.js';
import { registerCampaigns } from './commands/campaigns.js';
import { registerCompanies } from './commands/companies.js';
import { registerContacts } from './commands/contacts.js';
import { registerPlaybooks } from './commands/playbooks.js';
import { registerMisc } from './commands/misc.js';
import { registerResources } from './commands/resources.js';
import { registerTools } from './commands/tools.js';
import { CliError, ownerChoiceLines } from './lib/errors.js';
import { addHelpExamples } from './lib/helpExamples.js';
import { CLI_VERSION } from './version.js';

// For scripts/build-agent-docs.mjs: the docs site's command reference.
export { renderCommandReference } from './lib/reference.js';

export function createProgram(): Command {
  const program = new Command();
  program.name('avair').description('Avair command-line client').version(CLI_VERSION)
    .option('--json', 'print stable JSON only')
    .option('--no-input', 'never prompt or open a browser')
    .option('-y, --yes', 'confirm live and credit-spending actions')
    .option('--dry-run', 'show what would happen without sending requests or changing anything on this computer')
    // Our own team's switches for test and local servers. They work, but the
    // help customers see does not show them: a customer has one Avair (AVI-1157).
    .addOption(new Option('--env <environment>', 'internal: the Avair environment to use').hideHelp())
    .addOption(new Option('--api-url <url>', 'internal: the Avair API address to use').hideHelp())
    .option('--debug', 'print request diagnostics')
    // Before the commands are added: each one copies this, so `--yes` and the
    // other global options show in every command's help.
    .configureHelp({ showGlobalOptions: true });
  registerAuth(program);
  registerAccount(program);
  registerCampaigns(program);
  registerContacts(program);
  registerResources(program);
  registerCompanies(program);
  registerPlaybooks(program);
  registerTools(program);
  registerMisc(program);
  addHelpExamples(program);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const cli = error instanceof CliError ? error : new CliError((error as Error).message, 1);
    const json = argv.includes('--json');
    const body = { error: { code: cli.details.code || 'cli_error', message: cli.message, hint: cli.details.hint, request_id: cli.details.request_id, app_url: cli.details.app_url, blocking_steps: cli.details.blocking_steps, choices: cli.details.choices } };
    const steps = cli.details.blocking_steps?.length ? `\nBlocking steps: ${cli.details.blocking_steps.join(', ')}` : '';
    const choices = cli.details.choices?.length ? ownerChoiceLines(cli.details.choices) : '';
    process.stderr.write(json ? `${JSON.stringify(body)}\n` : `Error: ${cli.message}${steps}${choices}\n`);
    process.exitCode = cli.exitCode;
  }
}

if (process.env.VITEST !== 'true') void main();
