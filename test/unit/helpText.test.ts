/**
 * AVI-1121 (PRD N2, AC17): every command's --help says what it needs and shows
 * at least one full example, and every example matches the real command.
 */
import { describe, expect, it } from 'vitest';
import type { Command, Option } from 'commander';

import { createProgram } from '../../src/index.js';
import { commandPath, HELP_EXAMPLES } from '../../src/lib/helpExamples.js';

const program = createProgram();

function all(command: Command): Command[] {
  return [command, ...command.commands.flatMap(all)];
}
const commands = all(program).filter(command => command !== program);
const leaves = commands.filter(command => command.commands.length === 0);
const byPath = new Map(commands.map(command => [commandPath(command), command]));

/** Split a shell line on spaces, keeping "double quoted" values whole. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
}

const findOption = (options: readonly Option[], flag: string) =>
  options.find(option => option.long === flag || option.short === flag);

/** Problems with one example line for `command`; empty when it is valid. */
function checkExample(command: Command, line: string): string[] {
  const path = commandPath(command);
  const problems: string[] = [];
  if (!line.startsWith(`avair ${path}`) || ![' ', undefined].includes(line[`avair ${path}`.length])) {
    return [`does not start with "avair ${path}"`];
  }
  const tokens = words(line).slice(1 + path.split(' ').length);
  const used = new Set<string>();
  let positionals = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) { positionals += 1; continue; }
    const [flag, inline] = token.split('=', 2);
    const option = findOption(command.options, flag) ?? findOption(program.options, flag);
    if (!option) { problems.push(`unknown flag ${flag}`); continue; }
    used.add(option.attributeName());
    if ((option.required || option.optional) && inline === undefined) {
      if (option.required && (index + 1 >= tokens.length || tokens[index + 1].startsWith('--'))) problems.push(`${flag} has no value`);
      else if (option.required || !tokens[index + 1]?.startsWith('-')) index += 1;
    }
  }
  const args = command.registeredArguments;
  const needed = args.filter(arg => arg.required).length;
  if (positionals < needed) problems.push(`gives ${positionals} of ${needed} required arguments`);
  if (!args.some(arg => arg.variadic) && positionals > args.length) problems.push(`gives ${positionals} arguments; the command takes ${args.length}`);
  for (const option of command.options.filter(option => option.mandatory)) {
    if (!used.has(option.attributeName())) problems.push(`leaves out required ${option.long}`);
  }
  return problems;
}

/** The lines under "Examples:" exactly as printed, without the two-space indent. */
function printedExamples(text: string): string[] {
  const after = text.split('\nExamples:\n')[1];
  if (after === undefined) return [];
  return after.split('\n').filter(line => line.trim()).map(line => (line.startsWith('  ') ? line.slice(2) : `(not indented) ${line}`));
}

/** The command a line runs: the longest command path it starts with. */
function commandFor(line: string): Command | undefined {
  const names = words(line).slice(1);
  for (let count = names.length; count > 0; count -= 1) {
    const command = byPath.get(names.slice(0, count).join(' '));
    if (command) return command;
  }
  return undefined;
}

function helpText(command: Command): string {
  let text = '';
  command.configureOutput({ writeOut: chunk => { text += chunk; }, writeErr: chunk => { text += chunk; } });
  command.outputHelp();
  return text;
}

describe('CLI help (AVI-1121)', () => {
  it('describes every command and group', () => {
    expect(commands.filter(command => !command.description()).map(commandPath)).toEqual([]);
  });

  it('describes every option', () => {
    const missing = [program, ...commands].flatMap(command =>
      command.options.filter(option => !option.description).map(option => `${commandPath(command) || 'avair'} ${option.long ?? option.short}`));
    expect(missing).toEqual([]);
  });

  it('gives every command at least one example', () => {
    expect(leaves.filter(command => !HELP_EXAMPLES[commandPath(command)]?.length).map(commandPath)).toEqual([]);
  });

  it('has examples only for real commands', () => {
    expect(Object.keys(HELP_EXAMPLES).filter(path => path !== '' && !byPath.has(path))).toEqual([]);
  });

  it('every help page, groups and avair itself included, prints examples a shell runs as copied', () => {
    const problems = [program, ...commands].flatMap(command => {
      const where = commandPath(command) || 'avair';
      const lines = printedExamples(helpText(command));
      if (!lines.length) return [`${where}: no examples`];
      return lines.flatMap(line => {
        if (!line.startsWith('avair ')) return [`${where}: "${line}" is not a command line`];
        const target = commandFor(line);
        return target ? checkExample(target, line).map(problem => `${where}: ${line}: ${problem}`) : [`${where}: ${line}: no such command`];
      });
    });
    expect(problems).toEqual([]);
  });

  it('every example uses the command as it is defined: path, arguments, flags, required options', () => {
    const problems = Object.entries(HELP_EXAMPLES).filter(([path]) => path !== '').flatMap(([path, lines]) => {
      const command = byPath.get(path);
      return command ? lines.flatMap(line => checkExample(command, line).map(problem => `${line}: ${problem}`)) : [];
    });
    expect(problems).toEqual([]);
  });

  it('the example checker itself catches a wrong example', () => {
    const build = byPath.get('campaigns build')!;
    expect(checkExample(build, 'avair campaigns build CAMPAIGN_ID')).toContain('leaves out required --stop-at');
    expect(checkExample(build, 'avair campaigns build CAMPAIGN_ID --stop-at targets --nope')).toContain('unknown flag --nope');
    const launch = byPath.get('campaigns launch')!;
    expect(checkExample(launch, 'avair campaigns launch --yes')).toContain('gives 0 of 1 required arguments');
    expect(checkExample(launch, 'avair campaigns launches CAMPAIGN_ID')).toEqual(['does not start with "avair campaigns launch"']);
    expect(checkExample(launch, 'avair campaigns launch CAMPAIGN_ID --yes')).toEqual([]);
  });

  it('holds no secrets or real addresses in examples (N10)', () => {
    const lines = Object.values(HELP_EXAMPLES).flat();
    expect(lines.filter(line => /av[pk]_|tak_|tpc_|sk_(live|test)|Bearer /i.test(line))).toEqual([]);
    const emails = lines.flatMap(line => line.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []);
    expect(emails.filter(email => !email.endsWith('@example.com'))).toEqual([]);
  });

  it.each([
    'campaigns launch', 'campaigns resume', 'campaigns cancel', 'campaigns test', 'campaigns delete',
    'campaigns contacts remove', 'campaigns contacts remove-unverified', 'campaigns contacts skip-verify',
    'campaigns content discard', 'playbooks items build', 'playbooks build-all', 'playbooks automation on',
    'tools find-accounts start', 'tools find-contacts start', 'tools enrich-contacts start', 'tools phone-tcpa-check start',
  ])('%s says it needs --yes, and its example passes it', path => {
    const command = byPath.get(path)!;
    expect(command.description()).toContain('needs --yes');
    expect(HELP_EXAMPLES[path].some(line => / (--yes|-y)( |$)/.test(line))).toBe(true);
  });

  it('tasks reply-decide says --send needs --yes', () => {
    expect(byPath.get('tasks reply-decide')!.description()).toMatch(/--send.*needs --yes/);
  });

  it('a nested command shows the global options, --yes among them, and its examples', () => {
    const text = helpText(byPath.get('campaigns contacts add')!);
    expect(text).toContain('Global Options:');
    expect(text).toContain('--yes');
    expect(text).toContain('Examples:');
    expect(text).toContain('\n  avair campaigns contacts add CAMPAIGN_ID');
  });

  it('campaigns launch --help shows --yes and a copyable launch line', () => {
    const text = helpText(byPath.get('campaigns launch')!);
    expect(text).toContain('-y, --yes');
    expect(text).toContain('\n  avair campaigns launch CAMPAIGN_ID --yes');
    expect(text).not.toContain('$ avair');
  });

  it('avair --help describes mcp and skill', () => {
    const text = helpText(program);
    expect(text).toMatch(/\n\s+mcp\s+\S/);
    expect(text).toMatch(/\n\s+skill\s+\S/);
    expect(text).toContain('\n  avair campaigns launch CAMPAIGN_ID --yes');
  });

  it('a group without its own examples shows its subcommands\' first ones', () => {
    const lines = printedExamples(helpText(byPath.get('campaigns contacts')!));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe(HELP_EXAMPLES['campaigns contacts show'][0]);
  });

  it('campaigns build can start from a website', () => {
    const text = helpText(byPath.get('campaigns build')!);
    expect(text).toContain('Usage: avair campaigns build [options] [id]');
    expect(text).toContain('--website <url>');
    expect(text).toContain('\n  avair campaigns build --website example.com');
  });

  it('create and build do not offer WhatsApp, which the create API refuses', () => {
    for (const path of ['campaigns create', 'campaigns build']) {
      const channels = byPath.get(path)!.options.find(option => option.long === '--channels')!;
      expect(channels.description).not.toMatch(/whatsapp/i);
    }
    expect(Object.values(HELP_EXAMPLES).flat().filter(line => /--channels \S*whatsapp/i.test(line) && !line.includes('content regenerate'))).toEqual([]);
  });

  it('says what the commands do today (CLI plan C4)', () => {
    const full = byPath.get('campaigns test')!.options.find(option => option.long === '--full')!;
    expect(full.description).not.toContain('12 touches');
    expect(full.description).toContain('every step of the sequence');
    expect(byPath.get('api')!.description()).toContain('unsupported contract');
  });
});
