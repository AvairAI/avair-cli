export type AvairErrorBody = {
  code?: string;
  message?: string;
  hint?: string;
  request_id?: string;
  app_url?: string;
  /** Launch-checklist steps that block a launch (409 launch_blocked). */
  blocking_steps?: string[];
  /** Seconds from a 429's Retry-After header: when the limit lets a request through again. */
  retry_after?: number;
  /** The fixes an Assess apply-all 409 was asked about, to send back when confirmed (F30). Never printed. */
  suggestions?: Array<Record<string, unknown>>;
  /** Who may own a playbook hand build (409 owner_choice_required); one `user_id` goes back as --owner. */
  choices?: OwnerChoice[];
};

export type OwnerChoice = { user_id: string; name: string; email?: string; persona_name?: string; assigned: boolean };

const statusExit: Record<number, number> = {
  400: 6, 401: 3, 403: 4, 404: 5, 409: 6, 426: 9, 428: 4, 429: 8,
};

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
    public readonly details: AvairErrorBody = {},
    public readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * A sentence for a refusal the server sent without a message (D5). The Tools
 * refusals carry only a code and numbers; say what they mean.
 */
export function fallbackMessage(code: string, detail: Record<string, unknown>, status: number): string {
  const n = (key: string) => (detail[key] === undefined || detail[key] === null ? '?' : String(detail[key]));
  switch (code) {
    case 'tool_daily_cap_exceeded':
      return `Daily Tools credit cap reached for this token: cap ${n('daily_cap')}, spent today ${n('spent_today')}, this run needs up to ${n('required')}. It resets at the start of the next UTC day.`;
    case 'insufficient_tool_credits':
      return `Not enough Tools credits: this run needs up to ${n('required')}, ${n('remaining')} left this period. An Admin can buy more in Account > Subscription & Billing > Add capacity.`;
    case 'tool_rate_limited': {
      const run = detail.blocking_run as { id?: string } | undefined;
      return `Another Tools run is still in progress${run?.id ? ` (${run.id})` : ''}. Wait for it to finish, or cancel it.`;
    }
    case 'tool_result_not_ready':
      return 'This run has not finished yet, so its results are not ready.';
    default:
      // No code at all (`http_500`): the plain status says as much as we know.
      return code.startsWith('http_') ? `Avair returned HTTP ${status}` : `${code.replaceAll('_', ' ')} (HTTP ${status})`;
  }
}

/** Retry-After in seconds; undefined when absent or not a whole number of seconds. */
export function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * A 422 says which field failed in `validation_errors` ({loc, msg}); the
 * generic message alone left the caller guessing (AVI-1140).
 */
function invalidFields(errors: unknown): string {
  if (!Array.isArray(errors)) return '';
  const fields = errors.slice(0, 5).map((error) => {
    const { loc, msg } = (error ?? {}) as { loc?: unknown; msg?: unknown };
    const where = Array.isArray(loc) ? loc.filter((part) => part !== 'body').join('.') : '';
    return where ? `${where}: ${String(msg ?? 'invalid')}` : String(msg ?? '');
  }).filter(Boolean);
  return fields.length ? ` ${fields.join('; ')}` : '';
}

/** The owner choices of a hand build refusal; entries without a user id are dropped (AVI-1197). */
function ownerChoices(value: unknown): OwnerChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = value.flatMap((item) => {
    const choice = (item ?? {}) as Record<string, unknown>;
    if (!choice.user_id) return [];
    return [{
      user_id: String(choice.user_id),
      name: String(choice.name ?? ''),
      ...(choice.email ? { email: String(choice.email) } : {}),
      ...(choice.persona_name ? { persona_name: String(choice.persona_name) } : {}),
      assigned: choice.assigned === true,
    }];
  });
  return choices.length ? choices : undefined;
}

/** One line per owner choice, for the plain text error. */
export function ownerChoiceLines(choices: OwnerChoice[]): string {
  return choices.map((choice) => {
    const person = choice.email ? `${choice.name} · ${choice.email}` : choice.name;
    const label = choice.assigned
      ? `${choice.persona_name ? `${choice.persona_name}: ` : ''}${person} (assigned in the plan)`
      : `you (${person})`;
    return `\n  --owner ${choice.user_id}  ${label}`;
  }).join('');
}

export function apiError(status: number, body: unknown, headers?: Headers): CliError {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const detail = raw.detail && typeof raw.detail === 'object'
    ? raw.detail as Record<string, unknown>
    : raw;
  const code = String(detail.error || detail.code || `http_${status}`);
  const message = String(detail.message || detail.detail || fallbackMessage(code, detail, status))
    + invalidFields(raw.validation_errors);
  let exitCode = status >= 500 ? 1 : (statusExit[status] ?? 1);
  if (status === 403 && headers?.get('X-Avair-Error-Code') === 'plan_limit') exitCode = 7;
  if (status === 429) exitCode = 8;
  if ([409, 503].includes(status) && ['launch_in_progress', 'launch_reconciliation_required'].includes(code)) exitCode = 10;
  if (status === 409 && code === 'launch_state_changed') exitCode = 6;
  const choices = ownerChoices(detail.choices);
  const choiceHint = code === 'owner_choice_required' && choices
    ? 'Run the build again with --owner <user_id>, using one of the choices.'
    : undefined;
  return new CliError(message, exitCode, {
    code,
    message,
    hint: typeof detail.hint === 'string' ? detail.hint : choiceHint,
    request_id: headers?.get('X-Request-ID') || undefined,
    app_url: typeof detail.app_url === 'string' ? detail.app_url : undefined,
    blocking_steps: Array.isArray(detail.blocking_steps) ? detail.blocking_steps.map(String) : undefined,
    retry_after: retryAfterSeconds(headers?.get('Retry-After')),
    suggestions: Array.isArray(detail.suggestions) ? detail.suggestions as Array<Record<string, unknown>> : undefined,
    choices,
  }, status);
}
