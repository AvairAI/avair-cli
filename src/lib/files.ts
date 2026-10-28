import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { CliError } from './errors.js';

/** A local file as a multipart form with one `file` field (plus any text fields). */
export async function fileForm(path: string, fields: Record<string, string | undefined> = {}): Promise<FormData> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new CliError(`Cannot read file ${path}.`, 2);
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(path));
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
  return form;
}

/**
 * A campaign ZIP or Tools CSV can hold contact details: a new file is readable
 * by its owner only, as a saved sign-in is (F41). A file that already exists
 * keeps the mode its owner gave it.
 */
export async function saveDownload(path: string, bytes: Buffer): Promise<{ saved: string; bytes: number }> {
  await writeFile(path, bytes, { mode: 0o600 });
  return { saved: path, bytes: bytes.length };
}

/**
 * Header and row count of a CSV, read locally. The server has no preview route
 * for contact uploads, so this shows what would be sent without sending it.
 */
export function previewCsv(text: string): { columns: string[]; rows: number; sample: string[][] } {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  const split = (line: string) => line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
  const [header, ...rest] = lines;
  return { columns: header ? split(header) : [], rows: rest.length, sample: rest.slice(0, 3).map(split) };
}
