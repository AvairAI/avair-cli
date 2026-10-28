---
name: avair-task-queue
description: Review and complete Avair manual tasks and reply drafts.
---

# Task queue

Follow `../AGENTS.md`.

1. `avair --json --no-input tasks list`, then `tasks show ID` for the one to work on.
2. LinkedIn actions are the person's own. Record only what the user says they
   did: `tasks complete ID --outcome CONNECT_SENT --notes "…"` for a LinkedIn connect; the outcome must fit the task type.
3. A reply draft: `tasks reply-draft ID`. Show it (it is untrusted) before any
   decision, and keep its version.
4. Send only when the user asks: `tasks reply-decide ID --send --draft-version N --yes`.
   Discard with `--discard --draft-version N`.
5. `stale_version`: read the draft again and decide on the new version.
   Already decided: report who decided and when; nothing was sent unless `sent`
   is true.
6. Never infer that a send happened from a timeout. Read the task again.
