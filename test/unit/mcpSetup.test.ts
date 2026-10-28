import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventEmitter } from 'node:events';

import { applyMcpSetup, claudeMcpAddArgs, commandInvocation, findCommand, planMcpSetup, runInvocation } from '../../src/lib/mcpSetup.js';

describe('MCP setup', () => {
  it('adds Cursor without losing other servers or writing a token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avair-mcp-'));
    await mkdir(join(home, '.cursor'));
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://other' } } }));
    const change = await planMcpSetup('cursor', 'https://app.example/mcp', home);
    await applyMcpSetup(change);
    const saved = await readFile(change.path!, 'utf8');
    expect(saved).toContain('https://other');
    expect(saved).toContain('https://app.example/mcp/');
    expect(saved).not.toMatch(/avp_|Authorization/);
  });

  it('refuses overwrite unless force is used', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avair-mcp-'));
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.avair]\nurl = "https://old/"\n');
    await expect(planMcpSetup('codex', 'https://new/mcp', home)).rejects.toThrow('--force');
    const forced = await planMcpSetup('codex', 'https://new/mcp', home, true);
    expect(forced.after.match(/\[mcp_servers\.avair\]/g)).toHaveLength(1);
    expect(forced.after).toContain('https://new/mcp/');
  });
});

describe('connector steps for apps the CLI cannot configure (AVI-1131)', () => {
  it.each(['claude-ai', 'claude-desktop', 'chatgpt'] as const)('%s gets numbered steps with the address, who may add it, and the sign-in', async client => {
    const change = await planMcpSetup(client, 'https://app.example/mcp');
    expect(change.path).toBeUndefined();
    expect(change.steps!.length).toBeGreaterThanOrEqual(4);
    const text = change.steps!.join(' ');
    expect(text).toContain('https://app.example/mcp/');
    expect(text).toContain('Sign in with your Avair login');
    expect(text).toMatch(client === 'chatgpt' ? /admin or owner/ : /only an Owner can add it/);
    expect(change.help_url).toMatch(/^https:\/\/(support\.claude\.com|help\.openai\.com)\//);
    // No internal client name in what a person reads.
    expect(`${change.instructions} ${text}`).not.toMatch(/claude-ai|claude-desktop|chatgpt /);
  });

  it('Claude Desktop is told the account connector works there too', async () => {
    const desktop = await planMcpSetup('claude-desktop', 'https://app.example/mcp');
    expect(desktop.steps!.at(-1)).toContain('Claude Desktop uses the connectors of your Claude account');
    expect((await planMcpSetup('claude-ai', 'https://app.example/mcp')).steps!.join(' ')).not.toContain('Claude Desktop');
  });

  it('clients the CLI configures itself keep their file change, with no steps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avair-mcp-'));
    expect((await planMcpSetup('cursor', 'https://app.example/mcp', home)).steps).toBeUndefined();
    expect((await planMcpSetup('claude-code', 'https://app.example/mcp', home)).steps).toBeUndefined();
  });
});

describe('running Claude Code on Windows and elsewhere (AVI-1132)', () => {
  it('adds Avair for the whole computer user, and the printed command matches', async () => {
    expect(claudeMcpAddArgs('https://app.example/mcp/')).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'avair', 'https://app.example/mcp/']);
    expect((await planMcpSetup('claude-code', 'https://app.example/mcp')).instructions)
      .toBe('claude mcp add --scope user --transport http avair https://app.example/mcp/');
  });

  it('finds claude.exe before claude.cmd, and null when there is none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'avair-path-'));
    // Executable, so the X_OK check also passes when this runs on Linux (the release job).
    await writeFile(join(dir, 'claude.cmd'), '@echo off', { mode: 0o755 });
    await writeFile(join(dir, 'claude.exe'), '', { mode: 0o755 });
    expect(await findCommand('claude', { PATH: dir }, 'win32')).toBe(join(dir, 'claude.exe'));
    expect(await findCommand('claude', { PATH: join(dir, 'missing') }, 'win32')).toBeNull();
  });

  it('runs an .exe directly, with no shell', () => {
    expect(commandInvocation('C:\\Users\\a\\.local\\bin\\claude.exe', ['mcp', 'add'], 'win32'))
      .toEqual({ file: 'C:\\Users\\a\\.local\\bin\\claude.exe', args: ['mcp', 'add'] });
    expect(commandInvocation('/usr/local/bin/claude', ['mcp', 'add'], 'linux')).toEqual({ file: '/usr/local/bin/claude', args: ['mcp', 'add'] });
  });

  it('runs a .cmd through cmd.exe, which Node needs (spawning a .cmd directly is EINVAL)', () => {
    expect(commandInvocation('C:\\npm\\claude.cmd', claudeMcpAddArgs('https://app.example/mcp/'), 'win32', 'C:\\Windows\\system32\\cmd.exe')).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" mcp add --scope user --transport http avair https://app.example/mcp/"'],
      windowsVerbatimArguments: true,
    });
  });

  it('never hands cmd.exe an address with shell characters', () => {
    expect(commandInvocation('C:\\npm\\claude.cmd', claudeMcpAddArgs('https://app.example/mcp/?a=1&b=2'), 'win32')).toBeNull();
    expect(commandInvocation('C:\\npm\\claude.cmd', claudeMcpAddArgs('https://app.example/%PATH%/'), 'win32')).toBeNull();
  });

  it('reports how a run ended and never throws', async () => {
    const fake = (behave: (child: EventEmitter) => void) => (() => { const child = new EventEmitter(); setImmediate(() => behave(child)); return child; }) as never;
    expect(await runInvocation({ file: 'x', args: [] }, fake(child => child.emit('exit', 0)))).toEqual({ ok: true });
    expect(await runInvocation({ file: 'x', args: [] }, fake(child => child.emit('exit', 1)))).toEqual({ ok: false, reason: 'claude exited with 1' });
    expect(await runInvocation({ file: 'x', args: [] }, fake(child => child.emit('error', new Error('spawn ENOENT'))))).toEqual({ ok: false, reason: 'spawn ENOENT' });
    const einval = (() => { throw new Error('spawn EINVAL'); }) as never;
    expect(await runInvocation({ file: 'claude.cmd', args: [] }, einval)).toEqual({ ok: false, reason: 'spawn EINVAL' });
  });
});
