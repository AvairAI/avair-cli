#!/usr/bin/env node
// The oldest supported CLI still calls routes the current agent spec has
// (TS-CLI-OLD, CLI plan R4). Each R1 command runs as a dry run, which prints
// the method and path it would send without sending anything; every one must
// match a route in backend/tests/snapshots/agent_openapi_r1.json.
//
// Usage: node scripts/check-old-client.mjs <path to the old CLI's dist/index.js>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('Usage: node scripts/check-old-client.mjs <old-cli/dist/index.js>\n');
  process.exit(2);
}

const ID = '3f2a9c1e-0000-4000-8000-000000000001';
// The commands every release since 0.1.0 has: R1 reads and writes across areas.
export const R1_COMMANDS = [
  ['whoami'],
  ['campaigns', 'list'],
  ['campaigns', 'show', ID],
  ['campaigns', 'readiness', ID],
  ['campaigns', 'launch', ID],
  ['campaigns', 'pause', ID],
  ['campaigns', 'targets', 'show', ID],
  ['campaigns', 'targets', 'approve', ID],
  ['campaigns', 'content', 'show', ID],
  ['campaigns', 'contacts', 'list', ID],
  ['contacts', 'show', ID],
  ['tasks', 'list'],
  ['tasks', 'show', ID],
  ['events', 'list', '--type', 'campaigns'],
  ['companies', 'list'],
  ['playbooks', 'list'],
  ['tools', 'credits'],
];

const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../backend/tests/snapshots/agent_openapi_r1.json'), 'utf8'));
const routes = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map(method => ({
  method: method.toUpperCase(),
  pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
})));

const problems = [];
for (const args of R1_COMMANDS) {
  let output;
  try {
    output = execFileSync(process.execPath, [entry, '--json', '--no-input', '--dry-run', '--yes', ...args], {
      encoding: 'utf8',
      env: { ...process.env, AVAIR_TOKEN: 'avp_dry_run', AVAIR_API_URL: 'https://www.avair.ai/api/v1' },
    });
  } catch (error) {
    problems.push(`${args.join(' ')}: exited ${error.status}: ${String(error.stderr).trim()}`);
    continue;
  }
  // A command may make several requests (content show reads two lists).
  const requests = output.trim().split('\n').flatMap(line => {
    const value = JSON.parse(line);
    return Array.isArray(value) ? value : Object.values(value).some(v => v?.dry_run) ? Object.values(value) : [value];
  }).filter(value => value && value.dry_run);
  if (!requests.length) problems.push(`${args.join(' ')}: printed no dry-run request`);
  for (const request of requests) {
    const path = String(request.path).split('?')[0];
    if (!routes.some(route => route.method === request.method && route.pattern.test(path))) {
      problems.push(`${args.join(' ')}: ${request.method} ${path} is not in the current agent spec`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`Old client check passed: ${R1_COMMANDS.length} commands\n`);
