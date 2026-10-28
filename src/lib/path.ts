import { CliError } from './errors.js';

// One path segment: an id, a step name, a tool name. No `/`, `#`, `?`, `.`
// or `%`, so a crafted id cannot change the route a command calls
// (`avair campaigns cancel 'X/start#'` must not send POST /campaigns/X/start).
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function pathSegment(value: unknown): string {
  const text = String(value);
  if (!SEGMENT.test(text)) {
    throw new CliError(`Not a valid id: ${JSON.stringify(text)}. Use only letters, digits, - and _.`, 2, { code: 'invalid_input' });
  }
  return text;
}

/** A route path whose every interpolated value must be one safe segment. */
export function apiPath(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((path, part, index) => path + part + (index < values.length ? pathSegment(values[index]) : ''), '');
}

/**
 * The last guard, for every path the client sends: no fragment, no dot
 * segments, and no percent escapes in the route (the server decodes `%2F`).
 */
export function assertSafePath(path: string): void {
  const route = path.split('?')[0];
  if (path.includes('#') || /[%\\]/.test(route) || route.split('/').some(part => part === '.' || part === '..')) {
    throw new CliError(`Refusing an unsafe request path: ${JSON.stringify(path)}.`, 2, { code: 'invalid_input' });
  }
}
