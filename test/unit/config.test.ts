import { describe, expect, it } from 'vitest';

import { apiUrl } from '../../src/lib/config.js';

describe('apiUrl', () => {
  it('does not publish an internal QA hostname', () => {
    expect(() => apiUrl('qa', undefined, {})).toThrow(
      'No API address is set for the qa environment. Set AVAIR_API_URL or --api-url.',
    );
    expect(apiUrl('qa', 'https://qa.example.test/api/v1', {})).toBe(
      'https://qa.example.test/api/v1',
    );
  });

  it('defaults prod to the web host, which serves the API (api.avair.ai does not resolve)', () => {
    expect(apiUrl('prod', undefined, {}, {})).toBe('https://www.avair.ai/api/v1');
  });
});
