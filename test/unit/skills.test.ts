import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SHARED_RULES, SKILL_NAMES, installSkills, planSkillInstall, skillsDestination } from '../../src/lib/skills.js';

const bundled = resolve(__dirname, '..', '..', 'skills');
const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'avair-skills-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('avair skill install', () => {
  it('installs every skill with the shared rules each one links to', async () => {
    const destination = join(await tempDir(), 'skills');
    await installSkills(bundled, destination, false);

    for (const name of SKILL_NAMES) {
      const skill = await readFile(join(destination, name, 'SKILL.md'), 'utf8');
      expect(skill).toContain('`../AGENTS.md`');
      // The link each skill follows resolves to the installed shared rules.
      const rules = await readFile(resolve(destination, name, '..', 'AGENTS.md'), 'utf8');
      expect(rules).toContain('Never describe how Avair found a trigger signal');
    }
    expect((await readdir(destination)).sort()).toEqual([...SKILL_NAMES, SHARED_RULES].sort());
  });

  it('requires a target instead of silently choosing one', () => {
    expect(() => skillsDestination(undefined, undefined, '/home/u')).toThrow('Choose --agent');
    expect(() => skillsDestination('cursor', undefined, '/home/u')).toThrow('Choose --agent');
    expect(skillsDestination('claude-code', undefined, '/home/u')).toBe(join('/home/u', '.claude', 'skills'));
    expect(skillsDestination('codex', undefined, '/home/u')).toBe(join('/home/u', '.codex', 'skills'));
    expect(skillsDestination(undefined, '/custom', '/home/u')).toBe('/custom');
  });

  it('refuses to overwrite without --force and writes nothing', async () => {
    const destination = join(await tempDir(), 'skills');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, SHARED_RULES), 'someone else\'s rules');

    await expect(installSkills(bundled, destination, false)).rejects.toThrow('Use --force');
    await expect(stat(join(destination, SKILL_NAMES[0]))).rejects.toThrow();
    expect(await readFile(join(destination, SHARED_RULES), 'utf8')).toBe('someone else\'s rules');

    await installSkills(bundled, destination, true);
    expect(await readFile(join(destination, SHARED_RULES), 'utf8')).toContain('Avair agent rules');
  });
});

describe('planSkillInstall (AVI-1130)', () => {
  it('lists every target and the ones that already exist, and writes nothing', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'avair-plan-'));
    await mkdir(join(destination, SKILL_NAMES[0]));
    const plan = await planSkillInstall(destination);
    expect(plan.install).toEqual([...SKILL_NAMES, SHARED_RULES].map(name => join(destination, name)));
    expect(plan.replace).toEqual([join(destination, SKILL_NAMES[0])]);
    expect(await readdir(destination)).toEqual([SKILL_NAMES[0]]);
    await rm(destination, { recursive: true, force: true });
  });

  it('a folder that does not exist yet is not created', async () => {
    const destination = join(tmpdir(), `avair-plan-missing-${Date.now()}`);
    expect((await planSkillInstall(destination)).replace).toEqual([]);
    await expect(stat(destination)).rejects.toThrow();
  });

  it('every command a skill names exists, with the flags it uses (CLI plan D5)', async () => {
    const { createProgram } = await import('../../src/index.js');
    const program = createProgram();
    const problems: string[] = [];
    for (const name of [SHARED_RULES, ...SKILL_NAMES.map(skill => join(skill, 'SKILL.md'))]) {
      const text = await readFile(join(bundled, name), 'utf8');
      // Inline commands: `avair …` or a bare `campaigns …` style command.
      for (const [, line] of text.matchAll(/`((?:avair )?(?:campaigns|companies|contacts|tasks|tools|events|whoami)[^`]*)`/g)) {
        const words = line.replace(/^avair /, '').split(/\s+/).filter(word => !['--json', '--no-input'].includes(word));
        let command = program as import('commander').Command;
        let index = 0;
        while (index < words.length) {
          const next = command.commands.find(child => child.name() === words[index]);
          if (!next) break;
          command = next;
          index += 1;
        }
        if (command === program) { problems.push(`${name}: ${line}: unknown command`); continue; }
        for (const flag of words.slice(index).filter(word => word.startsWith('--'))) {
          const known = [...command.options, ...program.options].some(option => option.long === flag || option.long === flag.replace(/^--no-/, '--'));
          if (!known && !['--yes', '--json'].includes(flag)) problems.push(`${name}: ${line}: unknown flag ${flag}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
