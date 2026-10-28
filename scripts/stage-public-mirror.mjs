#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPublicLeaks, stagePublicMirror } from './release-lib.mjs';

const cliRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = process.argv[2];
if (!destination) {
  process.stderr.write('Usage: node scripts/stage-public-mirror.mjs <destination>\n');
  process.exit(2);
}

const staged = await stagePublicMirror(cliRoot, destination);
const findings = await findPublicLeaks(staged);
if (findings.length) {
  for (const finding of findings) process.stderr.write(`${finding.code}: ${finding.file}\n`);
  process.exit(1);
}
process.stdout.write(`${staged}\n`);
