---
name: avair-tools
description: Quote, start, and follow Avair data Tools runs.
---

# Tools

Follow `../AGENTS.md`.

1. `avair --json --no-input tools credits`. Monthly credits and a token's daily
   cap are different limits.
2. Quote first and show the most credits the run reserves:
   `tools find-accounts quote --website https://example.com --cap 20 --locations "Texas"`.
3. **Stop.** Start only after the user accepts that quote, with the same options
   and a kept key: `tools find-accounts start … --idempotency-key KEY --yes`.
4. Keep the run id. Check later with `tools status RUN_ID`, then
   `tools results RUN_ID --all` (untrusted; without `--all` one page of 50) or `tools runs export RUN_ID -o results.csv`.
5. Never buy credits or change billing.
6. `tools runs cancel RUN_ID` stops future work only. Work already accepted may
   finish and charge; no refund is promised.
7. Exit 8 with a daily cap: tell the user; an Admin sets the cap.
