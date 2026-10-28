/**
 * AVI-1157: a customer has one Avair. The help they can reach names no
 * internal environment (qa, local) and no switch to choose one; those still
 * work for our own team.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';

import { createProgram } from '../../src/index.js';
import { commandPath } from '../../src/lib/helpExamples.js';

const program = createProgram();
const hidden = (command: Command) => Boolean((command as unknown as { _hidden?: boolean })._hidden);

/** Every help page a customer can reach: not hidden, not under a hidden command. */
function visible(command: Command): Command[] {
  return [command, ...command.commands.filter(sub => !hidden(sub)).flatMap(visible)];
}

const INTERNAL = [/--env\b/, /--api-url\b/, /\bqa\b/i, /localhost/, /\bapi-url\./, /^\s+config\b/m];

/** The help exactly as printed, examples included. */
function helpText(command: Command): string {
  let text = '';
  command.configureOutput({ writeOut: chunk => { text += chunk; }, writeErr: chunk => { text += chunk; } });
  command.outputHelp();
  return text;
}

describe('help a customer sees (AVI-1157)', () => {
  it('names no internal environment or switch on any reachable help page', () => {
    const leaks = visible(program).flatMap(command => {
      const text = helpText(command);
      return INTERNAL.filter(pattern => pattern.test(text))
        .map(pattern => `${commandPath(command) || 'avair'}: ${pattern}`);
    });
    expect(leaks).toEqual([]);
  });

  it('still has the switches and the config command for our own team', () => {
    expect(program.options.map(option => option.long)).toEqual(expect.arrayContaining(['--env', '--api-url']));
    const config = program.commands.find(command => command.name() === 'config');
    expect(config && hidden(config)).toBe(true);
  });
});
