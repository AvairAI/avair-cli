import { basename } from 'node:path';
import { Command } from 'commander';

import { CliError } from '../lib/errors.js';
import { fileForm } from '../lib/files.js';
import { addWaitOptions, finishedAfterStart, isRunningStatus, waitSettings, waitUntil } from '../lib/wait.js';
import { client, download, emit, emitWaited, readJsonFile, requireValue } from './shared.js';
import { apiPath } from '../lib/path.js';

type Company = {
  fill_status?: string;
  messaging_build_status?: string;
  defaults_json?: unknown;
  defaults?: unknown;
  messaging_json?: unknown;
  messaging?: unknown;
};

const base = (id: string) => apiPath`/company-knowledge/companies/${id}`;

/** A JSON file holding the object itself, or the object under `key`. */
async function wrapped(path: string, key: string): Promise<Record<string, unknown>> {
  const value = await readJsonFile(path) as Record<string, unknown>;
  if (!value || typeof value !== 'object') throw new CliError(`${path} must hold a JSON object.`, 2);
  return key in value ? value : { [key]: value };
}

export function registerCompanies(program: Command): void {
  const companies = program.command('companies').description('Company Knowledge: profile, defaults, use cases, documents, messaging');
  companies.command('list').description('List your companies').option('--include-archived', 'also list archived companies').action(async function (this: Command, o) {
    emit(this, await client(this).request('/company-knowledge/companies', { query: { include_archived: Boolean(o.includeArchived) } }));
  });
  companies.command('show <id>').description('Show one company').action(async function (this: Command, id: string) { emit(this, await client(this).request(base(id))); });

  addWaitOptions(companies.command('fill <id>').description("Read the company's website into its profile")
    .requiredOption('--website <url>', 'the company website to read').option('--overwrite-edited', 'also replace fields a person edited'))
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const started = await api.request(apiPath`/company-knowledge/companies/${id}/fill`, { method: 'POST', body: { website_url: o.website, overwrite_edited: Boolean(o.overwriteEdited) } });
      if (!o.wait) { emit(this, started); return; }
      emitWaited(this, await waitUntil(() => api.request(base(id)) as Promise<Company>,
        finishedAfterStart<Company>(company => isRunningStatus(company.fill_status)), waitSettings(o), { id, check: `avair companies show ${id}` }),
      `avair companies show ${id}`, company => company.fill_status);
    });

  companies.command('profile').description('The company profile').command('edit <id>').description('Replace the company profile from a JSON file').requiredOption('--input <file>', 'JSON profile (or {"profile": …, "website_url": …})')
    .action(async function (this: Command, id: string, o) {
      emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/profile`, { method: 'PUT', body: await wrapped(o.input, 'profile') }));
    });

  const defaults = companies.command('defaults').description('Default campaign settings for this company');
  defaults.command('show <id>').description('Show the default campaign settings').action(async function (this: Command, id: string) {
    const company = await client(this).request(base(id)) as Company;
    emit(this, company.defaults ?? company.defaults_json ?? null);
  });
  defaults.command('edit <id>').description('Replace the default campaign settings from a JSON file (not the standard sequence: use defaults sequence set)').requiredOption('--input <file>', 'JSON defaults (or {"defaults": …})')
    .action(async function (this: Command, id: string, o) {
      const body = await wrapped(o.input, 'defaults');
      const settings = body.defaults as Record<string, unknown> | undefined;
      if (settings && typeof settings === 'object' && 'touch_sequence' in settings) {
        // This route keeps the stored sequence and ignores the key (CLI plan C2, N4).
        const { touch_sequence: _ignored, ...rest } = settings;
        body.defaults = rest;
        process.stderr.write('Warning: touch_sequence was left out. Change the standard sequence with `avair companies defaults sequence set`.\n');
      }
      emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/defaults`, { method: 'PUT', body }));
    });
  const sequence = defaults.command('sequence').description("The company's standard outreach sequence: every new campaign for this company starts from it");
  sequence.command('set <id>').description('Set the standard sequence from a JSON file of steps, or go back to the app standard')
    .option('--input <file>', 'JSON array of steps (or {"steps": […]})').option('--app-default', "use the app's standard sequence again")
    .action(async function (this: Command, id: string, o) {
      if (Boolean(o.input) === Boolean(o.appDefault)) throw new CliError('Give --input or --app-default.', 2, { code: 'missing_input' });
      let steps: unknown = null;
      if (o.input) {
        const value = await readJsonFile(o.input) as unknown;
        steps = Array.isArray(value) ? value : (value as { steps?: unknown })?.steps;
        if (!Array.isArray(steps)) throw new CliError(`${o.input} must hold a JSON array of steps, or {"steps": […]}.`, 2, { code: 'invalid_input' });
      }
      emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/defaults/touch-sequence`, { method: 'PUT', body: { steps } }));
    });

  const useCases = companies.command('use-cases').description('The use case library of the company');
  useCases.command('list <id>').description('List the use cases').option('--include-archived', 'also list archived use cases').action(async function (this: Command, id: string, o) {
    emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/use-cases`, { query: { include_archived: Boolean(o.includeArchived) } }));
  });
  useCases.command('add <id>').description('Add a use case from text or from a file')
    .requiredOption('--title <title>', 'the use case title').option('--text <text>', 'the use case story as text (or use --file)').option('--file <path>', 'a document to read the story from (or use --text)')
    .action(async function (this: Command, id: string, o) {
      if (Boolean(o.text) === Boolean(o.file)) throw new CliError('Give the story with --text or --file (one of them).', 2);
      const api = client(this);
      emit(this, o.file
        ? await api.request(apiPath`/company-knowledge/companies/${id}/use-cases/upload`, { method: 'POST', form: await fileForm(o.file, { title: o.title }) })
        : await api.request(apiPath`/company-knowledge/companies/${id}/use-cases`, { method: 'POST', body: { title: o.title, raw_text: o.text } }));
    });
  useCases.command('edit <id> <useCaseId>').description('Change the title or text of a use case')
    .option('--title <title>', 'the new title').option('--text <text>', 'the new story text')
    .action(async function (this: Command, id: string, useCaseId: string, o) {
      if (o.title === undefined && o.text === undefined) throw new CliError('Give --title, --text, or both.', 2);
      emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/use-cases/${useCaseId}`, { method: 'PATCH', body: {
        ...(o.title !== undefined ? { title: o.title } : {}), ...(o.text !== undefined ? { raw_text: o.text } : {}),
      } }));
    });
  useCases.command('archive <id> <useCaseId>').description('Archive a use case').action(async function (this: Command, id: string, useCaseId: string) {
    emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/use-cases/${useCaseId}`, { method: 'PATCH', body: { status: 'ARCHIVED' } }));
  });

  const documents = companies.command('documents').description('Documents of the company');
  documents.command('list <id>').description('List the documents').action(async function (this: Command, id: string) { emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/documents`)); });
  documents.command('show <id> <documentId>').description('Show one document').action(async function (this: Command, id: string, documentId: string) {
    const list = await client(this).request(apiPath`/company-knowledge/companies/${id}/documents`) as unknown;
    const rows = Array.isArray(list) ? list : ((list as { items?: unknown[] })?.items ?? []);
    const found = (rows as Array<{ id?: string }>).find(row => row.id === documentId);
    if (!found) throw new CliError(`Document ${documentId} not found for this company.`, 5, { code: 'not_found' });
    emit(this, found);
  });
  addWaitOptions(documents.command('upload <id>').description('Upload a document for the company')
    .requiredOption('--file <path>', 'the file to upload').option('--title <title>', 'the document title (default: the file name)').option('--kind <kind>', 'document kind, e.g. PRICING or MESSAGING'))
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const form = await fileForm(o.file, { title: o.title || basename(o.file), doc_kind: o.kind });
      const uploaded = await api.request(apiPath`/company-knowledge/companies/${id}/documents`, { method: 'POST', form }) as { id?: string; brief_status?: string };
      if (!o.wait || !uploaded?.id) { emit(this, uploaded); return; }
      const documentId = uploaded.id;
      emitWaited(this, await waitUntil(async () => {
        const list = await api.request(apiPath`/company-knowledge/companies/${id}/documents`) as unknown;
        const rows = (Array.isArray(list) ? list : ((list as { items?: unknown[] })?.items ?? [])) as Array<{ id?: string; brief_status?: string }>;
        return rows.find(row => row.id === documentId) ?? {};
      }, doc => !isRunningStatus(doc.brief_status), waitSettings(o), { id: documentId, check: `avair companies documents show ${id} ${documentId}` }),
      `avair companies documents show ${id} ${documentId}`, doc => doc.brief_status);
    });
  documents.command('retry <id> <documentId>').description('Read a document again after it failed').action(async function (this: Command, id: string, documentId: string) {
    emit(this, await client(this).request(apiPath`/company-knowledge/companies/${id}/documents/${documentId}/retry`, { method: 'POST' }));
  });

  const messaging = companies.command('messaging').description('The messaging framework');
  messaging.command('show <id>').description('Show the messaging framework').action(async function (this: Command, id: string) {
    const company = await client(this).request(base(id)) as Company;
    emit(this, company.messaging ?? company.messaging_json ?? null);
  });
  addWaitOptions(messaging.command('build <id>').description('Build the messaging framework from the website and documents').option('--overwrite-edited', 'also replace sections a person edited'))
    .action(async function (this: Command, id: string, o) {
      const api = client(this);
      const started = await api.request(apiPath`/company-knowledge/companies/${id}/messaging/build`, { method: 'POST', body: { overwrite_edited: Boolean(o.overwriteEdited) } });
      if (!o.wait) { emit(this, started); return; }
      emitWaited(this, await waitUntil(() => api.request(base(id)) as Promise<Company>,
        finishedAfterStart<Company>(company => isRunningStatus(company.messaging_build_status)), waitSettings(o), { id, check: `avair companies show ${id}` }),
      `avair companies show ${id}`, company => company.messaging_build_status);
    });
  messaging.command('export <id>').description('Download the messaging framework as a .docx file').option('-o, --output <file>', 'where to write the .docx')
    .action(async function (this: Command, id: string, o) {
      await download(this, apiPath`/company-knowledge/companies/${id}/messaging/export.docx`, requireValue(o.output, 'Name the .docx to write with --output.'));
    });
}
