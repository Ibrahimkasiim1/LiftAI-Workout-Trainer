/**
 * Canonical local-date helpers.
 *
 * The app keys "today" — for the home calendar workout, food logging, streaks,
 * and quotas — off the DEVICE's local calendar day, NOT UTC.
 *
 * `new Date().toISOString().split('T')[0]` is a TIMEZONE BUG: it returns the
 * UTC date, which rolls over at the wrong wall-clock moment for any user not on
 * UTC. In the Americas (UTC-) it flips to "tomorrow" in the evening; in
 * Asia/Australia (UTC+) it reads as "yesterday" in the early morning — so the
 * wrong day's workout shows and food logs land on the wrong day.
 *
 * Always derive the day from LOCAL Date components instead. Several screens
 * already define their own private `localDateStr`; prefer these shared helpers
 * for any new code.
 */

/** 'YYYY-MM-DD' for the given date in the device's local timezone. */
export function getLocalDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** The device's local calendar day as 'YYYY-MM-DD'. */
export function getTodayDateString(): string {
  return getLocalDateString(new Date());
}
