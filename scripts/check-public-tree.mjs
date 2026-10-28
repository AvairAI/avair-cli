#!/usr/bin/env node
import { resolve } from 'node:path';

import { findPublicLeaks } from './release-lib.mjs';

const root = resolve(process.argv[2] || '.');
const findings = await findPublicLeaks(root);
if (findings.length) {
  for (const finding of findings) process.stderr.write(`${finding.code}: ${finding.file}\n`);
  process.exit(1);
}
process.stdout.write(`Public leak check passed: ${root}\n`);
