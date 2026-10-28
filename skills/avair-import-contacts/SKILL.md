---
name: avair-import-contacts
description: Check and import the user's own contacts into an Avair campaign safely.
---

# Import contacts

Follow `../AGENTS.md`.

1. Identify the company (`whoami`) and the campaign id.
   An upload works only while the campaign is at Review Contacts, Ready to Test
   or Ready to Launch. A launched campaign refuses it (exit 6): new contacts
   reach a running campaign only through Live Contact Search in the Avair app.
2. Check the file on this computer first:
   `avair --json --no-input campaigns contacts import-preview ID --file contacts.csv`.
   Report rows it would reject and repeated addresses. It cannot see the Do Not
   Contact list or the contact limit.
3. **Stop** when rows are rejected, and ask before importing.
4. Import and wait for the result:
   `campaigns contacts add ID --file contacts.csv --wait`. Report what was added
   and what was left out, and why (invalid data, Do Not Contact, over the limit,
   repeated in the file).
5. An import does not verify addresses. Verify only when asked:
   `campaigns contacts verify ID --wait`, then
   `campaigns contacts remove-unverified ID --yes` only after the user agrees.
6. On exit 11 the upload still runs: check with `campaigns contacts list ID`
   before uploading again.
