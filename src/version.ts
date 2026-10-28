import { readFileSync } from 'node:fs';

/**
 * The installed CLI version, read from package.json in one place: `--version`
 * and the `X-Avair-Client` header the server checks against its minimum (D8).
 * `../package.json` resolves the same from src/ and from the bundled dist/.
 */
export const CLI_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;
