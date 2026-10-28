/**
 * The docs site's command reference (/resources/cli/reference) is built from
 * the same definitions as `avair --help` (CLI plan D2): every visible command
 * has a section with its options and examples, and hidden ones stay out.
 */
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';
import { commandPath } from '../../src/lib/helpExamples.js';
import { renderCommandReference } from '../../src/lib/reference.js';

const program = createProgram();
const reference = renderCommandReference(program);
const hidden = (command: Command) => Boolean((command as unknown as { _hidden?: boolean })._hidden);
function leaves(command: Command): Command[] {
  const children = command.commands.filter(child => !hidden(child));
  return children.length ? children.flatMap(leaves) : [command];
}

describe('command reference', () => {
  it('has a section for every visible command, with each of its options', () => {
    for (const command of program.commands.filter(child => !hidden(child)).flatMap(leaves)) {
      expect(reference).toContain(`### \`avair ${commandPath(command)}`);
      for (const option of command.options.filter(option => !option.hidden)) {
        expect(reference, `${commandPath(command)} ${option.flags}`).toContain(`\`${option.flags}\``);
      }
    }
  });

  it('leaves out hidden commands and the internal switches', () => {
    expect(reference).not.toContain('avair config');
    expect(reference).not.toContain('--api-url');
    expect(reference).not.toContain('--env ');
  });

  it('keeps the house style of the docs site: no Oxford comma, dash or curly quote', () => {
    expect(reference).not.toMatch(/[—–‘’“”]/);
    const text = reference.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    expect(text).not.toMatch(/\b[\w'-]+(?:\s+[\w'-]+){0,2}, [\w'-]+(?:\s+[\w'-]+){0,2}, (?:and|or) [\w'-]+/);
  });

  it('shows each option default as --help does (R12)', () => {
    expect(reference).toContain('`--limit <n>`: how many rows to return (default: "100")');
    expect(reference).toContain('(default: "900")');
  });
});

