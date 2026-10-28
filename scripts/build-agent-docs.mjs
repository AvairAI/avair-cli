#!/usr/bin/env node
// Copies the agent docs into the avair-website repo, where Starlight renders
// them under /resources (CLI plan D2, D3). The Markdown sources live here, in
// generation-engine/docs; edit them here and run this script again:
//
//   cd cli && npm run build && node scripts/build-agent-docs.mjs ../../avair-website
//
// It writes src/content/docs/resources/** (the pages), public/resources/**
// (plain .md copies for agents) and public/resources/ai-agents-llms.txt.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const website = process.argv[2];
if (!website) {
  process.stderr.write('Usage: node scripts/build-agent-docs.mjs <path to avair-website>\n');
  process.exit(2);
}

const here = import.meta.dirname;
const docs = resolve(here, '../../docs');

// dist/index.js runs the CLI on import unless VITEST is set.
process.env.VITEST = 'true';
const { createProgram, renderCommandReference } = await import('../dist/index.js');

/** The guide's text without its first `# Title` line: Starlight prints the title. */
function body(markdown) {
  return markdown.replace(/^# .*\n+/, '');
}

/** Released versions only: the Unreleased section ships with the next release. */
function releasedChangelog(markdown) {
  const text = markdown.replace(/^# .*\n+/, '');
  const firstRelease = text.search(/^## (?!Unreleased)/m);
  return firstRelease === -1 ? text : text.slice(firstRelease);
}

function page(title, description, markdown) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${markdown.trim()}\n`;
}

const read = file => readFile(file, 'utf8');
const PAGES = [
  {
    path: 'resources/cli',
    title: 'AvairAI CLI guide',
    description: 'Install the AvairAI CLI, sign in and let an AI agent or a script build, review and launch campaigns as you.',
    source: await read(join(docs, 'agent-access-cli.md')),
  },
  {
    path: 'resources/cli/reference',
    title: 'AvairAI CLI command reference',
    description: 'Every AvairAI CLI command with its arguments, options and examples.',
    source: `# AvairAI CLI command reference\n\n${renderCommandReference(createProgram())}`,
  },
  {
    path: 'resources/cli/changelog',
    title: 'AvairAI CLI changelog',
    description: 'What changed in each release of the AvairAI CLI.',
    source: `# AvairAI CLI changelog\n\n${releasedChangelog(await read(resolve(here, '../CHANGELOG.md')))}`,
  },
  {
    path: 'resources/mcp',
    title: 'AvairAI MCP connector guide',
    description: 'Connect Claude, ChatGPT, Cursor or Codex to AvairAI over MCP and work with campaigns, tasks and Tools safely.',
    source: await read(join(docs, 'agent-access-mcp.md')),
  },
  {
    path: 'resources/controlling-ai-agents',
    title: 'Controlling AI agents',
    description: 'How an Admin controls AI agents: who may use them, live actions, credit caps and the activity log.',
    source: await read(join(docs, 'agent-access-admin.md')),
  },
];

async function write(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

for (const entry of PAGES) {
  await write(join(website, 'src/content/docs', `${entry.path}.md`), page(entry.title, entry.description, body(entry.source)));
  await write(join(website, 'public', `${entry.path}.md`), entry.source.trim() + '\n');
}
await write(join(website, 'public/resources/ai-agents-llms.txt'), await read(join(docs, 'agent-access-llms.txt')));
process.stdout.write(`Wrote ${PAGES.length} pages, their .md copies and ai-agents-llms.txt to ${resolve(website)}\n`);
