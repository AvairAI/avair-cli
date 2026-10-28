import pc from 'picocolors';

export function printValue(value: unknown, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  if (Array.isArray(value)) {
    for (const row of value) process.stdout.write(`${formatRow(row)}\n`);
    return;
  }
  const record = value as Record<string, unknown>;
  const rows = Array.isArray(record.items) ? record.items : null;
  if (rows) for (const row of rows) process.stdout.write(`${formatRow(row)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatRow(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const row = value as Record<string, unknown>;
  const id = row.id || row.campaign_id || row.task_id || row.run_id || '';
  const label = row.name || row.title || row.status || row.action || '';
  return `${pc.cyan(String(id))}${label ? `  ${String(label)}` : ''}`;
}
