import { describe, expect, it } from 'vitest';

import {
  assessApplySteps, assessEach, assessmentOutput, assessStep, campaignCreateBody, creationSettled, dispatchKind, findUploadResult,
  newestDispatch, pickSuggestions, uploadSummary, uploadSummaryText,
} from '../../src/commands/campaigns.js';

describe('campaign command request mapping', () => {
  it('maps channel and content-style flags to the external campaign schema', () => {
    expect(campaignCreateBody({
      website: 'https://example.com',
      location: 'Boston, MA',
      size: '51-200',
      industry: 'Software',
      channels: 'email,linkedin,manual_call',
      contentStyle: 'standard',
    })).toEqual({
      website_url: 'https://example.com',
      targeting: {
        locations: ['Boston, MA'],
        company_sizes: ['51-200'],
        industries: ['Software'],
      },
      channels: {
        manual_call: true,
        ai_call: false,
        linkedin: true,
        whatsapp: false,
      },
      campaign_style: 'STANDARD',
      stop_at_targets: true,
    });
  });

  it('omits channel and content overrides when their flags are absent', () => {
    expect(campaignCreateBody({ website: 'https://example.com' })).toEqual({
      website_url: 'https://example.com',
      targeting: {},
      stop_at_targets: true,
    });
  });

  it('rejects unknown channels and content styles before sending a request', () => {
    expect(() => campaignCreateBody({ channels: 'email,sms' })).toThrow(/Unknown channel sms/);
    // The create API refuses WhatsApp (422); say so before sending anything.
    expect(() => campaignCreateBody({ channels: 'email,whatsapp' })).toThrow(/WhatsApp cannot be chosen/);
    expect(() => campaignCreateBody({ contentStyle: 'custom' })).toThrow(/Unknown campaign style custom/);
  });

  it('normalizes documented dispatch kinds for the API', () => {
    expect(dispatchKind()).toBe('START');
    expect(dispatchKind('start')).toBe('START');
    expect(dispatchKind('TEST')).toBe('TEST');
    expect(() => dispatchKind('launch')).toThrow(/start or test/);
  });
});

describe('a campaign created from a website is done (AVI-1121)', () => {
  it.each([
    ['DRAFT_NEEDS_TARGET_REVIEW', true],
    ['FAILED_GENERATION', true],
    ['READY_TO_LAUNCH', true],
    ['READY_TO_TEST', true],
    ['DRAFT_PENDING_INITIAL_GENERATION', false],
    ['DRAFT_GENERATING_TARGETS', false],
    // Shown for a moment while targets are still generating (api orchestrator step 2).
    ['DRAFT_NEEDS_CONTENT_REVIEW', false],
  ])('%s -> %s', (status, done) => {
    expect(creationSettled({ status })).toBe(done);
  });
});

describe('contact upload result (AVI-1122)', () => {
  const entry = (id: string, details: unknown, type = 'CAMPAIGN_UPDATED') => ({ id, activity_type: type, details: JSON.stringify(details) });

  it('takes the newest upload entry newer than the one seen before the upload', () => {
    const entries = [
      entry('n2', { action: 'linkedin_selection' }),
      entry('n1', { contacts_uploaded: 4 }),
      entry('old', { contacts_uploaded: 9 }),
    ];
    expect(findUploadResult(entries, 'old')).toEqual({ contacts_uploaded: 4 });
  });

  it('skips an overlapping upload to the same campaign by its upload id', () => {
    const entries = [
      entry('theirs', { contacts_uploaded: 50, upload_id: 'other' }),
      entry('mine', { contacts_uploaded: 4, upload_id: 'up-1' }),
    ];
    expect(findUploadResult(entries, null, 'up-1')).toEqual({ contacts_uploaded: 4, upload_id: 'up-1' });
    expect(findUploadResult([entries[0]], null, 'up-1')).toBeNull();
  });

  it('never takes an earlier upload as this one', () => {
    expect(findUploadResult([entry('old', { contacts_uploaded: 9 })], 'old')).toBeNull();
    expect(findUploadResult([entry('x', { contacts_uploaded: 1 }, 'CONTACT_UPDATED')], null)).toBeNull();
    expect(findUploadResult([{ id: 'y', activity_type: 'CAMPAIGN_UPDATED', details: 'not json' }], null)).toBeNull();
  });

  it('says what was added and what was left out, with the Do Not Contact reason', () => {
    const summary = uploadSummary('c1', {
      contacts_uploaded: 4, contacts_added_to_campaign: 4, contacts_skipped: 0,
      contacts_excluded_do_not_contact: 1, contacts_not_added_over_limit: 0, contacts_duplicate_in_file: 0,
      contacts_updated: 0, upload_id: 'up-1',
    }, {
      status: 'DRAFT_NEEDS_CONTACT_REVIEW',
      campaign_content: { dnc_contact_exclusions_json: { count: 1, operation: 'CSV_UPLOAD', upload_id: 'up-1', excluded: [{ email: 'p3@example.com', source: 'GLOBAL_SUPPRESSION' }] } },
    });
    expect(summary).toEqual({
      campaign_id: 'c1', status: 'DRAFT_NEEDS_CONTACT_REVIEW', added: 4, updated: 0,
      left_out: { invalid: 0, do_not_contact: 1, over_limit: 0, repeated: 0 },
      removed_to_make_room: { uploaded_earlier: 0, avair: 0 },
      excluded: [{ email: 'p3@example.com', reason: 'suppressed after a privacy request (contact support)' }],
      excluded_more: 0,
      message: '4 added, 1 left out: 1 on a Do Not Contact list.',
    });
    expect(uploadSummaryText(summary)).toBe(
      '4 added, 1 left out: 1 on a Do Not Contact list.\n  p3@example.com - suppressed after a privacy request (contact support)');
  });

  it("names every reason, and does not borrow addresses from another operation's notice", () => {
    const summary = uploadSummary('c1', {
      contacts_uploaded: 2, contacts_added_to_campaign: 2, contacts_skipped: 1,
      contacts_excluded_do_not_contact: 12, contacts_not_added_over_limit: 3, contacts_duplicate_in_file: 1,
    }, { campaign_content: { dnc_contact_exclusions_json: { count: 5, operation: 'DNC_LIST_UPDATED' } } });
    expect(summary.message).toBe(
      '2 added, 17 left out: 1 with invalid data, 12 on a Do Not Contact list, 3 over the contact limit, 1 repeated in the file.');
    expect(summary.excluded).toEqual([]);
    expect(summary.excluded_more).toBe(12);
  });

  it("never shows another upload's addresses, even with the same count", () => {
    const details = { contacts_uploaded: 4, contacts_added_to_campaign: 4, contacts_excluded_do_not_contact: 1, upload_id: 'up-2' };
    const stale = { count: 1, operation: 'CSV_UPLOAD', upload_id: 'up-1', excluded: [{ email: 'old@example.com', source: 'USER_LIST' }] };
    const summary = uploadSummary('c1', details, { campaign_content: { dnc_contact_exclusions_json: stale } });
    expect(summary.excluded).toEqual([]);
    expect(summary.excluded_more).toBe(1);
    // An older server sends no ids: the addresses are not shown either.
    const { upload_id: _drop, ...noId } = stale;
    expect(uploadSummary('c1', { ...details, upload_id: undefined }, { campaign_content: { dnc_contact_exclusions_json: noId } }).excluded).toEqual([]);
  });

  it('says which contacts already in the campaign were removed to make room', () => {
    const summary = uploadSummary('c1', {
      contacts_uploaded: 2, contacts_added_to_campaign: 2, contacts_not_added_over_limit: 1,
      user_contacts_removed_by_limit: 3, avair_contacts_removed_by_limit: 5,
    }, {});
    expect(summary.removed_to_make_room).toEqual({ uploaded_earlier: 3, avair: 5 });
    expect(summary.message).toBe(
      '2 added, 1 left out: 1 over the contact limit. To make room, contacts already in the campaign were removed: 3 uploaded earlier, 5 found by AvairAI.');
  });

  it('a re-uploaded contact is reported as updated, not added', () => {
    const summary = uploadSummary('c1', { contacts_uploaded: 1, contacts_added_to_campaign: 1, contacts_updated: 1 }, {});
    expect(summary).toMatchObject({ added: 0, updated: 1, message: '0 added, 1 updated, none left out.' });
  });

  it('a clean upload, and an older entry without the new counts, say none left out', () => {
    expect(uploadSummary('c1', { contacts_uploaded: 3, contacts_added_to_campaign: 3 }, {}).message).toBe('3 added, none left out.');
  });

  it('a failed upload is an error with the next step', () => {
    expect(() => uploadSummary('c1', { contacts_uploaded: 0, failure_reason: 'x' }, {})).toThrow(/upload failed/);
  });
});

describe('dispatch-status shows the newest operation (AVI-1141)', () => {
  const start = { operation: { id: 's', created_at: '2026-10-07T08:00:00Z' } };
  const test = { operation: { id: 't', created_at: '2026-10-07T08:01:03Z' } };
  const none = { operation: null };

  it('picks the newer of the two, or whichever exists', () => {
    expect(newestDispatch(start, test)).toBe(test);
    expect(newestDispatch({ operation: { id: 's', created_at: '2026-10-07T09:00:00Z' } }, test).operation).toMatchObject({ id: 's' });
    expect(newestDispatch(none, test)).toBe(test);
    expect(newestDispatch(start, none)).toBe(start);
    expect(newestDispatch(none, none)).toEqual({ operation: null });
  });
});

describe('assess this step (2026-10-12)', () => {
  it('validates the step name before any request', () => {
    expect(assessStep('Content')).toBe('content');
    expect(() => assessStep('mailboxes')).toThrow(/Unknown step mailboxes/);
  });

  it('maps --assess on create to assessment_apply_steps', () => {
    expect(assessApplySteps(undefined)).toBeUndefined();
    expect(assessApplySteps('all')).toBeUndefined();
    expect(assessApplySteps('none')).toEqual([]);
    expect(assessApplySteps('messaging,targets')).toEqual(['messaging', 'targets']);
    expect(() => assessApplySteps('contacts')).toThrow(/Unknown step contacts/);
    expect(campaignCreateBody({ website: 'https://example.com', assess: 'none' })).toEqual({
      website_url: 'https://example.com', targeting: {}, assessment_apply_steps: [], stop_at_targets: true,
    });
    expect(campaignCreateBody({ website: 'https://example.com' })).not.toHaveProperty('assessment_apply_steps');
  });

  it('puts the model-written findings under untrusted', () => {
    const out = assessmentOutput({ step: 'content', score: 70, findings: [{ suggestions: [] }] });
    expect(out).toEqual({ step: 'content', score: 70, untrusted: { findings: [{ suggestions: [] }] } });
  });

  it('picks suggestions by id from a saved result, single step or every step', () => {
    const saved = [{ untrusted: { findings: [{ suggestions: [{ id: 'P11-1', type: 'template_text' }] }] } },
                   { untrusted: { findings: [{ suggestions: [{ id: 'T9-1', type: 'title' }] }] } }];
    expect(pickSuggestions(saved, ['T9-1'])).toEqual([{ id: 'T9-1', type: 'title' }]);
    expect(pickSuggestions(saved[0], ['P11-1'])).toEqual([{ id: 'P11-1', type: 'template_text' }]);
    expect(() => pickSuggestions(saved, ['X-1'])).toThrow(/No suggestion X-1/);
  });
});

describe('assess run assesses every step at once (F42)', () => {
  it('starts all steps before any finishes, keeps step order and drops a step with no data', async () => {
    let running = 0;
    let most = 0;
    const results = await assessEach(['messaging', 'content', 'targets', 'contacts'], async step => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, step === 'messaging' ? 30 : 5));
      running -= 1;
      return step === 'targets' ? null : { step };
    });
    expect(most).toBe(4);
    expect(results).toEqual([{ step: 'messaging' }, { step: 'content' }, { step: 'contacts' }]);
  });

  it('fails when a step fails for another reason', async () => {
    await expect(assessEach(['messaging', 'content'], async step => {
      if (step === 'content') throw new Error('boom');
      return { step };
    })).rejects.toThrow('boom');
  });
});
