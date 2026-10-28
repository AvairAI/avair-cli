/**
 * The CLI and MCP guides are the public sources for the docs site (CLI plan
 * D1): the release leak scan passes on them, and they carry no internal
 * ticket ids or internal file paths.
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain .mjs script without types
import { findPublicLeaks } from '../../scripts/release-lib.mjs';

const docs = resolve(__dirname, '..', '..', '..', 'docs');
const GUIDES = ['agent-access-cli.md', 'agent-access-mcp.md', 'agent-access-admin.md', 'agent-access-llms.txt'];
let dir = '';

afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

// The public CLI mirror holds only cli/, so the guides are not there to check.
describe.skipIf(!existsSync(docs))('public agent guides', () => {
  it('pass the release leak scan, the generated command reference too', async () => {
    dir = await mkdtemp(join(tmpdir(), 'avair-docs-'));
    for (const guide of GUIDES) await cp(join(docs, guide), join(dir, guide));
    const { createProgram } = await import('../../src/index.js');
    const { renderCommandReference } = await import('../../src/lib/reference.js');
    await writeFile(join(dir, 'reference.md'), renderCommandReference(createProgram()));
    expect(await findPublicLeaks(dir)).toEqual([]);
  });

  it.each(GUIDES)('%s keeps the house style of the docs site', async guide => {
    const text = (await readFile(join(docs, guide), 'utf8')).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    expect(text).not.toMatch(/[—–‘’“”]/);
    expect(text).not.toMatch(/\b[\w'-]+(?:\s+[\w'-]+){0,2}, [\w'-]+(?:\s+[\w'-]+){0,2}, (?:and|or) [\w'-]+/);
  });

  it.each(GUIDES)('%s names no ticket, review id or internal path', async guide => {
    const text = await readFile(join(docs, guide), 'utf8');
    expect(text).not.toMatch(/\bAVI-\d+|\bRV\d+\b|docs\/[a-z-]+\.md|backend\/|\.run\.app/);
  });
});
