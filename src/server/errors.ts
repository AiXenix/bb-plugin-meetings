// Errors the service raises on purpose. `message` is Russian (the Meetings
// page shows it); `en` and `hint` are for the CLI and agent tools.
export class MeetingsError extends Error {
  override readonly name = "MeetingsError";

  constructor(
    readonly code: string,
    message: string,
    readonly en: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** English text of any error (MeetingsError carries its own translation). */
export function errorMessageEn(error: unknown): string {
  return error instanceof MeetingsError ? error.en : errorMessage(error);
}

export function notFound(id: string): MeetingsError {
  return new MeetingsError(
    "not_found",
    `Встреча ${id} не найдена`,
    `Meeting ${id} not found`,
    "List meetings with: bb meetings list",
  );
}

/** Sleep that resolves early on abort or when `wake` is called. */
export function sleep(ms: number, signal?: AbortSignal, onWakeHandle?: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    onWakeHandle?.(done);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * When to start: "HH:MM" (today, or tomorrow if that time has passed) or any
 * ISO 8601 date-time. Returns epoch ms; throws MeetingsError on bad input.
 */
export function parseStartTime(value: string, now: number): number {
  const trimmed = value.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock !== null) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) throw badTime(trimmed);
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() < now - 60_000) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) throw badTime(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw badTime(trimmed);
  return parsed;
}

function badTime(value: string): MeetingsError {
  return new MeetingsError(
    "invalid_time",
    `Не удалось понять время «${value}». Укажите ЧЧ:ММ или дату ISO 8601`,
    `Cannot parse the start time "${value}". Use HH:MM or an ISO 8601 date-time`,
    "Examples: --at 14:30, --at 2026-10-14T10:00+03:00",
  );
}
