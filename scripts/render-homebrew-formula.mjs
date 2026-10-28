#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { renderHomebrewFormula } from './release-lib.mjs';

const [version, checksum, output] = process.argv.slice(2);
if (!version || !checksum || !output) {
  process.stderr.write('Usage: node scripts/render-homebrew-formula.mjs <version> <sha256> <output>\n');
  process.exit(2);
}
await writeFile(output, renderHomebrewFormula({ version, checksum }), 'utf8');
process.stdout.write(`${output}\n`);
