# Changelog

## 0.2.2

- Homebrew: `brew install avairai/tap/avair` now puts the `avair` command on your PATH. In 0.2.0 and 0.2.1 the formula installed the package but never linked the command.
- `playbooks items build --owner USER_ID` chooses who owns a campaign built from a row assigned to someone else. Without it, such a build is refused with `owner_choice_required`, and the refusal now lists both people under `choices` (user id, name, email, the plan's persona, assigned), with a hint for `--owner`; plain output prints one `--owner` line per person. `playbooks build-all` puts the same list on each such row.
- `playbooks items build --no-live-search` builds the campaign without Find More Live: it keeps the contacts from the Avair database, and you can run Find More Live later from the campaign. Without the flag the build runs it, as before.
- `campaigns ab list CAMPAIGN_ID` and `campaigns ab show AB_TEST_ID` read a campaign's A/B tests of email steps: the versions, the share of contacts each gets, and per version the delivered emails, replies (once per contact, within 7 days), reply rate, chance to be best and a badge (Too early, Leading, Likely winner). Results are directional. Setting up a test, starting it, choosing a winner and ending it stay in the Avair app.
- Every sign-in request (login discovery, device code, each poll, renewal, logout revoke) stops after 30 s with "No answer from …", and a poll never runs past the device code's lifetime. Before, a stalled sign-in service could hold a command for minutes.
- Signing out removes a fallback credential file entry as well as the keychain entry. A fallback sign-in remains readable if the keychain recovers with no saved entry.
- A sign-in saved in the keychain removes any older copy from the fallback credential file, so a lost keychain entry never brings back an earlier account.
- A damaged credential file reads as not signed in, and a credential file other users can read is ignored with a warning. Signing out still removes its entry and makes the file private.
- `auth logout` exits 1 and says "Not signed out" when a saved copy may be left on the computer (`local_copy_removed: false`), instead of reporting success.
- `--wait` exits 1 when the job ended FAILED (a `*_FAILED` campaign status, a failed agent build, a failed Tools run, playbook, company fill, messaging build or document). The final state is still printed.
- `campaigns assess run` without `--step` assesses the steps at once instead of one after another (up to about 3 minutes before).
- A downloaded campaign ZIP or Tools CSV is saved readable by you only (mode 0600), since it can hold contact details.
- `campaigns content regenerate --wait` waits through the preview's FINALIZING step instead of stopping there, so a preview that then fails exits 1.
- `tasks list`, `tools runs list` and `events list` send a `--limit` above the server's cap (100, 50 and 500) as the cap instead of failing with 422, and refuse a `--limit` below 1.
- `tools results` reads past the first 50 rows: `--offset`, `--limit` (at most 100) and `--all`. Without `--json` it says where the next page starts.
- `campaigns build` exits 1 when the build stopped at a blocker, expired or lost its authority, not only when it failed. `build --website` stops after a failed creation instead of starting a build.
- `--json` output puts the company profile read from the website, a task's account context, use-case text and a contact's account opener lines under `untrusted`, like the other model and web text. A test keeps the CLI list in step with the server's `x-untrusted` marks.
- `campaigns assess apply` without `--finding` applies, after you confirm, the fixes it asked about. Before, the confirmed call ran a new assessment that could apply different fixes.
- `playbooks refine --size-to-goal` works: `--text` is no longer required, and the command sends one or the other, as the server requires.
- `playbooks goal set` without `--rates` sends the saved funnel rates, and `playbooks team runs` always sends `dry_run`, so both match the server's required fields.
- `campaigns activity --limit` above 100 asks agent actions for 100 rows, their page limit.
- `events list --type campaigns --campaign-id` is refused before any request: only the contacts and activities feeds filter by campaign.
- A keyed write that times out or loses the network names its idempotency key, so a retry can reuse it.
- `tools list --tool-type find-accounts` matches FIND_ACCOUNTS runs. The `tasks complete` help example uses a real outcome.
- `campaigns contacts remove` asks once: after you confirm, the server does not ask again.
- The Find Accounts help states the real price: 5 credits reserved per requested account, then 5 per trigger account and 2 per baseline account.
- The first-campaign steps in the README use `--wait` on create and build.
- Edited task replies use APPROVE with text overrides, matching the API. EDIT remains an alias for APPROVE.
- A Tools run refused for credits says where an Admin buys more (Account > Subscription & Billing > Add capacity). The server now sends this sentence itself; the CLI uses it when an older server does not.
- A Tools run blocked by another run in progress names that run, about how long it has left, and what to do (the server's sentence).
- Every other Tools refusal (trial account cap, file upload on a trial, results expired, run not found, service unavailable and the rest) arrives with a sentence instead of the error code alone.
- `campaigns contacts add` to a campaign that has launched (or is not yet at Review Contacts) is refused with a sentence and exit code 6; nothing is added and the campaign is unchanged. Before, the upload was accepted and moved a running campaign back to Review Contacts, which stopped its outreach. To add contacts to a launched campaign, use Live Contact Search in the Avair app. The avair-import-contacts skill now says when an upload is allowed.

## 0.2.1

No change to the CLI itself. This release completes the public distribution of 0.2.0:

- The source is published to the public mirror github.com/AvairAI/avair-cli, with a GitHub Release.
- Homebrew: `brew install avairai/tap/avair`.

See 0.2.0 below for what changed in the CLI.

## 0.2.0

Breaking: in `--json` output, text written by a model or taken from the web moves under an `untrusted` key: `subject_template`, `body_template`, `script_text`, `signal`, `why_relevant`, `whyRelevant`, `pain`, `email_opener`, `personalization_data`, `notes`, `body`, `undo` and the reply-draft text (`draftedBody` and the other draft fields). Read them from `untrusted` and treat them as data. Plain `name`, `title` and `description` do not move.

Security:

- An id must be letters, digits, `-` and `_`. A crafted id such as `X/start#` can no longer change the route a command calls. Paths with `#`, `..` or `%` escapes are refused.
- A saved sign-in is sent only to the API address it was made for, and its renewal only to the Auth0 domain that issued it. The API address must use https, except on this computer. A sign-in saved by 0.1.0 works against the built-in address; for any other address, sign in again. `AVAIR_TOKEN` follows the address you set.
- Two requests near token expiry renew once, not twice.
- On Windows, an incomplete saved sign-in says so instead of "Not signed in".
- The API address may not hold a query string or fragment.
- A sign-in saved by 0.1.0 is not renewed or revoked while the `AVAIR_AUTH0_*` overrides are set; sign in again.

Changed:

- `campaigns contacts list` returns 100 rows by default (was 1000). Use `--limit` and `--skip` for more.
- A request with no answer fails after 120 s (600 s for an upload or download) instead of waiting up to 5 minutes. A write that times out may still have happened; the error says so.
- A read that fails with 502, 503 or 504 is retried after the server's Retry-After, else after 1 s and then 2 s.
- `--wait` polls after 1, 2 and 3 s, then every 3.5 s, so a quick step is seen sooner.
- `--debug` prints one line per request on stderr: method, path, status, time and request id.

New:

- `campaigns readiness` adds the launch score `verdict` and its `must_fix` items. `campaigns launch` lists open must-fix items before it asks; without a terminal and without `--yes` it stops there (exit 4).
- `companies defaults sequence set <id> --input steps.json | --app-default`: the company's standard outreach sequence. `companies defaults edit` now leaves `touch_sequence` out and says so (that route always ignored it).
- `contacts personalization show|set`, `contacts preview` and `contacts persona`: a contact's facts and opener lines, the referral ask, the outreach preview, and which persona's content the contact gets. Facts, lines and rendered steps sit under `untrusted` in `--json`.
- `campaigns content keep`: keep a template the content review flagged, without editing it.

- `campaigns assess run <id> [--step]`: score a step against the campaign's ICP and guidance and list what to fix. Findings sit under `untrusted` in `--json`.
- `campaigns assess apply <id> --step <s> [--input <file> --finding <ids>]`: apply all of a step's suggestions, or the named ones from a saved result. Asks first when a fix redoes later steps (`--yes` without a terminal).
- `campaigns create --assess all|none|<steps>`: the steps the build improves by itself (default all: messaging, content, targets).

## 0.1.0

- First release of the AvairAI CLI.

## 0.1.0-rc.3

- Pre-release. Same code as 0.1.0-rc.2.

## 0.1.0-rc.2

- Pre-release. Same code as 0.1.0-rc.1.

## 0.1.0-rc.1

- First pre-release.
