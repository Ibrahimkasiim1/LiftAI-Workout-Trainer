/**
 * Proactive coach check-ins.
 *
 * A daily pass over recently-active users that DRAFTS coach-initiated notes
 * from their real training data ("you've hit 12 reps on Bench Press two
 * sessions straight — ready to add 2.5 kg?") into `coach_checkins`. The app
 * surfaces unread rows as a coach card; tapping one deep-links into chat with
 * the prefilled CTA so the agent can apply the change.
 *
 * Design constraints:
 *  - Deterministic templates grounded in the user's own numbers — no LLM call,
 *    so the pass is free, instant, and can never hallucinate a weight.
 *  - At most ONE new check-in per user per run, min 3 days between check-ins,
 *    and dedupe keys are scoped to the ISO week so re-runs are idempotent.
 *  - Everything is best-effort: a failure for one user never aborts the pass.
 *
 * The same table doubles as the "why did the AI change my plan" feed:
 * `recordPlanChangeNote` is called (fire-and-forget) by every plan-mutating
 * chat tool so users always get a note explaining what changed and why.
 */

import { supabase } from "./db";
import { getUserTimezone, localTodayInTimezone } from "./userTimezone";

const LBS_PER_KG = 2.20462;

/** Whole days between two YYYY-MM-DD strings (b - a). */
function daysBetweenDateStrs(a: string, b: string): number {
    const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
    return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

interface PerfRow {
    exercise_id: string | null;
    exercise_name: string;
    set_number: number;
    reps_completed: number;
    weight_used: number;
    workout_date: string;
}

interface SessionTopSet {
    date: string; // YYYY-MM-DD
    weight: number; // kg
    reps: number;
}

function isoWeekKey(d = new Date()): string {
    // ISO-8601 week number (Thursday trick).
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    const week =
        1 +
        Math.round(
            ((date.getTime() - firstThursday.getTime()) / 86400000 -
                3 +
                ((firstThursday.getUTCDay() + 6) % 7)) /
                7
        );
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function slugify(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

function displayWeight(kg: number, unit: "kg" | "lbs"): string {
    if (unit === "lbs") {
        const lbs = Math.round(kg * LBS_PER_KG);
        return `${lbs} lbs`;
    }
    const rounded = Math.round(kg * 2) / 2;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} kg`;
}

function incrementFor(unit: "kg" | "lbs"): string {
    return unit === "lbs" ? "5 lbs" : "2.5 kg";
}

function titleCase(name: string): string {
    return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Group per-set rows into per-day top sets (heaviest set of each session). */
function topSetsBySession(rows: PerfRow[]): SessionTopSet[] {
    const byDay = new Map<string, SessionTopSet>();
    for (const r of rows) {
        const day = String(r.workout_date).slice(0, 10);
        const weight = Number(r.weight_used) || 0;
        const reps = Number(r.reps_completed) || 0;
        const cur = byDay.get(day);
        if (!cur || weight > cur.weight || (weight === cur.weight && reps > cur.reps)) {
            byDay.set(day, { date: day, weight, reps });
        }
    }
    return Array.from(byDay.values()).sort((a, b) => b.date.localeCompare(a.date));
}

interface DraftCheckin {
    kind:
        | "ready_to_progress"
        | "streak"
        | "comeback"
        | "stalled_lift"
        | "first_workout_followup"
        | "day2_after_first"
        | "activation_nudge";
    title: string;
    message: string;
    cta: string | null;
    payload: Record<string, unknown> | null;
    dedupeKey: string;
}

/**
 * Pick the single best check-in for one user from their recent history.
 * Priority: first-week activation script > progress opportunity > stalled
 * lift > comeback nudge > streak. The activation window (user's first-ever
 * session was within the last week) outranks everything — those are the
 * users deciding right now whether the app becomes a habit.
 */
export function draftCheckinForUser(args: {
    firstName: string | null;
    unit: "kg" | "lbs";
    /** Last-30-day per-set rows, newest first. */
    rows: PerfRow[];
    /** Days since the most recent logged set (Infinity when none). */
    daysSinceLastWorkout: number;
    /** Distinct workout days in the last 7 days. */
    workoutsThisWeek: number;
}): DraftCheckin | null {
    const { firstName, unit, rows, daysSinceLastWorkout, workoutsThisWeek } = args;
    const week = isoWeekKey();
    const hey = firstName ? `${firstName}, ` : "";

    // ------------------------------------------------------------------
    // First-week activation script: the user's ONLY logged session so far.
    // These outrank every data-driven check-in — a second workout in week
    // one predicts retention more than any plateau note ever will.
    // ------------------------------------------------------------------
    const distinctDays = new Set(rows.map((r) => String(r.workout_date).slice(0, 10)));
    if (distinctDays.size === 1) {
        // Same-day / next-morning follow-up to the first session ever.
        if (daysSinceLastWorkout <= 1) {
            return {
                kind: "first_workout_followup",
                title: "First one's done",
                message: `${hey}the first session is the hardest one, and it's behind you now. How did it feel? Too easy, too hard, about right? Tell me and I'll tune the next one so it fits.`,
                cta: "Here's how my first workout felt",
                payload: { sets_logged: rows.length },
                // Once ever — no week suffix.
                dedupeKey: "first_workout_followup",
            };
        }
        // 2-4 days after the first (and only) session: normalize soreness,
        // point at today, before the generic comeback flow takes over.
        if (daysSinceLastWorkout <= 4) {
            const days = Math.max(1, Math.floor(daysSinceLastWorkout));
            return {
                kind: "day2_after_first",
                title: "Soreness is normal",
                message: `${hey}feeling it from your first session? That's just your muscles adapting. It fades fast, and moving a little actually helps. Your next workout is ready when you are. Want me to keep it easy?`,
                cta: "I'm a bit sore, what should I do today?",
                payload: { days_since_first: days },
                dedupeKey: "day2_after_first",
            };
        }
    }

    // Group rows per exercise.
    const byExercise = new Map<string, PerfRow[]>();
    for (const r of rows) {
        const key = r.exercise_name.toLowerCase().trim();
        if (!key) continue;
        const arr = byExercise.get(key) ?? [];
        arr.push(r);
        byExercise.set(key, arr);
    }

    // 1) Ready to progress: top of rep range (12+) two sessions straight at the
    //    same weight → suggest the smallest plate bump.
    for (const [, exRows] of byExercise) {
        const sessions = topSetsBySession(exRows);
        if (sessions.length < 2) continue;
        const [last, prev] = sessions;
        if (
            last.weight > 0 &&
            last.weight === prev.weight &&
            last.reps >= 12 &&
            prev.reps >= 12
        ) {
            const name = titleCase(exRows[0].exercise_name);
            return {
                kind: "ready_to_progress",
                title: `Time to load up ${name}`,
                message: `${hey}you've hit ${last.reps} reps at ${displayWeight(last.weight, unit)} on ${name} two sessions in a row. That weight is getting easy for you. Ready to add ${incrementFor(unit)}?`,
                cta: `Yes, bump my ${name} by ${incrementFor(unit)}`,
                payload: {
                    exercise: name,
                    current_weight_kg: last.weight,
                    last_reps: last.reps,
                },
                dedupeKey: `ready_to_progress:${slugify(name)}:${week}`,
            };
        }
    }

    // 2) Stalled lift: same top weight 4+ sessions with no rep progress.
    for (const [, exRows] of byExercise) {
        const sessions = topSetsBySession(exRows);
        if (sessions.length < 4) continue;
        const [s0, s1, s2, s3] = sessions;
        const sameWeight =
            s0.weight > 0 &&
            s0.weight === s1.weight &&
            s1.weight === s2.weight &&
            s2.weight === s3.weight;
        const noRepProgress = s0.reps <= s3.reps;
        if (sameWeight && noRepProgress) {
            const name = titleCase(exRows[0].exercise_name);
            return {
                kind: "stalled_lift",
                title: `${name} has plateaued`,
                message: `${hey}${name} has been stuck at ${displayWeight(s0.weight, unit)} for 4 sessions. Happens to everyone. A small deload, a rep change, or a swap usually gets it moving again. Want me to adjust your plan?`,
                cta: `My ${name} is stuck, how do we get it moving again?`,
                payload: { exercise: name, stuck_weight_kg: s0.weight, sessions: 4 },
                dedupeKey: `stalled_lift:${slugify(name)}:${week}`,
            };
        }
    }

    // 3) Comeback nudge: 5-13 days silent (past ~2 weeks a different flow
    //    should own re-onboarding, so cap it).
    if (daysSinceLastWorkout >= 5 && daysSinceLastWorkout <= 13) {
        const days = Math.floor(daysSinceLastWorkout);
        return {
            kind: "comeback",
            title: "Let's get back to it",
            message: `${hey}it's been ${days} days since your last session. No guilt, life happens. Want a lighter workout to ease back in today?`,
            // The CTA becomes the user's chat message verbatim — carrying the
            // gap in it grounds the coach's briefing in the real number
            // ("11 days off, so I kept volume moderate…") instead of a
            // generic pep line.
            cta: `Build me a comeback workout for today, it's been ${days} days since my last session`,
            payload: { days_since_last: days },
            dedupeKey: `comeback:${week}`,
        };
    }

    // 4) Streak praise: 3+ training days in the last 7.
    if (workoutsThisWeek >= 3) {
        return {
            kind: "streak",
            title: `${workoutsThisWeek} sessions this week`,
            message: `${hey}${workoutsThisWeek} workouts in the last 7 days. That's the kind of consistency that actually gets results. Your next session is ready when you are.`,
            cta: "What's my workout today?",
            payload: { workouts_this_week: workoutsThisWeek },
            dedupeKey: `streak:${week}`,
        };
    }

    return null;
}

/**
 * Daily pass: draft at most one check-in per recently-active user.
 * Never throws; logs a summary line.
 */
export async function generateCheckinsForActiveUsers(): Promise<void> {
    try {
        const since = new Date();
        since.setDate(since.getDate() - 14);

        // Recently-active users (any set logged in the last 14 days).
        const { data: activeRows, error: activeErr } = await supabase
            .from("exercise_performance")
            .select("user_id")
            .gte("workout_date", since.toISOString())
            .limit(5000);
        if (activeErr) {
            console.warn("[checkins] active-user query failed:", activeErr.message);
            return;
        }
        const userIds = Array.from(new Set((activeRows ?? []).map((r) => String(r.user_id))));
        if (userIds.length === 0) {
            console.log("[checkins] no active users — nothing to draft");
            return;
        }

        let drafted = 0;
        for (const userId of userIds.slice(0, 500)) {
            try {
                const historySince = new Date();
                historySince.setDate(historySince.getDate() - 30);
                const [{ data: rows }, { data: profile }] = await Promise.all([
                    supabase
                        .from("exercise_performance")
                        .select("exercise_id, exercise_name, set_number, reps_completed, weight_used, workout_date")
                        .eq("user_id", userId)
                        .gte("workout_date", historySince.toISOString())
                        .order("workout_date", { ascending: false })
                        .limit(600),
                    supabase
                        .from("user_profiles")
                        .select("name, weight_unit")
                        .eq("id", userId)
                        .maybeSingle(),
                ]);

                const perf = (rows ?? []) as PerfRow[];
                if (perf.length === 0) continue;

                // Cooldown: one coach-initiated check-in per 3 days — except
                // during the activation window (only one session ever, logged
                // within the last week), where the first-week script runs on
                // a daily cadence: first-workout follow-up, then the soreness
                // note a day or two later.
                const perfDays = new Set(perf.map((r) => String(r.workout_date).slice(0, 10)));
                const inActivationWindow =
                    perfDays.size === 1 &&
                    Date.now() - new Date(String(perf[0].workout_date)).getTime() <
                        7 * 24 * 60 * 60 * 1000;
                const cooldown = new Date();
                cooldown.setHours(cooldown.getHours() - (inActivationWindow ? 20 : 72));
                const { data: recent } = await supabase
                    .from("coach_checkins")
                    .select("id")
                    .eq("user_id", userId)
                    .neq("kind", "plan_change")
                    .gte("created_at", cooldown.toISOString())
                    .limit(1);
                if (recent && recent.length > 0) continue;

                // Day math in the USER's timezone (user_quotas.timezone), not
                // server UTC — otherwise "days since last workout" is off by
                // one for anyone west of Greenwich in the evening.
                const tz = await getUserTimezone(userId);
                const localToday = localTodayInTimezone(tz);
                const lastDay = String(perf[0].workout_date).slice(0, 10);
                const daysSinceLastWorkout = Math.max(0, daysBetweenDateStrs(lastDay, localToday));
                const workoutsThisWeek = new Set(
                    perf
                        .map((r) => String(r.workout_date).slice(0, 10))
                        .filter((day) => daysBetweenDateStrs(day, localToday) < 7)
                ).size;

                const firstName =
                    typeof profile?.name === "string" && profile.name.trim()
                        ? profile.name.trim().split(/\s+/)[0]
                        : null;
                const unit = profile?.weight_unit === "lbs" ? "lbs" : "kg";

                const draft = draftCheckinForUser({
                    firstName,
                    unit,
                    rows: perf,
                    daysSinceLastWorkout,
                    workoutsThisWeek,
                });
                if (!draft) continue;

                const expires = new Date();
                expires.setDate(expires.getDate() + 7);
                const { error: insErr } = await supabase.from("coach_checkins").insert({
                    user_id: userId,
                    kind: draft.kind,
                    title: draft.title,
                    message: draft.message,
                    cta: draft.cta,
                    payload: draft.payload,
                    dedupe_key: draft.dedupeKey,
                    expires_at: expires.toISOString(),
                });
                // Unique (user_id, dedupe_key) violation = already drafted this week — fine.
                if (!insErr) drafted++;
            } catch (err) {
                console.warn(`[checkins] user ${userId} failed (non-fatal):`, err);
            }
        }
        console.log(`[checkins] pass complete: ${drafted} check-in(s) drafted across ${userIds.length} active user(s)`);
    } catch (err) {
        console.error("[checkins] pass failed:", err);
    }
}

/**
 * Activation nudges for users who onboarded but NEVER logged a set.
 *
 * Targets people who finish the quiz, get a plan, and never train. Starting 2 days after signup (and at most once per ISO
 * week while the window lasts), the coach speaks first and offers to shrink
 * the barrier ("want me to trim day one to ~20 minutes?"). The check-in card
 * deep-links into chat with that CTA prefilled, so one tap puts the editor to
 * work making the first session smaller.
 */
export async function generateActivationNudgesForNewUsers(): Promise<void> {
    try {
        const windowStart = new Date();
        windowStart.setDate(windowStart.getDate() - 14); // give up after 2 weeks
        const windowEnd = new Date();
        windowEnd.setDate(windowEnd.getDate() - 2); // let day 1-2 breathe

        const { data: newUsers, error } = await supabase
            .from("user_profiles")
            .select("id, name, created_at")
            .eq("onboarding_completed", true)
            .gte("created_at", windowStart.toISOString())
            .lte("created_at", windowEnd.toISOString())
            .limit(500);
        if (error) {
            console.warn("[checkins] activation-nudge user query failed:", error.message);
            return;
        }

        const week = isoWeekKey();
        let drafted = 0;
        for (const u of newUsers ?? []) {
            try {
                const userId = String(u.id);
                const { data: anySet } = await supabase
                    .from("exercise_performance")
                    .select("id")
                    .eq("user_id", userId)
                    .limit(1);
                if (anySet && anySet.length > 0) continue; // activated — other flows own them

                const firstName =
                    typeof u.name === "string" && u.name.trim()
                        ? u.name.trim().split(/\s+/)[0]
                        : null;
                const hey = firstName ? `${firstName}, ` : "";
                const expires = new Date();
                expires.setDate(expires.getDate() + 7);

                const { error: insErr } = await supabase.from("coach_checkins").insert({
                    user_id: userId,
                    kind: "activation_nudge",
                    title: "Your first workout is waiting",
                    message: `${hey}your plan is built and day one is ready. The only thing left is to start. First workouts work best short. Want me to trim it to about 20 minutes so you can knock it out today?`,
                    cta: "Make my first workout about 20 minutes",
                    payload: { signed_up: u.created_at },
                    // One nudge per ISO week while the user stays inactive.
                    dedupe_key: `activation_nudge:${week}`,
                    expires_at: expires.toISOString(),
                });
                if (!insErr) drafted++;
            } catch (err) {
                console.warn("[checkins] activation nudge failed for a user (non-fatal):", err);
            }
        }
        console.log(
            `[checkins] activation pass complete: ${drafted} nudge(s) drafted across ${(newUsers ?? []).length} new user(s)`
        );
    } catch (err) {
        console.error("[checkins] activation pass failed:", err);
    }
}

/**
 * Record a "why the coach changed your plan" note. Fire-and-forget from the
 * plan-mutating chat tools — never throws, never blocks the mutation.
 */
export function recordPlanChangeNote(
    userId: string | null | undefined,
    title: string,
    message: string,
    payload?: Record<string, unknown>
): void {
    if (!userId || !title || !message) return;
    const day = new Date().toISOString().slice(0, 10);
    void supabase
        .from("coach_checkins")
        .insert({
            user_id: userId,
            kind: "plan_change",
            title,
            message,
            cta: null,
            payload: payload ?? null,
            // One note per distinct change per day (hash keeps the key short).
            dedupe_key: `plan_change:${slugify(title)}:${day}:${Math.abs(hashCode(message)).toString(36)}`,
        })
        .then(({ error }) => {
            if (error && !error.message?.includes("duplicate")) {
                console.warn("[checkins] plan-change note failed (non-fatal):", error.message);
            }
        });
}

function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h;
}

/** Schedule the daily drafting pass (runs shortly after boot, then every 12h). */
export function initializeProactiveCoach(): void {
    setTimeout(() => {
        void generateCheckinsForActiveUsers();
        void generateActivationNudgesForNewUsers();
    }, 30_000);
    setInterval(() => {
        void generateCheckinsForActiveUsers();
        void generateActivationNudgesForNewUsers();
    }, 12 * 60 * 60 * 1000);
    console.log("Proactive coach scheduler initialized (runs every 12h)");
}
