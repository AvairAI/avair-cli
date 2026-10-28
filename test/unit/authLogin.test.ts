import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readPipedToken } from '../../src/commands/auth.js';

describe('piped --with-token input', () => {
  it('reads a token piped as Buffer chunks', async () => {
    const stdin = Readable.from([Buffer.from('avp_abc'), Buffer.from('123\n')]);
    await expect(readPipedToken(stdin)).resolves.toBe('avp_abc123');
  });

  it('reads a token piped as strings and trims whitespace', async () => {
    await expect(readPipedToken(Readable.from(['  avp_xyz\r\n']))).resolves.toBe('avp_xyz');
  });

  it('returns an empty string for empty input', async () => {
    await expect(readPipedToken(Readable.from([]))).resolves.toBe('');
  });
});
