/**
 * Push delivery for proactive coach check-ins.
 *
 * The drafting pass (proactiveCheckins.ts) writes personalized rows into
 * `coach_checkins`; this service is the delivery leg that actually reaches
 * users whose app is closed. Every 30 minutes it scans recent unread
 * check-ins that haven't been pushed yet and hands them to Expo's push API,
 * deep-linking into chat with the check-in's CTA prefilled.
 *
 * Rules:
 *  - Waking hours only: a push is sent only between 09:00 and 21:00 in the
 *    user's own timezone (user_quotas.timezone). Outside the window the row
 *    stays queued for a later run — never dropped, never sent at 3 am.
 *  - `notifications_enabled = false` on the profile suppresses pushes.
 *  - `pushed_at` is set exactly once per check-in (sent, opted out, or no
 *    device token), so re-runs are idempotent and nobody gets double-pinged.
 *  - Tokens Expo reports as DeviceNotRegistered are deleted.
 *  - Everything is best-effort: one user failing never aborts the pass.
 */

import { supabase } from "./db";
import { getUserTimezone } from "./userTimezone";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_CHUNK_SIZE = 100;
const PUSH_WINDOW_START_HOUR = 9;
const PUSH_WINDOW_END_HOUR = 21;
const MAX_PUSH_BODY_CHARS = 178;
const CHECKIN_PUSH_MAX_AGE_HOURS = 48;

interface ExpoPushMessage {
    to: string;
    title: string;
    body: string;
    sound: "default";
    channelId: "default";
    data: Record<string, unknown>;
}

interface PendingCheckin {
    id: string;
    user_id: string;
    kind: string;
    title: string;
    message: string;
    cta: string | null;
}

/** Local hour (0-23) right now in the given IANA timezone; null if unknown. */
function localHourInTimezone(timezone: string): number | null {
    try {
        const hour = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            hour12: false,
        }).format(new Date());
        const parsed = Number(hour);
        return Number.isFinite(parsed) ? parsed % 24 : null;
    } catch {
        return null;
    }
}

function truncateBody(text: string): string {
    if (text.length <= MAX_PUSH_BODY_CHARS) return text;
    return `${text.slice(0, MAX_PUSH_BODY_CHARS - 1).trimEnd()}…`;
}

/**
 * Send messages through Expo's push API in chunks. Returns the tokens Expo
 * reported as DeviceNotRegistered so callers can prune them.
 */
async function sendExpoPushMessages(messages: ExpoPushMessage[]): Promise<string[]> {
    const deadTokens: string[] = [];
    for (let i = 0; i < messages.length; i += EXPO_CHUNK_SIZE) {
        const chunk = messages.slice(i, i + EXPO_CHUNK_SIZE);
        try {
            const res = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(chunk),
            });
            if (!res.ok) {
                console.warn(`[push] Expo push API returned ${res.status}`);
                continue;
            }
            const json = (await res.json()) as {
                data?: Array<{ status: string; details?: { error?: string } }>;
            };
            (json.data ?? []).forEach((ticket, idx) => {
                if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
                    deadTokens.push(chunk[idx].to);
                }
            });
        } catch (err) {
            console.warn("[push] Expo push request failed (non-fatal):", err);
        }
    }
    return deadTokens;
}

/**
 * One delivery pass: push recent unread, un-pushed check-ins to users who are
 * inside their local waking-hours window. Never throws.
 */
export async function deliverCheckinPushes(): Promise<void> {
    try {
        const since = new Date(Date.now() - CHECKIN_PUSH_MAX_AGE_HOURS * 60 * 60 * 1000);
        const { data: pending, error } = await supabase
            .from("coach_checkins")
            .select("id, user_id, kind, title, message, cta")
            .eq("status", "unread")
            .is("pushed_at", null)
            .neq("kind", "plan_change")
            .gte("created_at", since.toISOString())
            .limit(500);
        if (error) {
            console.warn("[push] pending check-in query failed:", error.message);
            return;
        }
        if (!pending || pending.length === 0) return;

        // One check-in per user per pass (drafting already guarantees ~1, but
        // be defensive so a backlog can't burst-ping someone).
        const byUser = new Map<string, PendingCheckin>();
        for (const row of pending as PendingCheckin[]) {
            if (!byUser.has(row.user_id)) byUser.set(row.user_id, row);
        }
        const userIds = Array.from(byUser.keys());

        const [{ data: tokenRows }, { data: profileRows }] = await Promise.all([
            supabase
                .from("user_push_tokens")
                .select("token, user_id")
                .in("user_id", userIds),
            supabase
                .from("user_profiles")
                .select("id, notifications_enabled")
                .in("id", userIds),
        ]);

        const tokensByUser = new Map<string, string[]>();
        for (const row of tokenRows ?? []) {
            const arr = tokensByUser.get(String(row.user_id)) ?? [];
            arr.push(String(row.token));
            tokensByUser.set(String(row.user_id), arr);
        }
        const optedOut = new Set(
            (profileRows ?? [])
                .filter((p) => p.notifications_enabled === false)
                .map((p) => String(p.id))
        );

        const messages: ExpoPushMessage[] = [];
        const processedIds: string[] = [];
        let sentUsers = 0;
        let deferred = 0;

        for (const [userId, checkin] of byUser) {
            try {
                // Quiet hours: leave the row queued for a later pass.
                const tz = await getUserTimezone(userId);
                const hour = localHourInTimezone(tz);
                if (hour == null || hour < PUSH_WINDOW_START_HOUR || hour >= PUSH_WINDOW_END_HOUR) {
                    deferred++;
                    continue;
                }

                // Opted out or no registered device: mark processed so the
                // scan shrinks; the in-app card still covers them.
                const tokens = tokensByUser.get(userId) ?? [];
                if (optedOut.has(userId) || tokens.length === 0) {
                    processedIds.push(checkin.id);
                    continue;
                }

                for (const token of tokens) {
                    messages.push({
                        to: token,
                        title: checkin.title,
                        body: truncateBody(checkin.message),
                        sound: "default",
                        channelId: "default",
                        data: {
                            type: "coach_checkin",
                            route: "/(tabs)/chat",
                            checkinId: checkin.id,
                            kind: checkin.kind,
                            ...(checkin.cta ? { cta: checkin.cta } : {}),
                        },
                    });
                }
                processedIds.push(checkin.id);
                sentUsers++;
            } catch (err) {
                console.warn(`[push] user ${userId} failed (non-fatal):`, err);
            }
        }

        if (processedIds.length > 0) {
            const { error: updErr } = await supabase
                .from("coach_checkins")
                .update({ pushed_at: new Date().toISOString() })
                .in("id", processedIds);
            if (updErr) console.warn("[push] pushed_at update failed:", updErr.message);
        }

        const deadTokens = messages.length > 0 ? await sendExpoPushMessages(messages) : [];
        if (deadTokens.length > 0) {
            await supabase.from("user_push_tokens").delete().in("token", deadTokens);
        }

        console.log(
            `[push] pass complete: ${sentUsers} user(s) pushed, ${deferred} deferred (quiet hours), ${deadTokens.length} dead token(s) pruned`
        );
    } catch (err) {
        console.error("[push] delivery pass failed:", err);
    }
}

/**
 * Schedule the delivery pass: shortly after boot, then every 30 minutes. The
 * 30-minute cadence keeps the waking-hours window accurate without hammering
 * the DB — each pass is a single cheap indexed scan when nothing is pending.
 */
export function initializePushDelivery(): void {
    setTimeout(() => {
        void deliverCheckinPushes();
    }, 45_000);
    setInterval(() => {
        void deliverCheckinPushes();
    }, 30 * 60 * 1000);
    console.log("Check-in push delivery initialized (runs every 30m)");
}
