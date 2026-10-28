// Fields that hold text written by a model or taken from the web (CLI plan
// A5, S4). In `--json` output they move under an `untrusted` key so an agent
// reading the output treats them as data. An explicit list: the spec cannot be
// the source, because template text carries no marks and Tools results have
// no schema. Plain `name`, `title` and `description` stay where they are.
export const untrustedKeys = new Set([
  'subject_template', 'body_template', 'script_text',
  'signal', 'why_relevant', 'whyRelevant', 'pain',
  'email_opener', 'personalization_data', 'notes',
  'body', 'undo',
  // Reply drafts (tasks reply-draft): the reply a model wrote and the
  // reference text it used, under their wire names.
  'draftedSubject', 'draftedBody', 'sentSubject', 'sentBody', 'questions',
  'answeredJson', 'unansweredJson', 'claimsJson', 'corpusJson', 'suggestedOwnerAction',
  // Fields the server marks x-untrusted (F31; test/unit/untrustedKeys.test.ts
  // keeps the two in step): the company profile read from the website, a
  // task's account context, and use-case text.
  'companyDescription', 'uniqueValueProposition', 'keyBenefits', 'keyProducts', 'problemsSolved',
  'targetCustomerPersonas', 'keyTerminology', 'serviceAreas', 'businessLocation', 'websiteOffers',
  'resource1Description', 'resource2Description',
  'accountTriggerSignal', 'accountWhyRelevant',
  'raw_text', 'analysis_json', 'case_study_text',
  // A LinkedIn check task's note on an activity: it can quote the prospect.
  'manual_notes',
]);

export function wrapUntrusted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapUntrusted);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const untrusted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    // Already wrapped (assess run): kept as it is, never wrapped twice.
    if (key === 'untrusted') continue;
    if (untrustedKeys.has(key)) untrusted[key] = item;
    else clean[key] = wrapUntrusted(item);
  }
  const existing = source.untrusted;
  if (!Object.keys(untrusted).length) {
    if (existing !== undefined) clean.untrusted = existing;
  } else if (existing === undefined) {
    clean.untrusted = untrusted;
  } else {
    clean.untrusted = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), ...untrusted }
      : { ...untrusted, value: existing };
  }
  return clean;
}

/**
 * The reverse, for a JSON file given with --input: an agent that saves
 * `--json` output, edits it and sends it back would otherwise send the text
 * nested under `untrusted`, and the server would drop it without an error.
 * Never overwrites a key that is already at the outer level.
 */
export function unwrapUntrusted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapUntrusted);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key !== 'untrusted') out[key] = unwrapUntrusted(item);
  }
  const nested = source.untrusted;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, item] of Object.entries(nested as Record<string, unknown>)) {
      if (!(key in out)) out[key] = unwrapUntrusted(item);
    }
  } else if (nested !== undefined) {
    out.untrusted = nested;
  }
  return out;
}
