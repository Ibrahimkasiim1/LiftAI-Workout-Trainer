/**
 * User timezone helpers.
 *
 * The user's IANA timezone is the single source of truth for computing their
 * local "today" — daily quota resets, the workout planner, and chat food
 * logging all depend on it. It lives on `user_quotas.timezone` (written by the
 * client's `set_user_timezone` RPC). NOTE: `user_profiles` has no timezone
 * column, so reading it there always yields UTC — that was the bug.
 */

import { supabase } from "./db";

/**
 * The user's IANA timezone (e.g. "America/Los_Angeles"), or "UTC" when it
 * hasn't been synced yet / can't be read. Never throws.
 */
export async function getUserTimezone(userId: string): Promise<string> {
    try {
        const { data, error } = await supabase
            .from("user_quotas")
            .select("timezone")
            .eq("user_id", userId)
            .maybeSingle();
        if (error) {
            console.warn(
                "getUserTimezone: failed to read user_quotas.timezone:",
                error.message
            );
            return "UTC";
        }
        const tz = (data as { timezone?: unknown } | null)?.timezone;
        return typeof tz === "string" && tz.trim().length > 0 ? tz : "UTC";
    } catch (err) {
        console.warn("getUserTimezone error:", err);
        return "UTC";
    }
}

/**
 * The current local calendar day ("YYYY-MM-DD") in the given IANA timezone.
 * `en-CA` formats as ISO (YYYY-MM-DD). Falls back to the UTC date if the
 * timezone is invalid.
 */
export function localTodayInTimezone(timezone: string): string {
    try {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
}
