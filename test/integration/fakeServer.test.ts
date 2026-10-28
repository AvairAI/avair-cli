import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { AvairClient } from '../../src/lib/http.js';
import type { SecretStore } from '../../src/lib/auth/store.js';

describe('fake API integration', () => {
  let server: Server;
  let baseUrl: string;
  // Signed in against the fake server, so the credential is bound to its origin (A4).
  const store: SecretStore = { get: async () => ({ accessToken: 'avp_test', kind: 'pat', apiOrigin: new URL(baseUrl).origin }), set: async () => undefined, delete: async () => undefined };

  beforeEach(async () => {
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== 'Bearer avp_test') { response.statusCode = 401; response.end('{}'); return; }
      if (request.url === '/api/v1/agent-access/whoami') { response.end(JSON.stringify({ user: { email: 'dev@example.com' }, tenant: { name: 'Development' } })); return; }
      response.statusCode = 404; response.end(JSON.stringify({ detail: { error: 'not_found', message: 'Missing' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  afterEach(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  it('uses the same authenticated whoami contract as MCP and the UI', async () => {
    const result = await new AvairClient({ environment: 'local', apiUrl: baseUrl }, store).request('/agent-access/whoami');
    expect(result).toEqual({ user: { email: 'dev@example.com' }, tenant: { name: 'Development' } });
  });
});
