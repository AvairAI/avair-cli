import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../../src/index.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(testDirectory, '../..');
const repositoryRoot = resolve(cliRoot, '..');
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'avair-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

function script(name: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(cliRoot, 'scripts', name), ...args], {
    cwd: cliRoot,
    encoding: 'utf8',
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function commandExists(...names: string[]): boolean {
  let command = createProgram();
  for (const name of names) {
    const next = command.commands.find(candidate => candidate.name() === name);
    if (!next) return false;
    command = next;
  }
  return true;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('public mirror', () => {
  it('stages reproducible source and overlays public community files', async () => {
    const root = await temporaryDirectory();
    const destination = join(root, 'mirror');
    const result = script('stage-public-mirror.mjs', destination);

    expect(result.status, result.stderr).toBe(0);
    expect(await exists(join(destination, 'package.json'))).toBe(true);
    expect(await exists(join(destination, 'src', 'index.ts'))).toBe(true);
    expect(await exists(join(destination, 'AGENTS.md'))).toBe(true);
    expect(await exists(join(destination, 'SECURITY.md'))).toBe(true);
    expect(await exists(join(destination, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'))).toBe(true);
    expect(await exists(join(destination, 'public-repo'))).toBe(false);
    expect(await exists(join(destination, 'node_modules'))).toBe(false);
    expect(await exists(join(destination, 'dist'))).toBe(false);
    expect(await exists(join(destination, 'test', 'e2e'))).toBe(false);
  });

  it('rejects internal hosts, credentials, environment files, and forbidden names', async () => {
    const cases = [
      { name: 'host.txt', content: `https://service.${['a', 'run', 'app'].join('.')}`, code: 'internal_hostname' },
      { name: 'token.txt', content: `${'avp_'}${'A'.repeat(40)}`, code: 'credential' },
      { name: 'notes.txt', content: ['serp', 'api'].join(''), code: 'forbidden_provider' },
      { name: '.env.production', content: 'SAFE=value', code: 'environment_file' },
    ];

    for (const item of cases) {
      const root = await temporaryDirectory();
      await writeFile(join(root, item.name), item.content, 'utf8');
      const result = script('check-public-tree.mjs', root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(item.code);
    }
  });

  it('allows credential-shaped values only in fixture directories', async () => {
    const root = await temporaryDirectory();
    const fixture = join(root, 'test', 'fixtures');
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'token.txt'), `${'tak_live_'}${'B'.repeat(24)}`, 'utf8');

    const result = script('check-public-tree.mjs', root);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('release artifacts', () => {
  it('writes a standard SHA256SUMS line and matching Homebrew formula', async () => {
    const root = await temporaryDirectory();
    const tarball = join(root, 'avair-cli-0.1.0.tgz');
    const sums = join(root, 'SHA256SUMS');
    const formula = join(root, 'avair.rb');
    const body = Buffer.from('release fixture');
    await writeFile(tarball, body);

    const checksum = createHash('sha256').update(body).digest('hex');
    const checksumResult = script('write-checksum.mjs', tarball, sums);
    expect(checksumResult.status, checksumResult.stderr).toBe(0);
    expect(await readFile(sums, 'utf8')).toBe(`${checksum}  avair-cli-0.1.0.tgz\n`);

    const formulaResult = script('render-homebrew-formula.mjs', '0.1.0', checksum, formula);
    expect(formulaResult.status, formulaResult.stderr).toBe(0);
    const formulaText = await readFile(formula, 'utf8');
    expect(formulaText).toContain('cli-0.1.0.tgz');
    expect(formulaText).toContain(`sha256 "${checksum}"`);
    expect(formulaText).toContain('depends_on "node@22"');
    // node@22 is keg-only: without a wrapper on bin, Homebrew never links `avair` (cli-v0.2.1).
    expect(formulaText).toContain('(bin/"avair").write_env_script libexec/"bin/avair"');
    expect(formulaText).toContain('PATH: "#{Formula["node@22"].opt_bin}:$PATH"');
    expect(formulaText).toContain('avair --version');
  });

  it('requires the release tag, package version, CLI version, and changelog to agree', async () => {
    const packageJson = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8')) as { version: string };
    expect(createProgram().version()).toBe(packageJson.version);

    const valid = script('verify-release-tag.mjs', `cli-v${packageJson.version}`);
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toContain(`version=${packageJson.version}`);

    const invalid = script('verify-release-tag.mjs', 'cli-v99.0.0');
    expect(invalid.status).toBe(1);

    const root = await temporaryDirectory();
    const notes = join(root, 'notes.md');
    const extracted = script('extract-changelog.mjs', packageJson.version, notes);
    expect(extracted.status, extracted.stderr).toBe(0);
    const releaseNotes = await readFile(notes, 'utf8');
    expect(releaseNotes).toContain(`## ${packageJson.version}`);
    // The entry for the current version has a body, not only its heading.
    expect(releaseNotes.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('keeps the tag workflow gated on scan, checksums, both channels, and mirror release', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'cli-release.yml'), 'utf8');
    expect(workflow).toContain("tags:\n      - 'cli-v*'");
    expect(workflow).toContain('npm publish');
    expect(workflow).toContain('--tag "$dist_tag"');
    expect(workflow).toContain('npm publish "./release-assets/');
    // npm makes the tarball's absolute path public; the workspace path names the private repo.
    expect(workflow).toContain('path: ${{ runner.temp }}/release-assets');
    expect(workflow).toContain('working-directory: ${{ runner.temp }}');
    expect(workflow).toContain('*-*) dist_tag=next');
    expect(workflow).toContain('npm install -g npm@11.5.1');
    expect(workflow).toContain('stage-public-mirror.mjs');
    expect(workflow).toContain('check-public-tree.mjs');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('AvairAI/avair-cli');
    expect(workflow).toContain('AvairAI/homebrew-tap');
    expect(workflow).toContain('macos-14');
    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('brew uninstall avair');
  });

  it('checks Homebrew on the local tarball before npm takes the version', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'cli-release.yml'), 'utf8');
    // One job's text: from its own heading up to the next job heading.
    const job = (name: string) => workflow.slice(workflow.indexOf(`\n  ${name}:\n`) + 1).split(/\n  [a-z-]+:\n/)[0];
    // cli-v0.2.0 and cli-v0.2.1 each burned an npm version on a Homebrew failure found after publish.
    expect(workflow.indexOf('\n  verify-homebrew:\n')).toBeLessThan(workflow.indexOf('\n  publish-npm:\n'));
    expect(job('publish-npm')).toContain('needs: [prepare, verify-homebrew]');
    expect(job('publish-npm')).toContain("needs.verify-homebrew.result == 'skipped'");
    expect(job('verify-homebrew')).toContain('needs: prepare');
    expect(job('verify-homebrew')).not.toContain('registry.npmjs.org');
    expect(job('verify-homebrew')).toContain('file://$ENV{TARBALL}');
    expect(job('verify-homebrew')).toContain('git config --global user.name');
    expect(job('verify-homebrew')).toContain('brew test');
    expect(job('distribute')).toContain('Wait until npm serves the package');
  });

  it('pushes the mirror and tap with the org app, not a personal token', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'cli-release.yml'), 'utf8');
    // cli-v0.2.2: the personal token AVAIR_CLI_RELEASE_TOKEN lost write access (403).
    expect(workflow).not.toContain('AVAIR_CLI_RELEASE_TOKEN');
    expect(workflow).toContain('uses: actions/create-github-app-token@v1');
    expect(workflow).toContain('app-id: ${{ vars.AVAIR_RELEASE_APP_ID }}');
    expect(workflow).toContain('private-key: ${{ secrets.AVAIR_RELEASE_APP_KEY }}');
    expect(workflow).toContain('repositories: avair-cli,homebrew-tap');
    expect(workflow.split('${{ steps.app-token.outputs.token }}').length - 1).toBe(3);
    // A re-tagged release must not publish a formula whose sha256 npm does not serve.
    expect(workflow).toContain("Check npm serves this run's tarball");
  });

  it('keeps pre-releases off latest and never asks for provenance from the private repository', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'cli-release.yml'), 'utf8');
    const packageJson = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8')) as {
      publishConfig?: { provenance?: boolean };
    };
    expect(workflow).not.toContain('--provenance');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(packageJson.publishConfig?.provenance).toBeUndefined();
    const mirrorGate = "if: vars.CLI_PUBLIC_MIRROR_ENABLED == 'true' && !contains(needs.prepare.outputs.version, '-')";
    expect(workflow.split(mirrorGate).length - 1).toBe(2);
  });

  it('keeps QA acceptance manual, protected, and separately gated for live actions', async () => {
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'agent-access-qa.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain('environment: qa');
    expect(workflow).toContain('group: agent-access-qa');
    expect(workflow).toContain('run_live_launch:');
    expect(workflow).toContain('run_paid_tools:');
    expect(workflow).toContain('AVAIR_E2E_LIVE_LAUNCH:');
    expect(workflow).toContain('AVAIR_E2E_PAID_TOOLS:');
    expect(workflow).toContain('timeout-minutes: 130');
    expect(workflow).toContain('npx vitest run test/e2e');
    expect(workflow).toContain('agent-access-e2e.json');
  });

  it('publishes the required install, quickstart, MCP, support, and security guidance', async () => {
    const readme = await readFile(join(cliRoot, 'README.md'), 'utf8');
    expect(readme).toContain('npm install -g @avair/cli');
    expect(readme).not.toContain('brew install');
    expect(readme).toContain('First campaign in five commands');
    expect(readme).toContain('avair mcp setup --client claude-code');
    expect(readme).toContain('https://www.avair.ai/resources/cli');
    expect(readme).toContain('support@avair.ai');
    expect(commandExists('campaigns', 'create')).toBe(true);
    expect(commandExists('campaigns', 'targets', 'show')).toBe(true);
    expect(commandExists('campaigns', 'targets', 'approve')).toBe(true);
    expect(commandExists('campaigns', 'build')).toBe(true);
    expect(commandExists('campaigns', 'launch')).toBe(true);
    expect(commandExists('mcp', 'setup')).toBe(true);
    expect(await exists(join(cliRoot, 'public-repo', 'SECURITY.md'))).toBe(true);
    expect(await exists(join(cliRoot, 'public-repo', 'CONTRIBUTING.md'))).toBe(true);
  });
});
