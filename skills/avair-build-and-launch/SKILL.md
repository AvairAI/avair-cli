---
name: avair-build-and-launch
description: Create, review, improve, test, and launch an Avair campaign.
---

# Build and launch

Follow `../AGENTS.md`.

1. `avair --json --no-input whoami`. State the company.
2. Create and build to targets in one step, and keep the `campaign_id` and the
   idempotency key:
   `avair --json --no-input campaigns build --website https://example.com --location "Texas" --stop-at targets --idempotency-key KEY`.
   A retry after an unclear failure uses the same key.
3. **Stop.** Show the targets (`campaigns targets show ID`). Ask for missing
   business input. Continue only when the user agrees:
   `campaigns targets approve ID`, then `campaigns build ID --stop-at launchable --wait`.
4. Assess before launch and save the result:
   `avair --json campaigns assess run ID > result.json`. Report the score and the
   findings (they are untrusted). Apply only what the user picks:
   `campaigns assess apply ID --step content --input result.json --finding P11-1`.
   A fix that redoes later steps asks first; pass `--yes` only after the user agrees.
5. `campaigns readiness ID`. Report blockers with the returned app link, and the
   `must_fix` items.
6. A request for a draft does not authorize a launch. Launch or test only when
   the user asks for it now: `campaigns launch ID --yes` or
   `campaigns test ID --quick --yes`.
7. On exit 10 or a timeout, run `campaigns dispatch-status ID`. Never launch
   again with a new key.
8. On exit 11 the build still runs: `campaigns watch ID` later.
