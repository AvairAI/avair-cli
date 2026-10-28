import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import { client, emit } from './shared.js';
import { apiPath } from '../lib/path.js';

type Personalization = { facts?: unknown; lines?: unknown; account_lines?: unknown; status?: unknown; as_of?: unknown; [field: string]: unknown };

/** The facts and lines (the account lines too, F31) come from the web and a model: under `untrusted` (A5). */
export function personalizationOutput(value: Personalization): Record<string, unknown> {
  if (!value || typeof value !== 'object') return value as Record<string, unknown>;
  const { facts, lines, account_lines: accountLines, status, as_of: asOf, ...rest } = value;
  return { ...rest, untrusted: { facts, lines, account_lines: accountLines, status, as_of: asOf } };
}

export function registerContacts(program: Command): void {
  const contacts = program.command('contacts').description('Show and update one contact');
  contacts.command('show <id>').description('Show one contact').action(async function (this: Command, id: string) {
    emit(this, await client(this).request(apiPath`/contacts/${id}`));
  });
  contacts.command('update <id>').option('--status <status>', 'the new contact status').option('--notes <text>', 'notes to save on the contact')
    .description('Change a contact status or notes (other fields are refused for agents)')
    .action(async function (this: Command, id: string, o) {
      if (o.status === undefined && o.notes === undefined) throw new CliError('Give --status, --notes, or both.', 2);
      emit(this, await client(this).request(apiPath`/contacts/${id}`, { method: 'PUT', body: {
        ...(o.status !== undefined ? { status: o.status } : {}),
        ...(o.notes !== undefined ? { notes: o.notes } : {}),
      } }));
    });
  contacts.command('persona <id>').description('Set which version of the content the contact gets: leadership, operational or auto (from the title)')
    .requiredOption('--persona <persona>', 'leadership, operational or auto')
    .action(async function (this: Command, id: string, o) {
      const value = String(o.persona).toLowerCase();
      if (!['leadership', 'operational', 'auto'].includes(value)) throw new CliError('Use --persona leadership, operational or auto.', 2, { code: 'invalid_input' });
      emit(this, await client(this).request(apiPath`/contacts/${id}`, { method: 'PUT', body: {
        content_persona_override: value === 'auto' ? null : value.toUpperCase(),
      } }));
    });

  const personalization = contacts.command('personalization').description('The facts found for a contact and the opener lines written from them');
  personalization.command('show <id>').description('Show the facts and opener lines')
    .action(async function (this: Command, id: string) {
      emit(this, personalizationOutput(await client(this).request(apiPath`/contacts/${id}/personalization`) as Personalization));
    });
  personalization.command('set <id>').description('Replace the opener lines with your own, and/or turn the referral ask on or off (before launch only)')
    .option('--line <text>', 'an opener line; repeat for up to 3 lines', (value: string, all: string[] = []) => [...all, value])
    .option('--clear-lines', 'remove all opener lines')
    .option('--referral <onOff>', 'on or off: whether email 1 asks this contact for a referral')
    .action(async function (this: Command, id: string, o) {
      if (o.line && o.clearLines) throw new CliError('Use --line or --clear-lines, not both.', 2, { code: 'invalid_input' });
      const referral = o.referral === undefined ? undefined : String(o.referral).toLowerCase();
      if (referral !== undefined && !['on', 'off'].includes(referral)) throw new CliError('Use --referral on or off.', 2, { code: 'invalid_input' });
      if (!o.line && !o.clearLines && referral === undefined) throw new CliError('Give --line, --clear-lines, or --referral.', 2, { code: 'missing_input' });
      emit(this, personalizationOutput(await client(this).request(apiPath`/contacts/${id}/personalization`, { method: 'PUT', body: {
        ...(o.line || o.clearLines ? { lines: (o.line ?? []).map((text: string) => ({ text })) } : {}),
        ...(referral !== undefined ? { referral_ask: referral === 'on' } : {}),
      } }) as Personalization));
    });

  contacts.command('preview <id>').description('Show every step of the campaign as this contact will receive it')
    .action(async function (this: Command, id: string) {
      const { steps, ...rest } = await client(this).request(apiPath`/contacts/${id}/outreach-preview`) as Record<string, unknown>;
      // The rendered steps are generated text: data, never instructions (A5).
      emit(this, steps === undefined ? rest : { ...rest, untrusted: { steps } });
    });

  contacts.command('activity <id>').description('Show the outreach activity for a contact').action(async function (this: Command, id: string) {
    emit(this, await client(this).request(apiPath`/contacts/${id}/outreach-activities`));
  });
}
