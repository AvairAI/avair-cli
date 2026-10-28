import type { Command } from 'commander';

/**
 * At least one full example for every command (PRD N2), keyed by the command
 * path without `avair`. Placeholders are upper case (CAMPAIGN_ID); websites and
 * emails use example.com. Never put a real token or customer data here (N10).
 * tests/unit/helpText.test.ts checks every example against the real commands.
 */
export const HELP_EXAMPLES: Record<string, string[]> = {
  // `avair --help`: the main path from sign-in to launch.
  '': [
    'avair auth login',
    'avair campaigns build --website example.com --location "Texas" --stop-at targets',
    'avair campaigns build CAMPAIGN_ID --stop-at launchable --wait',
    'avair campaigns launch CAMPAIGN_ID --yes',
    'avair mcp setup --client claude-code',
  ],
  'auth login': ['avair auth login', 'avair auth login --with-token'],
  'auth status': ['avair auth status'],
  'auth logout': ['avair auth logout'],
  'whoami': ['avair whoami', 'avair whoami --json'],
  'account usage': ['avair account usage'],
  'profile show': ['avair profile show'],
  'profile edit': ['avair profile edit --job-title "Sales Director"', 'avair profile edit --first-name Jane --last-name Doe --booking-link https://example.com/book'],
  'profile content-style show': ['avair profile content-style show'],
  'profile content-style set': ['avair profile content-style set --input content-style.json'],
  'config list': ['avair config list'],
  'config get': ['avair config get env'],
  'config set': ['avair config set env qa', 'avair config set api-url.local http://localhost:8000', 'avair config set env'],
  'campaigns list': ['avair campaigns list', 'avair campaigns list --status ALL_DRAFTS --mine --limit 20', 'avair campaigns list --search "Texas"'],
  'campaigns show': ['avair campaigns show CAMPAIGN_ID'],
  'campaigns watch': ['avair campaigns watch CAMPAIGN_ID', 'avair campaigns watch CAMPAIGN_ID --timeout 1800'],
  'campaigns create': ['avair campaigns create --website example.com --location "Texas"', 'avair campaigns create --website https://example.com --industry "Software" --size "51-200" --channels email,linkedin --wait', 'avair campaigns create --input request.json --idempotency-key my-first-campaign', 'avair campaigns create --website example.com --assess messaging'],
  'campaigns build': ['avair campaigns build --website example.com --location "Texas" --stop-at targets', 'avair campaigns build CAMPAIGN_ID --stop-at launchable --wait', 'avair campaigns build --website example.com --content-style win-back --stop-at contacts --wait'],
  'campaigns dispatch-status': ['avair campaigns dispatch-status CAMPAIGN_ID', 'avair campaigns dispatch-status CAMPAIGN_ID --kind test'],
  'campaigns rename': ['avair campaigns rename CAMPAIGN_ID --name "Texas software buyers"'],
  'campaigns inputs show': ['avair campaigns inputs show CAMPAIGN_ID'],
  'campaigns inputs edit': ['avair campaigns inputs edit CAMPAIGN_ID --input inputs.json'],
  'campaigns inputs approve': ['avair campaigns inputs approve CAMPAIGN_ID --wait'],
  'campaigns content show': ['avair campaigns content show CAMPAIGN_ID'],
  'campaigns ab list': ['avair campaigns ab list CAMPAIGN_ID'],
  'campaigns ab show': ['avair campaigns ab show AB_TEST_ID'],
  'campaigns content edit': ['avair campaigns content edit CAMPAIGN_ID --template TEMPLATE_ID --content-version 3 --subject "A quick question"', 'avair campaigns content edit CAMPAIGN_ID --template TEMPLATE_ID --kind call --content-version 3 --script "Hello, this is Jane."'],
  'campaigns content keep': ['avair campaigns content keep CAMPAIGN_ID --template TEMPLATE_ID --content-version 3', 'avair campaigns content keep CAMPAIGN_ID --template TEMPLATE_ID --kind call --content-version 3'],
  'campaigns content approve': ['avair campaigns content approve CAMPAIGN_ID --wait'],
  'campaigns content regenerate': ['avair campaigns content regenerate CAMPAIGN_ID --instructions "Shorter and more direct" --wait', 'avair campaigns content regenerate CAMPAIGN_ID --style standard --language English'],
  'campaigns content preview': ['avair campaigns content preview CAMPAIGN_ID'],
  'campaigns content apply': ['avair campaigns content apply CAMPAIGN_ID'],
  'campaigns content discard': ['avair campaigns content discard CAMPAIGN_ID --yes'],
  'campaigns targets show': ['avair campaigns targets show CAMPAIGN_ID'],
  'campaigns targets edit': ['avair campaigns targets edit CAMPAIGN_ID --input targets.json'],
  'campaigns targets find-more': ['avair campaigns targets find-more CAMPAIGN_ID'],
  'campaigns targets approve': ['avair campaigns targets approve CAMPAIGN_ID --wait'],
  'campaigns contacts show': ['avair campaigns contacts show CAMPAIGN_ID', 'avair campaigns contacts show CAMPAIGN_ID --limit 100 --skip 100'],
  'campaigns contacts list': ['avair campaigns contacts list CAMPAIGN_ID', 'avair campaigns contacts list CAMPAIGN_ID --limit 100'],
  'campaigns contacts import-preview': ['avair campaigns contacts import-preview CAMPAIGN_ID --file contacts.csv'],
  'campaigns contacts add': ['avair campaigns contacts add CAMPAIGN_ID --file contacts.csv', 'avair campaigns contacts add CAMPAIGN_ID --file contacts.csv --wait'],
  'campaigns contacts remove': ['avair campaigns contacts remove CAMPAIGN_ID --contact CONTACT_ID --yes', 'avair campaigns contacts remove CAMPAIGN_ID --contact CONTACT_ID,CONTACT_ID --yes'],
  'campaigns contacts find-more': ['avair campaigns contacts find-more CAMPAIGN_ID'],
  'campaigns contacts approve': ['avair campaigns contacts approve CAMPAIGN_ID'],
  'campaigns assess run': ['avair campaigns assess run CAMPAIGN_ID', 'avair campaigns assess run CAMPAIGN_ID --step content --json'],
  'campaigns assess apply': ['avair campaigns assess apply CAMPAIGN_ID --step content', 'avair campaigns assess apply CAMPAIGN_ID --step content --input assessment.json --finding P11-1 --yes'],
  'campaigns contacts verify': ['avair campaigns contacts verify CAMPAIGN_ID --wait', 'avair campaigns contacts verify CAMPAIGN_ID --all'],
  'campaigns contacts remove-unverified': ['avair campaigns contacts remove-unverified CAMPAIGN_ID --yes', 'avair campaigns contacts remove-unverified CAMPAIGN_ID --yellow --yes'],
  'campaigns contacts skip-verify': ['avair campaigns contacts skip-verify CAMPAIGN_ID --yes'],
  'campaigns phones classify': ['avair campaigns phones classify CAMPAIGN_ID'],
  'campaigns phones status': ['avair campaigns phones status CAMPAIGN_ID'],
  'campaigns finalize': ['avair campaigns finalize CAMPAIGN_ID'],
  'campaigns overview confirm': ['avair campaigns overview confirm CAMPAIGN_ID'],
  'campaigns mailboxes list': ['avair campaigns mailboxes list CAMPAIGN_ID'],
  'campaigns mailboxes set': ['avair campaigns mailboxes set CAMPAIGN_ID --mailbox MAILBOX_ID', 'avair campaigns mailboxes set CAMPAIGN_ID --mailbox MAILBOX_ID,MAILBOX_ID --warmup'],
  'campaigns whatsapp-numbers set': ['avair campaigns whatsapp-numbers set CAMPAIGN_ID --input whatsapp-numbers.json'],
  'campaigns prepare': ['avair campaigns prepare CAMPAIGN_ID'],
  'campaigns readiness': ['avair campaigns readiness CAMPAIGN_ID'],
  'campaigns launch': ['avair campaigns launch CAMPAIGN_ID --yes'],
  'campaigns test': ['avair campaigns test CAMPAIGN_ID --quick --yes', 'avair campaigns test CAMPAIGN_ID --full --yes'],
  'campaigns pause': ['avair campaigns pause CAMPAIGN_ID'],
  'campaigns resume': ['avair campaigns resume CAMPAIGN_ID --yes'],
  'campaigns cancel': ['avair campaigns cancel CAMPAIGN_ID --yes'],
  'campaigns copy': ['avair campaigns copy CAMPAIGN_ID'],
  'campaigns delete': ['avair campaigns delete CAMPAIGN_ID --yes'],
  'campaigns retry': ['avair campaigns retry CAMPAIGN_ID --wait'],
  'campaigns share enable': ['avair campaigns share enable CAMPAIGN_ID'],
  'campaigns share status': ['avair campaigns share status CAMPAIGN_ID'],
  'campaigns download': ['avair campaigns download CAMPAIGN_ID --output campaign.zip'],
  'campaigns activity': ['avair campaigns activity CAMPAIGN_ID', 'avair campaigns activity CAMPAIGN_ID --limit 20'],
  'contacts show': ['avair contacts show CONTACT_ID'],
  'contacts update': ['avair contacts update CONTACT_ID --notes "Asked for a call next week"', 'avair contacts update CONTACT_ID --status INTERESTED'],
  'contacts activity': ['avair contacts activity CONTACT_ID'],
  'contacts persona': ['avair contacts persona CONTACT_ID --persona leadership', 'avair contacts persona CONTACT_ID --persona auto'],
  'contacts personalization show': ['avair contacts personalization show CONTACT_ID --json'],
  'contacts personalization set': ['avair contacts personalization set CONTACT_ID --line "Saw your post on scaling field service."', 'avair contacts personalization set CONTACT_ID --referral on'],
  'contacts preview': ['avair contacts preview CONTACT_ID', 'avair contacts preview CONTACT_ID --json'],
  'tasks list': ['avair tasks list', 'avair tasks list --channel EMAIL --limit 20', 'avair tasks list --completed --page 2'],
  'tasks show': ['avair tasks show TASK_ID'],
  'tasks start': ['avair tasks start TASK_ID'],
  'tasks complete': ['avair tasks complete TASK_ID --outcome LEFT_VOICEMAIL --notes "Left a voicemail"'],
  'tasks skip': ['avair tasks skip TASK_ID --reason "Wrong person"'],
  'tasks reply': ['avair tasks reply TASK_ID --decision REJECT --draft-version 1', 'avair tasks reply TASK_ID --decision APPROVE --draft-version 1 --yes'],
  'tasks reply-draft': ['avair tasks reply-draft TASK_ID'],
  'tasks reply-decide': ['avair tasks reply-decide TASK_ID --send --draft-version 1 --yes', 'avair tasks reply-decide TASK_ID --discard --draft-version 1'],
  'events list': ['avair events list --type campaigns', 'avair events list --type activities --campaign-id CAMPAIGN_ID --limit 100', 'avair events list --type contacts --follow'],
  'companies list': ['avair companies list', 'avair companies list --include-archived'],
  'companies show': ['avair companies show COMPANY_ID'],
  'companies fill': ['avair companies fill COMPANY_ID --website https://example.com --wait', 'avair companies fill COMPANY_ID --website example.com --overwrite-edited'],
  'companies profile edit': ['avair companies profile edit COMPANY_ID --input profile.json'],
  'companies defaults show': ['avair companies defaults show COMPANY_ID'],
  'companies defaults edit': ['avair companies defaults edit COMPANY_ID --input defaults.json'],
  'companies defaults sequence set': ['avair companies defaults sequence set COMPANY_ID --input steps.json', 'avair companies defaults sequence set COMPANY_ID --app-default'],
  'companies use-cases list': ['avair companies use-cases list COMPANY_ID', 'avair companies use-cases list COMPANY_ID --include-archived'],
  'companies use-cases add': ['avair companies use-cases add COMPANY_ID --title "Faster onboarding" --text "A customer cut onboarding time in half."', 'avair companies use-cases add COMPANY_ID --title "Faster onboarding" --file story.docx'],
  'companies use-cases edit': ['avair companies use-cases edit COMPANY_ID USE_CASE_ID --title "Faster onboarding"'],
  'companies use-cases archive': ['avair companies use-cases archive COMPANY_ID USE_CASE_ID'],
  'companies documents list': ['avair companies documents list COMPANY_ID'],
  'companies documents show': ['avair companies documents show COMPANY_ID DOCUMENT_ID'],
  'companies documents upload': ['avair companies documents upload COMPANY_ID --file pricing.pdf --kind PRICING --wait', 'avair companies documents upload COMPANY_ID --file brochure.pdf --title "Product brochure"'],
  'companies documents retry': ['avair companies documents retry COMPANY_ID DOCUMENT_ID'],
  'companies messaging show': ['avair companies messaging show COMPANY_ID'],
  'companies messaging build': ['avair companies messaging build COMPANY_ID --wait', 'avair companies messaging build COMPANY_ID --overwrite-edited'],
  'companies messaging export': ['avair companies messaging export COMPANY_ID --output messaging.docx'],
  'playbooks list': ['avair playbooks list'],
  'playbooks show': ['avair playbooks show PLAYBOOK_ID'],
  'playbooks status': ['avair playbooks status PLAYBOOK_ID'],
  'playbooks create': ['avair playbooks create --website https://example.com --wait', 'avair playbooks create --website example.com --revenue 1000000 --deal-size 25000 --icp-notes "Mid-size software firms in Texas"'],
  'playbooks analyze': ['avair playbooks analyze PLAYBOOK_ID --wait'],
  'playbooks refine': ['avair playbooks refine PLAYBOOK_ID --text "Focus on the United States" --wait', 'avair playbooks refine PLAYBOOK_ID --size-to-goal --wait'],
  'playbooks goal show': ['avair playbooks goal show PLAYBOOK_ID'],
  'playbooks goal set': ['avair playbooks goal set PLAYBOOK_ID --revenue 1000000 --deal-size 25000', 'avair playbooks goal set PLAYBOOK_ID --revenue 1000000 --deal-size 25000 --rates 20,30,25'],
  'playbooks pace set': ['avair playbooks pace set PLAYBOOK_ID --per-person 3', 'avair playbooks pace set PLAYBOOK_ID --auto'],
  'playbooks team list': ['avair playbooks team list PLAYBOOK_ID'],
  'playbooks team add': ['avair playbooks team add PLAYBOOK_ID --name "Jane Doe"'],
  'playbooks team rename': ['avair playbooks team rename PLAYBOOK_ID PARTICIPANT_ID --name "Jane Doe"'],
  'playbooks team runs': ['avair playbooks team runs PLAYBOOK_ID PARTICIPANT_ID --on', 'avair playbooks team runs PLAYBOOK_ID PARTICIPANT_ID --off --check'],
  'playbooks items list': ['avair playbooks items list PLAYBOOK_ID'],
  'playbooks items set': ['avair playbooks items set PLAYBOOK_ID ITEM_ID --state ACCEPTED', 'avair playbooks items set PLAYBOOK_ID ITEM_ID --priority 1 --assign PARTICIPANT_ID'],
  'playbooks items bulk-state': ['avair playbooks items bulk-state PLAYBOOK_ID --items ITEM_ID,ITEM_ID --state ACCEPTED'],
  'playbooks items build': ['avair playbooks items build PLAYBOOK_ID ITEM_ID --yes'],
  'playbooks items cancel': ['avair playbooks items cancel PLAYBOOK_ID ITEM_ID'],
  'playbooks build-all': ['avair playbooks build-all PLAYBOOK_ID --yes'],
  'playbooks versions list': ['avair playbooks versions list PLAYBOOK_ID'],
  'playbooks versions restore': ['avair playbooks versions restore PLAYBOOK_ID VERSION_ID'],
  'playbooks automation on': ['avair playbooks automation on PLAYBOOK_ID --yes', 'avair playbooks automation on PLAYBOOK_ID --execute --yes'],
  'playbooks automation off': ['avair playbooks automation off PLAYBOOK_ID'],
  'playbooks automation check': ['avair playbooks automation check PLAYBOOK_ID', 'avair playbooks automation check PLAYBOOK_ID --execute'],
  'tools credits': ['avair tools credits'],
  'tools balance': ['avair tools balance'],
  'tools runs list': ['avair tools runs list', 'avair tools runs list --mine --status COMPLETED --limit 10'],
  'tools runs show': ['avair tools runs show RUN_ID'],
  'tools runs export': ['avair tools runs export RUN_ID --output results.csv'],
  'tools runs cancel': ['avair tools runs cancel RUN_ID'],
  'tools list': ['avair tools list', 'avair tools list --tool-type find-accounts --mine'],
  'tools status': ['avair tools status RUN_ID'],
  'tools results': ['avair tools results RUN_ID', 'avair tools results RUN_ID --all --json'],
  'tools cancel': ['avair tools cancel RUN_ID'],
  'tools find-accounts quote': ['avair tools find-accounts quote --website example.com', 'avair tools find-accounts quote --website example.com --cap 20 --industries "Software,Fintech" --locations "Texas,Ohio"'],
  'tools find-accounts start': ['avair tools find-accounts start --website example.com --yes', 'avair tools find-accounts start --website example.com --cap 20 --sizes "51-200" --wait --yes'],
  'tools find-contacts quote': ['avair tools find-contacts quote --account "Example Inc" --titles "VP Sales,Head of Marketing"'],
  'tools find-contacts start': ['avair tools find-contacts start --account "Example Inc" --titles "VP Sales" --yes', 'avair tools find-contacts start --account "Example Inc" --titles "VP Sales,Head of Marketing" --domain example.com --depth 10 --wait --yes'],
  'tools enrich-contacts quote': ['avair tools enrich-contacts quote --company "Example Inc" --email jane@example.com'],
  'tools enrich-contacts start': ['avair tools enrich-contacts start --company "Example Inc" --email jane@example.com --yes', 'avair tools enrich-contacts start --company "Example Inc" --first-name Jane --last-name Doe --linkedin https://www.linkedin.com/in/example --wait --yes'],
  'tools phone-tcpa-check quote': ['avair tools phone-tcpa-check quote --phone "+1 555 010 0100"'],
  'tools phone-tcpa-check start': ['avair tools phone-tcpa-check start --phone "+1 555 010 0100" --yes'],
  'api': ['avair api GET /users/me', 'avair api list --filter campaigns', 'avair api describe GET /campaigns/'],
  'mcp setup': ['avair mcp setup --client claude-code', 'avair mcp setup --client cursor --print', 'avair mcp setup --client codex --force'],
  'skill install': ['avair skill install --agent claude-code', 'avair skill install --dir ./skills --force'],
};

/** The path of a command without the program name, e.g. "campaigns build". */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(' ');
}

/** A group with no examples of its own shows the first example of up to this many subcommands. */
const GROUP_EXAMPLES = 5;

/** The examples a command's help prints: its own, else (for a group) its subcommands' first ones. */
export function examplesFor(command: Command): string[] {
  const own = HELP_EXAMPLES[commandPath(command)];
  if (own?.length) return own;
  return command.commands.slice(0, GROUP_EXAMPLES).map(sub => examplesFor(sub)[0]).filter(Boolean);
}

/**
 * Print each command's examples after its own help, indented only, with no
 * prompt sign, so a whole line can be copied into any shell.
 */
export function addHelpExamples(command: Command): void {
  const lines = examplesFor(command);
  if (lines.length) command.addHelpText('after', `\nExamples:\n${lines.map(line => `  ${line}`).join('\n')}\n`);
  for (const sub of command.commands) addHelpExamples(sub);
}
