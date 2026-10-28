import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

const MIRROR_EXCLUDES = new Set([
  'dist',
  'node_modules',
  'public-repo',
  'test/e2e',
]);

const forbiddenProviderPattern = new RegExp(
  `\\b(?:${[
    ['safe', 'to\\s?call'].join(''),
    ['scrape', '\\.?do'].join(''),
    ['serp', 'api'].join(''),
    ['scraping', 'dog'].join(''),
    ['apo', 'llo'].join(''),
    ['fire', 'store'].join(''),
    ['mongo', 'db?'].join(''),
    ['gem', 'ini'].join(''),
    ['ai', '[ -]mode'].join(''),
  ].join('|')})\\b`,
  'iu',
);

const TEXT_PATTERNS = [
  {
    code: 'internal_hostname',
    pattern: /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*a\.run\.app\b|\bqa(?:[.-][a-z0-9-]+)*\.avair\.ai\b/iu,
  },
  {
    code: 'credential',
    pattern: /(?:tak_live_|avp_)[A-Za-z0-9_-]{20,}/u,
  },
  {
    code: 'forbidden_provider',
    pattern: forbiddenProviderPattern,
  },
];

function portable(path) {
  return path.split(sep).join('/');
}

function excluded(path) {
  const normalized = portable(path);
  return [...MIRROR_EXCLUDES].some(
    item => normalized === item || normalized.startsWith(`${item}/`),
  );
}

async function copyTree(source, destination, current = '') {
  for (const entry of await readdir(join(source, current), { withFileTypes: true })) {
    const next = current ? join(current, entry.name) : entry.name;
    if (excluded(next) || entry.name === '.DS_Store') continue;
    const from = join(source, next);
    const to = join(destination, next);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(source, destination, next);
    } else if (entry.isFile()) {
      await mkdir(resolve(to, '..'), { recursive: true });
      await cp(from, to, { force: true });
    }
  }
}

export async function stagePublicMirror(sourceDirectory, destinationDirectory) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (source === destination || destination.startsWith(`${source}${sep}`)) {
    throw new Error('Mirror destination must be outside the CLI source tree.');
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await copyTree(source, destination);

  const overlay = join(source, 'public-repo');
  try {
    if ((await stat(overlay)).isDirectory()) await copyTree(overlay, destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await cp(join(source, 'skills', 'AGENTS.md'), join(destination, 'AGENTS.md'), {
    force: true,
  });
  return destination;
}

async function walkFiles(root, current = '') {
  const files = [];
  for (const entry of await readdir(join(root, current), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const next = current ? join(current, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await walkFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

export async function findPublicLeaks(rootDirectory) {
  const root = resolve(rootDirectory);
  const findings = [];
  for (const file of await walkFiles(root)) {
    const normalized = portable(file);
    const name = basename(file);
    if (name === '.env' || name.startsWith('.env.')) {
      findings.push({ file: normalized, code: 'environment_file' });
      continue;
    }
    const bytes = await readFile(join(root, file));
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    for (const check of TEXT_PATTERNS) {
      if (check.code === 'credential' && normalized.includes('/fixtures/')) continue;
      if (check.pattern.test(content)) findings.push({ file: normalized, code: check.code });
    }
  }
  return findings;
}

export async function sha256File(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function writeChecksum(tarball, output) {
  const checksum = await sha256File(tarball);
  await writeFile(output, `${checksum}  ${basename(tarball)}\n`, 'utf8');
  return checksum;
}

export function renderHomebrewFormula({ version, checksum }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid SHA-256 checksum.');
  return `class Avair < Formula
  desc "Command-line access to Avair campaigns, playbooks, tasks, and tools"
  homepage "https://www.avair.ai/resources/cli"
  url "https://registry.npmjs.org/@avair/cli/-/cli-${version}.tgz"
  sha256 "${checksum}"
  license "MIT"

  depends_on "node@22"

  def install
    system Formula["node@22"].opt_bin/"npm", "install", *std_npm_args
    (bin/"avair").write_env_script libexec/"bin/avair", PATH: "#{Formula["node@22"].opt_bin}:$PATH"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/avair --version")
  end
end
`;
}

export async function changelogEntry(changelogPath, version) {
  const content = await readFile(changelogPath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^## (?:\\[)?${escaped}(?:\\])?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!match) throw new Error(`CHANGELOG.md has no entry for ${version}.`);
  return `## ${version}\n${match[1].trim()}\n`;
}
