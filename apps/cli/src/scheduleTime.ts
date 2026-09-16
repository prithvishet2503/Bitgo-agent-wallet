/**
 * Small, deliberately literal natural-language time parsing for
 * `schedule-send --at <when>` - not a general NLP date library, just the
 * handful of phrasings someone would actually type at a terminal ("tomorrow",
 * "next week", "next monday", "in 3 days") plus plain ISO/date-only input.
 * Everything resolves to a UTC ISO timestamp; a bare date combines with
 * `--time` (default "09:00" UTC).
 */

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBREVIATIONS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Accepts a weekday name ("monday", "mon") case-insensitively, or a literal
 * 0-6 (0 = Sunday), and returns 0-6. Throws with a clear message otherwise -
 * used for both `--day-of-week` (recurring weekly) and "next <weekday>" (--at). */
export function parseDayOfWeek(input: string): number {
  const normalized = input.trim().toLowerCase();
  if (/^[0-6]$/.test(normalized)) return Number(normalized);
  const byName = WEEKDAY_NAMES.indexOf(normalized);
  if (byName !== -1) return byName;
  const byAbbrev = WEEKDAY_ABBREVIATIONS.indexOf(normalized);
  if (byAbbrev !== -1) return byAbbrev;
  throw new Error(`Not a recognized day of week: "${input}" (expected a name like "monday" or a number 0-6, 0=Sunday)`);
}

function withTimeOfDay(date: Date, timeOfDayUtc: string): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDayUtc.trim());
  if (!match) {
    throw new Error(`--time must be "HH:mm" in UTC (e.g. "09:00"), got "${timeOfDayUtc}"`);
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) {
    throw new Error(`--time "${timeOfDayUtc}" is out of range`);
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hh, mm, 0, 0));
}

/**
 * Resolves `--at <when>` to an ISO timestamp. Recognized forms:
 *   - A full ISO/RFC timestamp (contains "T", e.g. "2026-10-01T14:00:00Z") - used as-is, `timeOfDayUtc` ignored.
 *   - A plain date "YYYY-MM-DD" - combined with `timeOfDayUtc`.
 *   - "today" / "tomorrow" - combined with `timeOfDayUtc`.
 *   - "next week" - today + 7 days, combined with `timeOfDayUtc`.
 *   - "next <weekday>" (e.g. "next monday", "next fri") - the next occurrence
 *     of that weekday, always at least a day away (today doesn't count, even
 *     if today is that weekday) - combined with `timeOfDayUtc`.
 *   - "in N day(s)" / "in N week(s)" - a relative offset, combined with `timeOfDayUtc`.
 */
export function parseRunAt(when: string, timeOfDayUtc = '09:00'): string {
  const input = when.trim();
  const lower = input.toLowerCase();
  const now = new Date();

  // Full timestamp with an explicit time component - trust it outright.
  if (input.includes('T')) {
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) throw new Error(`"${input}" is not a valid ISO timestamp`);
    return parsed.toISOString();
  }

  // Plain date "YYYY-MM-DD".
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return withTimeOfDay(new Date(Date.UTC(y, m - 1, d)), timeOfDayUtc).toISOString();
  }

  if (lower === 'today') {
    return withTimeOfDay(now, timeOfDayUtc).toISOString();
  }

  if (lower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return withTimeOfDay(tomorrow, timeOfDayUtc).toISOString();
  }

  if (lower === 'next week') {
    const nextWeek = new Date(now);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
    return withTimeOfDay(nextWeek, timeOfDayUtc).toISOString();
  }

  const nextWeekdayMatch = /^next\s+(\w+)$/.exec(lower);
  if (nextWeekdayMatch) {
    const targetDow = parseDayOfWeek(nextWeekdayMatch[1]);
    const candidate = new Date(now);
    // "next X" always means a future occurrence, strictly after today - if
    // today happens to be that weekday, that means seven days out, not zero.
    const diff = ((targetDow - candidate.getUTCDay() + 7) % 7) || 7;
    candidate.setUTCDate(candidate.getUTCDate() + diff);
    return withTimeOfDay(candidate, timeOfDayUtc).toISOString();
  }

  const inNMatch = /^in\s+(\d+)\s*(day|days|week|weeks)$/.exec(lower);
  if (inNMatch) {
    const amount = Number(inNMatch[1]);
    const unitDays = inNMatch[2].startsWith('week') ? 7 : 1;
    const candidate = new Date(now);
    candidate.setUTCDate(candidate.getUTCDate() + amount * unitDays);
    return withTimeOfDay(candidate, timeOfDayUtc).toISOString();
  }

  throw new Error(
    `Could not understand --at "${when}". Try an ISO timestamp, "YYYY-MM-DD", "today", "tomorrow", ` +
      `"next week", "next <weekday>" (e.g. "next monday"), or "in N days"/"in N weeks".`,
  );
}
