import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { saveDownload } from '../../src/lib/files.js';

// F41: a download can hold contact details.
describe.skipIf(process.platform === 'win32')('downloads are saved for their owner only', () => {
  it('creates a new file with mode 0600', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'avair-dl-')), 'campaign.zip');
    expect(await saveDownload(path, Buffer.from('zip'))).toEqual({ saved: path, bytes: 3 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps the mode of a file that already exists', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'avair-dl-')), 'results.csv');
    writeFileSync(path, 'old');
    chmodSync(path, 0o644);
    await saveDownload(path, Buffer.from('new'));
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
