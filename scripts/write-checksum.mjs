#!/usr/bin/env node
import { writeChecksum } from './release-lib.mjs';

const [tarball, output] = process.argv.slice(2);
if (!tarball || !output) {
  process.stderr.write('Usage: node scripts/write-checksum.mjs <tarball> <SHA256SUMS>\n');
  process.exit(2);
}
const checksum = await writeChecksum(tarball, output);
process.stdout.write(`${checksum}\n`);
