import { describe, expect, it } from 'vitest';

import { taskListQuery } from '../../src/commands/resources.js';

describe('tasks list paging', () => {
  it('asks the 0-based manual-tasks API for its first page by default', () => {
    expect(taskListQuery({})).toEqual({ page: 0, size: 50, scope: 'mine' });
  });

  it('maps --page (starting at 1) to the API page', () => {
    expect(taskListQuery({ page: '3', limit: '20' })).toEqual({ page: 2, size: 20, scope: 'mine' });
    expect(taskListQuery({ page: '0' })).toEqual({ page: 0, size: 50, scope: 'mine' });
  });
});
