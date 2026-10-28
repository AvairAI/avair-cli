#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expected = `cli-v${packageJson.version}`;
if (tag !== expected) {
  process.stderr.write(`Release tag ${tag || '<missing>'} must equal ${expected}.\n`);
  process.exit(1);
}
process.stdout.write(`version=${packageJson.version}\npublic_tag=v${packageJson.version}\n`);
