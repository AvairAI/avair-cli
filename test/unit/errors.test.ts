import { describe, expect, it } from 'vitest';

import { apiError, ownerChoiceLines } from '../../src/lib/errors.js';

describe('API exit codes', () => {
  it.each([
    [401, 'invalid_token', 3],
    [404, 'not_found', 5],
    [426, 'cli_upgrade_required', 9],
    [429, 'rate_limited', 8],
    [409, 'launch_in_progress', 10],
    [409, 'launch_reconciliation_required', 10],
    [503, 'launch_reconciliation_required', 10],
    [409, 'launch_state_changed', 6],
  ])('maps HTTP %s / %s to exit %s', (status, code, exit) => {
    expect(apiError(status, { detail: { error: code, message: 'failed' } }).exitCode).toBe(exit);
  });

  it('keeps the blocking steps of a refused launch (AC9)', () => {
    const error = apiError(409, { detail: { error: 'launch_blocked', message: 'Not ready', blocking_steps: ['mailboxes', 'verify_contacts'] } });
    expect(error.exitCode).toBe(6);
    expect(error.details.blocking_steps).toEqual(['mailboxes', 'verify_contacts']);
    expect(apiError(409, { detail: { error: 'launch_blocked', message: 'x' } }).details.blocking_steps).toBeUndefined();
  });

  it('keeps the owner choices of a hand build refusal and says how to use them (AVI-1197)', () => {
    const error = apiError(409, { detail: { error: 'owner_choice_required', message: 'Choose who owns this campaign.', choices: [...[{ user_id: 'u7', name: 'Pat Tester', email: 'pat@x.com', persona_name: 'Jack', assigned: true }, { user_id: 'u1', name: 'Jane Doe', email: 'jane@x.com', persona_name: null, assigned: false }], { name: 'no id' }, null] } });
    expect(error.details.choices).toEqual([
      { user_id: 'u7', name: 'Pat Tester', email: 'pat@x.com', persona_name: 'Jack', assigned: true },
      { user_id: 'u1', name: 'Jane Doe', email: 'jane@x.com', assigned: false },
    ]);
    expect(error.details.hint).toBe('Run the build again with --owner <user_id>, using one of the choices.');
    expect(ownerChoiceLines(error.details.choices!)).toBe(
      '\n  --owner u7  Jack: Pat Tester · pat@x.com (assigned in the plan)\n  --owner u1  you (Jane Doe · jane@x.com)',
    );
    // The server's own hint wins; no list, or another code, adds no hint.
    expect(apiError(409, { detail: { error: 'owner_choice_required', message: 'x', hint: 'server hint', choices: [{ user_id: 'u7', name: 'Pat Tester', email: 'pat@x.com', persona_name: 'Jack', assigned: true }, { user_id: 'u1', name: 'Jane Doe', email: 'jane@x.com', persona_name: null, assigned: false }] } }).details.hint).toBe('server hint');
    expect(apiError(409, { detail: { error: 'owner_choice_required', message: 'x', choices: 'u7' } }).details).toMatchObject({ choices: undefined, hint: undefined });
    expect(apiError(409, { detail: { error: 'launch_blocked', message: 'x', choices: [{ user_id: 'u7', name: 'Pat Tester', email: 'pat@x.com', persona_name: 'Jack', assigned: true }, { user_id: 'u1', name: 'Jane Doe', email: 'jane@x.com', persona_name: null, assigned: false }] } }).details.hint).toBeUndefined();
  });

  it('explains a refusal the server sent without a message (D5)', () => {
    expect(apiError(429, { detail: { error: 'tool_daily_cap_exceeded', daily_cap: 1, spent_today: 0, required: 2 } }).message)
      .toBe('Daily Tools credit cap reached for this token: cap 1, spent today 0, this run needs up to 2. It resets at the start of the next UTC day.');
    expect(apiError(409, { detail: { error: 'tool_rate_limited', blocking_run: { id: 'r9' } } }).message)
      .toBe('Another Tools run is still in progress (r9). Wait for it to finish, or cancel it.');
    expect(apiError(409, { detail: { error: 'something_new' } }).message).toBe('something new (HTTP 409)');
    expect(apiError(409, { detail: { error: 'x', message: 'Server words' } }).message).toBe('Server words');
    expect(apiError(500, null).message).toBe('Avair returned HTTP 500');
  });

  it('says where to buy credits when a run is refused for credits (AVI-1174)', () => {
    const old = apiError(409, { detail: { error: 'insufficient_tool_credits', required: 2, remaining: 0 } });
    expect(old.message).toBe('Not enough Tools credits: this run needs up to 2, 0 left this period. An Admin can buy more in Account > Subscription & Billing > Add capacity.');
    const current = apiError(409, { detail: {
      error: 'insufficient_tool_credits', message: 'Not enough Tools credits: server words.',
      app_url: 'https://app.example/account?tab=billing', required: 2, remaining: 0,
    } });
    expect(current.message).toBe('Not enough Tools credits: server words.');
    expect(current.details.app_url).toBe('https://app.example/account?tab=billing');
  });

  it('distinguishes a plan gate from other forbidden responses', () => {
    expect(apiError(403, {}, new Headers({ 'X-Avair-Error-Code': 'plan_limit' })).exitCode).toBe(7);
    expect(apiError(403, {}).exitCode).toBe(4);
  });
});

describe('a 422 names the field that failed (AVI-1140)', () => {
  const body = {
    error_code: 'VALIDATION_ERROR',
    message: 'The request contains invalid data. Please check your input and try again.',
    validation_errors: [
      { loc: ['body', 'company_website'], msg: 'Value error, URL failed safety validation.', type: 'value_error' },
      { loc: ['query', 'limit'], msg: 'Input should be a valid integer', type: 'int_parsing' },
    ],
  };

  it('adds each field and why after the message', () => {
    const error = apiError(422, body);
    expect(error.message).toBe(
      'The request contains invalid data. Please check your input and try again. '
      + 'company_website: Value error, URL failed safety validation.; query.limit: Input should be a valid integer',
    );
    expect(error.details.message).toBe(error.message);
    expect(error.exitCode).toBe(1);
  });

  it('leaves other errors as they were', () => {
    expect(apiError(403, { detail: { error: 'x', message: 'No.' } }).message).toBe('No.');
    expect(apiError(422, { message: 'Bad.', validation_errors: 'not a list' }).message).toBe('Bad.');
  });
});
