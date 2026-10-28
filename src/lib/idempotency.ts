import { randomUUID } from 'node:crypto';

export function idempotencyKey(explicit?: string): string {
  return explicit || `cli-${randomUUID()}`;
}
