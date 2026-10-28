#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { changelogEntry } from './release-lib.mjs';

const [version, output] = process.argv.slice(2);
if (!version || !output) {
  process.stderr.write('Usage: node scripts/extract-changelog.mjs <version> <output>\n');
  process.exit(2);
}
await writeFile(output, await changelogEntry(new URL('../CHANGELOG.md', import.meta.url), version), 'utf8');
process.stdout.write(`${output}\n`);
