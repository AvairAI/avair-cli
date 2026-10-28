import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import {
  applyMcpSetup, claudeMcpAddArgs, commandInvocation, findCommand, MCP_CLIENTS, planMcpSetup, runInvocation, type McpClient,
} from '../lib/mcpSetup.js';
import { installSkills, planSkillInstall, skillsDestination } from '../lib/skills.js';
import { client, emit, globals, parseJson, readJsonFile, requireValue } from './shared.js';

export function registerMisc(program: Command): void {
  program.command('api <method> [path] [routePath]')
    .description('Call an agent API route directly (unsupported contract: routes and fields may change without a CLI release); `api list [--filter]` and `api describe METHOD PATH` read the runtime spec')
    .option('--body <json>', 'JSON body as text').option('--input <file>', 'JSON body from a file').option('--filter <text>', 'for api list: only routes that match this text')
    .action(async function (this: Command, method: string, path: string | undefined, routePath: string | undefined, o) {
      const word = method.toLowerCase();
      if (word === 'list' || word === 'describe') {
        const spec = await client(this).request('/agent/openapi.json') as OpenApiSpec;
        if (word === 'list') { emit(this, listRoutes(spec, o.filter)); return; }
        emit(this, describeRoute(spec, requireValue(path, 'Give the method, e.g. GET.'), requireValue(routePath, 'Give the route path.')));
        return;
      }
      const body = o.input ? await readJsonFile(o.input) : (o.body ? parseJson(o.body) : undefined);
      emit(this, await client(this).request(requireValue(path, 'Give the route path.'), { method, body }));
    });

  const mcp = program.command('mcp').description('Connect an AI app to Avair over MCP');
  mcp.command('setup').description('Add Avair to the MCP settings of an AI app')
    .requiredOption('--client <name>', 'claude-code, cursor, codex, claude-desktop, claude-ai or chatgpt (cursor and codex: writes a config file; claude-code: runs claude mcp add when claude is installed; the others: prints instructions)')
    .option('--print', 'show the change and write nothing')
    .option('--force', 'replace an existing Avair entry')
    .action(async function (this: Command, o) {
    // AVI-1130: the global --dry-run only stopped API requests. This command
    // needs the app address from Avair before it can say what it would write.
    if (!(MCP_CLIENTS as readonly string[]).includes(o.client)) {
      // An unknown client would otherwise be treated as Claude (AVI-1131).
      throw new CliError(`Unknown client ${o.client}. Use ${MCP_CLIENTS.join(', ')}.`, 2, { code: 'invalid_input' });
    }
    if (globals(this).dryRun) {
      throw new CliError('mcp setup needs the app address from Avair, so it cannot run with --dry-run. Use --print to see the change without writing it.', 2, { code: 'dry_run_unsupported' });
    }
    const identity = await client(this).request('/agent-access/whoami') as { app_base_url?: string };
    if (!identity.app_base_url) throw new CliError('whoami did not return app_base_url.', 1);
    if (o.client === 'claude-code') {
      await setupClaudeCode(this, `${identity.app_base_url.replace(/\/$/, '')}/mcp/`, Boolean(o.print), Boolean(o.force));
      return;
    }
    const change = await planMcpSetup(o.client as McpClient, `${identity.app_base_url}/mcp`, undefined, Boolean(o.force));
    if (change.steps) {
      // An app the CLI cannot configure: numbered steps for the person (AVI-1131).
      emit(this, globals(this).json
        ? { client: o.client, change: change.instructions, steps: change.steps, help_url: change.help_url }
        : [change.instructions, ...change.steps.map((step, index) => `${index + 1}. ${step}`), `Help: ${change.help_url}`].join('\n'));
      return;
    }
    emit(this, { client: o.client, path: change.path, change: change.instructions || change.after });
    if (!o.print && change.path) await applyMcpSetup(change);
  });

  const skill = program.command('skill').description('Agent skills for Avair');
  skill.command('install')
    .description('Copy the Avair skills into the skills folder of an agent')
    .option('--agent <agent>', 'claude-code or codex')
    .option('--dir <path>', 'install into this folder instead')
    .option('--force', 'replace skill folders that already exist')
    .action(async function (this: Command, o) {
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const sourceBase = resolve(moduleDir, '..', '..', 'skills');
      const bundledBase = resolve(moduleDir, '..', 'skills');
      let base = sourceBase;
      try { await stat(sourceBase); } catch { base = bundledBase; }
      const destination = skillsDestination(o.agent, o.dir);
      const g = globals(this);
      const plan = await planSkillInstall(destination);
      // AVI-1130: a dry run lists what would be written and writes nothing.
      if (g.dryRun) {
        emit(this, {
          dry_run: true, destination, would_install: plan.install, would_replace: plan.replace,
          ...(plan.replace.length && !o.force ? { would_refuse: 'These already exist; the real run needs --force to replace them.' } : {}),
        });
        return;
      }
      const installed = await installSkills(base, destination, Boolean(o.force));
      // --force replaces without asking: say what it replaced (AVI-1130).
      if (plan.replace.length && !g.json) {
        process.stderr.write(`Replaced ${plan.replace.length} existing skill file(s) or folder(s); any local changes in them are gone:\n${plan.replace.map(target => `  ${target}`).join('\n')}\n`);
      }
      emit(this, { installed, replaced: plan.replace });
    });

}

/**
 * Add Avair to Claude Code with its own `claude mcp add` (AVI-1132). Runs the
 * claude found on PATH (claude.exe, or claude.cmd through cmd.exe); when it
 * cannot run or fails, prints the command for the person to run instead of a
 * bare spawn error.
 */
async function setupClaudeCode(command: Command, url: string, print: boolean, force: boolean): Promise<void> {
  const g = globals(command);
  const args = claudeMcpAddArgs(url);
  const line = `claude ${args.join(' ')}`;
  if (print) {
    emit(command, g.json ? { client: 'claude-code', command: line } : `Run this to add Avair to Claude Code:\n  ${line}`);
    return;
  }
  const executable = await findCommand('claude');
  if (!executable) {
    emit(command, g.json
      ? { client: 'claude-code', added: false, reason: 'claude_not_found', command: line }
      : `Claude Code (claude) was not found on PATH. After installing it, run:\n  ${line}`);
    return;
  }
  if (force) {
    // Replace an existing entry; a missing one is fine.
    const remove = commandInvocation(executable, ['mcp', 'remove', 'avair', '--scope', 'user']);
    if (remove) await runInvocation(remove);
  }
  const invocation = commandInvocation(executable, args);
  const result = invocation
    ? await runInvocation(invocation)
    : { ok: false, reason: 'the address has characters cmd.exe cannot pass safely' };
  if (!result.ok) {
    throw new CliError(
      `Could not add Avair to Claude Code automatically (${result.reason}). If Avair is already added, use --force to replace it. Otherwise run this yourself:\n  ${line}`,
      1, { code: 'mcp_add_failed', hint: line },
    );
  }
  emit(command, g.json
    ? { client: 'claude-code', added: true, scope: 'user', command: line }
    : 'Added Avair to Claude Code for this computer user. Check with `claude mcp list`; Claude Code asks you to sign in to Avair on first use.');
}

type OpenApiSpec = { paths?: Record<string, Record<string, { summary?: string; parameters?: unknown; requestBody?: unknown }>> };

/** Allowlisted routes from the runtime spec (PRD §5.6). */
export function listRoutes(spec: OpenApiSpec, filter?: string): Array<{ method: string; path: string; summary?: string }> {
  const rows: Array<{ method: string; path: string; summary?: string }> = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      rows.push({ method: method.toUpperCase(), path: path.replace(/^\/api\/v1/, ''), summary: operation?.summary });
    }
  }
  const needle = filter?.toLowerCase();
  return needle ? rows.filter(row => `${row.method} ${row.path} ${row.summary ?? ''}`.toLowerCase().includes(needle)) : rows;
}

export function describeRoute(spec: OpenApiSpec, method: string, path: string): unknown {
  const wanted = path.startsWith('/api/v1') ? path : `/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  const operation = spec.paths?.[wanted]?.[method.toLowerCase()] ?? spec.paths?.[path]?.[method.toLowerCase()];
  if (!operation) throw new CliError(`${method.toUpperCase()} ${path} is not an agent route. See avair api list.`, 5, { code: 'not_found' });
  return { method: method.toUpperCase(), path, ...operation };
}
