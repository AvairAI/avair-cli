import type { Command, Option } from 'commander';

import { commandPath, examplesFor } from './helpExamples.js';

// The command reference page of the docs site (/resources/cli/reference),
// built from the same command definitions as `avair <command> --help`, so the
// two cannot drift (CLI plan D2). scripts/build-agent-docs.mjs writes it.

function visible(options: readonly Option[]): Option[] {
  return options.filter(option => !option.hidden && option.long !== '--help' && option.long !== '--version');
}

function optionLines(options: readonly Option[]): string[] {
  return visible(options).map(option => {
    // As `--help` shows it; a --no-… switch's `true` default is not shown.
    const fallback = option.defaultValue !== undefined && !option.negate ? ` (default: ${JSON.stringify(option.defaultValue)})` : '';
    return `- \`${option.flags}\`: ${option.description}${fallback}`;
  });
}

function isHidden(command: Command): boolean {
  return Boolean((command as unknown as { _hidden?: boolean })._hidden);
}

function leaves(command: Command): Command[] {
  const children = command.commands.filter(child => !isHidden(child));
  return children.length ? children.flatMap(leaves) : [command];
}

/** One Markdown section per command, grouped by the first word. */
export function renderCommandReference(program: Command): string {
  const out: string[] = [
    'Every command with its arguments, options and examples. `avair <command> --help` prints the same text.',
    '',
    '## Global options',
    '',
    'Every command takes these.',
    '',
    ...optionLines(program.options),
  ];
  for (const group of program.commands.filter(child => !isHidden(child))) {
    out.push('', `## ${group.name()}`, '', group.description());
    for (const command of leaves(group)) {
      const usage = command.usage().replace(/^\[options\]\s*/, '').trim();
      out.push('', `### \`avair ${commandPath(command)}${usage ? ` ${usage}` : ''}\``, '', command.description());
      const options = optionLines(command.options);
      if (options.length) out.push('', 'Options:', '', ...options);
      const examples = examplesFor(command);
      if (examples.length) out.push('', 'Examples:', '', '```bash', ...examples, '```');
    }
  }
  return `${out.join('\n')}\n`;
}
