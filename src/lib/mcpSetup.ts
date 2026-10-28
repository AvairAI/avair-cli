import { spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { CliError } from './errors.js';

export const MCP_CLIENTS = ['claude-code', 'cursor', 'codex', 'claude-desktop', 'claude-ai', 'chatgpt'] as const;
export type McpClient = typeof MCP_CLIENTS[number];
export type McpChange = {
  path?: string; before: string; after: string; instructions?: string;
  /** Numbered steps for an app the CLI cannot configure itself (AVI-1131). */
  steps?: string[];
  /** The app's own help page: its menus change, so the steps link to it. */
  help_url?: string;
};

const CLAUDE_HELP = 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp';
const CHATGPT_HELP = 'https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt';

/**
 * Steps a person follows in Claude (web or Desktop) or ChatGPT to add Avair,
 * from each vendor's help page (checked 2026-10-07). Avair signs in with
 * OAuth, so no key or header is pasted anywhere.
 */
export function connectorSteps(client: 'claude-ai' | 'claude-desktop' | 'chatgpt', url: string): { steps: string[]; help_url: string } {
  if (client === 'chatgpt') {
    return {
      help_url: CHATGPT_HELP,
      steps: [
        'You need ChatGPT Business, Enterprise or Edu to add a custom MCP app (on Pro, only its read tools work).',
        'Turn on developer mode: Settings > Apps > Advanced settings. On Business, an admin or owner turns it on (Workspace settings > Apps).',
        `Create an app named Avair with the MCP server URL ${url} and authentication OAuth.`,
        'Sign in with your Avair login when ChatGPT asks, then wait for it to finish scanning the tools.',
      ],
    };
  }
  return {
    help_url: CLAUDE_HELP,
    steps: [
      'In Claude, open Customize > Connectors, click "+ Add", then "Add custom connector".',
      `Name it Avair and paste the remote MCP server URL ${url}`,
      'Keep "Sign in when needed" and the default OAuth settings (no API key or header), then click Add.',
      'On a Team or Enterprise plan only an Owner can add it: Organization settings > Connectors > Add > Custom > Web, with the same URL. Everyone else then finds Avair under Customize > Connectors and clicks Connect.',
      'Sign in with your Avair login when Claude asks.',
      ...(client === 'claude-desktop'
        ? ['Claude Desktop uses the connectors of your Claude account: once added, Avair is available there with no extra setup.']
        : []),
    ],
  };
}

async function existing(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

export async function planMcpSetup(client: McpClient, serverUrl: string, home = homedir(), force = false): Promise<McpChange> {
  const url = `${serverUrl.replace(/\/$/, '')}/`;
  if (client === 'cursor') {
    const path = join(home, '.cursor', 'mcp.json');
    const before = await existing(path);
    const parsed = before ? JSON.parse(before) as Record<string, unknown> : {};
    const servers = (parsed.mcpServers || {}) as Record<string, unknown>;
    if (servers.avair && !force) throw new CliError('An Avair Cursor MCP entry already exists. Use --force to replace it.', 6);
    const after = `${JSON.stringify({ ...parsed, mcpServers: { ...servers, avair: { url } } }, null, 2)}\n`;
    return { path, before, after };
  }
  if (client === 'codex') {
    const path = join(home, '.codex', 'config.toml');
    const before = await existing(path);
    const block = /^\[mcp_servers\.avair\]\r?\n(?:[^\[].*(?:\r?\n|$))*/m;
    if (block.test(before) && !force) throw new CliError('An Avair Codex MCP entry already exists. Use --force to replace it.', 6);
    const without = before.replace(block, '').trimEnd();
    const suffix = `${without ? '\n\n' : ''}[mcp_servers.avair]\nurl = "${url}"\n`;
    return { path, before, after: `${without}${suffix}` };
  }
  if (client === 'claude-code') {
    return { before: '', after: '', instructions: `claude ${claudeMcpAddArgs(url).join(' ')}` };
  }
  const app = client === 'chatgpt' ? 'ChatGPT' : client === 'claude-desktop' ? 'Claude Desktop' : 'Claude';
  return {
    before: '', after: '',
    instructions: `Add Avair as a custom connector in ${app}: ${url}`,
    ...connectorSteps(client as 'claude-ai' | 'claude-desktop' | 'chatgpt', url),
  };
}

export async function applyMcpSetup(change: McpChange): Promise<void> {
  if (!change.path) return;
  await mkdir(dirname(change.path), { recursive: true });
  await writeFile(change.path, change.after, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Claude Code's own command for adding Avair. User scope: Avair is then
 * available in every folder for this computer user, not only the one the
 * setup ran in (Claude Code's default "local" scope).
 */
export function claudeMcpAddArgs(url: string): string[] {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'avair', url];
}

/** The full path of `command` on PATH (an .exe before a .cmd or .bat on Windows), or null. */
export async function findCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const folder of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
    if (!folder) continue;
    for (const ext of extensions) {
      const candidate = join(folder, `${command}${ext}`);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
    }
  }
  return null;
}

export type Invocation = { file: string; args: string[]; windowsVerbatimArguments?: boolean };

/** Characters cmd.exe passes through unchanged inside one quoted command line. */
const CMD_SAFE = /^[A-Za-z0-9._:/-]+$/;

/**
 * How to run `executable args`. A Windows .cmd or .bat cannot be spawned
 * without a shell (Node refuses with EINVAL, AVI-1132), so it goes through
 * cmd.exe — only when every argument is plain, else null (print instead).
 * An .exe, or any program on macOS and Linux, runs directly with no shell.
 */
export function commandInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec || 'cmd.exe',
): Invocation | null {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    if (!args.every(arg => CMD_SAFE.test(arg))) return null;
    return { file: comspec, args: ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { file: executable, args };
}

type SpawnFn = typeof nodeSpawn;

/**
 * Run an invocation and report how it ended; never throws. Its output goes to
 * stderr so --json output on stdout stays one clean object.
 */
export function runInvocation(invocation: Invocation, spawnFn: SpawnFn = nodeSpawn): Promise<{ ok: boolean; reason?: string }> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnFn(invocation.file, invocation.args, {
        stdio: ['ignore', 2, 2], shell: false, windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ ok: false, reason: (error as Error).message });
      return;
    }
    child.once('error', error => resolve({ ok: false, reason: error.message }));
    child.once('exit', code => resolve(code === 0 ? { ok: true } : { ok: false, reason: `claude exited with ${code}` }));
  });
}
