# Avair CLI

The Avair CLI gives a user-bound agent access to campaigns, manual tasks,
playbooks, company knowledge, and paid Tools without sharing a browser session.
The same account is available as a remote MCP connector.

## Install

Node.js 22 or later:

```bash
npm install -g @avair/cli
```

Upgrade with the same npm command. Before removal, run
`avair auth logout`, then use `npm rm -g @avair/cli`.

## Sign in

```bash
avair auth login
avair whoami
```

Use the same sign-in method as the Avair app. For CI, create a personal access
token in **Account → AI Agents**, set it as `AVAIR_TOKEN`, and add
`--json --no-input`. Never put a token in command arguments or source control.

## First campaign in five commands

These commands assume a connected mailbox and a verified sending domain. Replace
`CAMPAIGN_ID` with the id returned by the first command.

```bash
avair campaigns create --website https://example.com --location "United States" --industry "Logistics" --wait
avair campaigns targets show CAMPAIGN_ID
avair campaigns targets approve CAMPAIGN_ID
avair campaigns build CAMPAIGN_ID --stop-at launchable --wait
avair --yes campaigns launch CAMPAIGN_ID
```

Review targets and contacts before approving them. `--yes` confirms that the last
command may start live outreach. If a write has an unknown outcome, inspect its
returned id or run `avair campaigns dispatch-status CAMPAIGN_ID`; never repeat it
under a new idempotency key.

## Connect an MCP client

Sign in with the CLI first so the command can obtain the environment's MCP URL.
The setup command never writes a token into client configuration.

```bash
avair mcp setup --client claude-code
avair mcp setup --client cursor
avair mcp setup --client codex
```

Use `--print` to preview a change and `--force` to replace an existing Avair
entry. Claude.ai, Claude Desktop, and ChatGPT manage remote connectors in their
own settings; print their instructions with the corresponding client name:

```bash
avair mcp setup --client claude-ai --print
avair mcp setup --client claude-desktop --print
avair mcp setup --client chatgpt --print
```

The MCP client performs its own OAuth sign-in. PAT authentication is a fallback
for clients and automation that cannot complete OAuth.

## Agent skills and help

Install the bundled recipe skills with `avair skill install --agent claude-code`
or `avair skill install --agent codex`. Run `avair --help` for the command
catalog.

- CLI guide: https://www.avair.ai/resources/cli
- MCP guide: https://www.avair.ai/resources/mcp
- Support: support@avair.ai
- Security reports: security@avair.ai

The public repository is a one-way release mirror. Report defects through its
issue templates; changes are made in Avair's product repository.
