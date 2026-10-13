// Russian formatting for times, durations, dates and counts. Pure.

const pad2 = (value: number): string => String(value).padStart(2, "0");

function wholeSeconds(totalSec: number): number {
  return Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
}

/** Player/elapsed clock: 65 → "1:05", 3725 → "1:02:05". */
export function formatClock(totalSec: number): string {
  const s = wholeSeconds(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** Transcript timestamp, always hh:mm:ss: 65 → "00:01:05". */
export function formatTimestamp(totalSec: number): string {
  const s = wholeSeconds(totalSec);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** Human duration: 40 → "40 с", 754 → "13 мин", 3900 → "1 ч 05 мин". */
export function formatDuration(totalSec: number): string {
  const s = Math.round(Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0);
  if (s < 60) return `${s} с`;
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${pad2(m)} мин`;
}

/** "45 %" with a no-break space; the value is 0..1. */
export function formatPercent(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return `${Math.round(clamped * 100)} %`;
}

/** Russian plural: pluralRu(5, "участник", "участника", "участников") → "участников". */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayMonthFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const dayMonthYearFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "сегодня", "вчера", "завтра", "13 окт.", "13 окт. 2025 г." */
export function formatDay(ms: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "сегодня";
  if (days === -1) return "вчера";
  if (days === 1) return "завтра";
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? dayMonthFormat : dayMonthYearFormat).format(ms);
}

export function formatTime(ms: number): string {
  return timeFormat.format(ms);
}

/** "сегодня, 14:05", "13 окт., 09:30". */
export function formatDateTime(ms: number, now: number = Date.now()): string {
  return `${formatDay(ms, now)}, ${formatTime(ms)}`;
}

/** Value for <input type="datetime-local"> in local time: "2026-10-13T14:05". */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Parse a datetime-local value (local time) to epoch ms; null when empty or invalid. */
export function parseDatetimeLocal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}
