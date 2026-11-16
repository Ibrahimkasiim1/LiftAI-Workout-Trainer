/**
 * quotaReset — client-side helpers for the daily AI quota reset.
 *
 * The backend resets each user's daily AI budget at midnight in the user's own
 * timezone (see migration 20260602000000_local_midnight_quota_reset.sql). Because
 * that boundary is the device's local midnight, the client can compute the next
 * reset directly from a local `Date` — no server round-trip — and it always
 * agrees with what the backend will do.
 */

/** The IANA timezone of this device, or 'UTC' if it can't be resolved. */
export function getDeviceTimezone(): string {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return tz && tz.length > 0 ? tz : 'UTC';
    } catch {
        return 'UTC';
    }
}

// Throttle: the timezone almost never changes within a session, so re-pushing
// it more than a few times a day is wasteful. Resets on cold launch (module
// scope), so every fresh app start re-syncs once.
let lastTimezoneSync = 0;
const TIMEZONE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Push this device's IANA timezone to the backend (`user_quotas.timezone` via
 * the `set_user_timezone` RPC). This column is the SINGLE source of truth the
 * backend uses to compute the user's local "today" — daily quota resets, the
 * workout planner, and chat food logging all read it. Without this sync every
 * user falls back to UTC, so "today" rolls over at the wrong wall-clock moment
 * (the bug behind wrong calendar workouts / mis-dated food logs).
 *
 * Safe to call repeatedly and when signed out (the RPC is a no-op without an
 * authed user). Never throws — failures are logged and ignored.
 */
export async function syncDeviceTimezone(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastTimezoneSync < TIMEZONE_SYNC_INTERVAL_MS) return;
    try {
        const { supabase } = await import('./supabase');
        const { error } = await supabase.rpc('set_user_timezone', {
            p_timezone: getDeviceTimezone(),
        });
        if (error) {
            console.warn('[timezone] sync failed:', error.message);
            return;
        }
        lastTimezoneSync = now;
    } catch (err) {
        console.warn('[timezone] sync error:', err);
    }
}

/** The next local midnight — the instant the daily quota rolls over. */
export function getNextQuotaReset(now: Date = new Date()): Date {
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // tomorrow at 00:00 local
    return next;
}

/** e.g. "12:00 AM" — the clock time the quota resets (always local midnight). */
export function formatResetClock(resetAt: Date = getNextQuotaReset()): string {
    return resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** e.g. "4h 12m" or "8m" — time remaining until the quota resets. */
export function formatResetCountdown(resetAt: Date = getNextQuotaReset(), now: Date = new Date()): string {
    const ms = Math.max(0, resetAt.getTime() - now.getTime());
    const totalMinutes = Math.ceil(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
}

/**
 * Whether a stored `last_reset_date` (a 'YYYY-MM-DD' local date string) is from
 * before today — i.e. the quota has logically reset but the backend hasn't
 * lazily applied it yet because no AI request has come in since midnight. Lets
 * the UI show 0% immediately after midnight instead of yesterday's usage.
 */
export function isQuotaStale(lastResetDate: string | null | undefined, now: Date = new Date()): boolean {
    if (!lastResetDate) return false;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return lastResetDate < today;
}
