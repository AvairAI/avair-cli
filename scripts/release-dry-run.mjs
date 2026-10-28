#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPublicLeaks, stagePublicMirror } from './release-lib.mjs';

const cliRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'avair-public-release-'));
const destination = join(temporaryRoot, 'mirror');

try {
  await stagePublicMirror(cliRoot, destination);
  const findings = await findPublicLeaks(destination);
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.code}: ${finding.file}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Public mirror dry run passed.\n');
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
