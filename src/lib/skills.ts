import { cp, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CliError } from './errors.js';

export const SKILL_NAMES = [
  'avair-build-and-launch', 'avair-import-contacts', 'avair-task-queue',
  'avair-tools', 'avair-company-knowledge', 'avair-whats-changed',
];

// Every skill says "Follow `../AGENTS.md`": the shared rules must sit next to
// the skill folders, or an installed agent never sees them.
export const SHARED_RULES = 'AGENTS.md';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function skillsDestination(
  agent?: string,
  dir?: string,
  home = process.env.HOME || process.env.USERPROFILE || '',
): string {
  if (dir) return dir;
  if (agent === 'claude-code') return join(home, '.claude', 'skills');
  if (agent === 'codex') return join(home, '.codex', 'skills');
  throw new CliError('Choose --agent claude-code, --agent codex, or --dir <path>.', 2);
}

export type SkillInstallPlan = { destination: string; install: string[]; replace: string[] };

/** What an install would write, and which of those targets already exist. Reads only. */
export async function planSkillInstall(destination: string): Promise<SkillInstallPlan> {
  const install = [...SKILL_NAMES, SHARED_RULES].map(name => join(destination, name));
  const replace: string[] = [];
  for (const target of install) if (await exists(target)) replace.push(target);
  return { destination, install, replace };
}

export async function installSkills(base: string, destination: string, force: boolean): Promise<string[]> {
  const entries = [...SKILL_NAMES, SHARED_RULES];
  // Check every target before writing, so a refusal leaves no partial install.
  if (!force) {
    for (const name of entries) {
      const target = join(destination, name);
      if (await exists(target)) throw new CliError(`${target} exists. Use --force to replace it.`, 6);
    }
  }
  await mkdir(destination, { recursive: true });
  const written: string[] = [];
  for (const name of entries) {
    const target = join(destination, name);
    await cp(join(base, name), target, { recursive: true, force: true });
    written.push(target);
  }
  return written;
}
