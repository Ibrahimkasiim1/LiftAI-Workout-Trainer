/**
 * Editor Action Tools
 *
 * Mutating actions used by the Editor subgraph. These cover:
 *   - session-only swaps (only mutate active_workout_sessions)
 *   - master-plan swaps (mutate daily_workouts under workout_plans)
 *   - schedule shifts (rotate day_of_week assignments forward by N days)
 *
 * `daily_workouts` is the active runtime table the frontend reads, so we
 * preserve its column shape (day_of_week, exercises, exercises_structured).
 *
 * All tools use the shared Supabase client and follow the canonical
 * `{ success, ... }` / `{ success: false, error }` contract.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { upsertCoachMemory } from "../services/longTermMemory";
import { recordPlanChangeNote } from "../services/proactiveCheckins";
import { getUserTimezone } from "../services/userTimezone";
import { consumePlanModification } from "./planModificationGate";

// ============================================================================
// SHARED HELPERS
// ============================================================================

/** Days a soft swap-avoidance lingers before expiring (decay). */
const AVOIDANCE_TTL_DAYS = 60;

/**
 * Record a SOFT, decaying "prefers to avoid {exercise}" memory whenever the user
 * swaps an exercise out. Low starting confidence (0.4) means a single one-off
 * swap (e.g. "machine taken") is NOT a permanent ban — but repeated swaps of the
 * same movement blend upward (see upsertCoachMemory) until it crosses the
 * injection threshold and the generator starts avoiding it. Fire-and-forget.
 */
function recordExerciseAvoidance(userId: string | undefined, exerciseName: string | undefined): void {
    const name = (exerciseName ?? "").trim();
    if (!userId || !name) return;
    const expiresAt = new Date(Date.now() + AVOIDANCE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    void upsertCoachMemory(userId, {
        category: "preference",
        fact: `prefers to avoid ${name}`,
        confidence: 0.4,
        expiresAt,
        source: "swap",
    }).catch(() => {
        /* non-fatal: never block a swap on memory write */
    });
}

const DAY_NAMES = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
] as const;

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

interface ExerciseRow {
    id?: string;
    name?: string;
    [key: string]: unknown;
}

function matchesExerciseId(
    candidate: ExerciseRow,
    targetId: string,
    targetName?: string
): boolean {
    if (candidate.id && targetId && candidate.id === targetId) return true;
    if (
        targetName &&
        typeof candidate.name === "string" &&
        candidate.name.toLowerCase().includes(targetName.toLowerCase())
    ) {
        return true;
    }
    return false;
}

async function fetchExerciseById(id: string) {
    const { data, error } = await supabase
        .from("exercises")
        .select("id, name, target_muscle, body_part, equipment, gif_path, instructions")
        .eq("id", id)
        .maybeSingle();
    return { data, error };
}

// ============================================================================
// swap_session_exercise
// ============================================================================

/**
 * Fallback for one-off swaps when no live session row exists (the common
 * case — sessions are client-local until started): swap the exercise on
 * TODAY's `daily_workouts` row of the active plan, marked as a temporary
 * replacement so it's distinguishable from a permanent plan edit.
 */
async function swapInTodaysPlanDay(args: {
    userId: string;
    old_exercise_id: string;
    new_exercise_id: string;
    old_exercise_name_hint?: string;
}) {
    const { userId, old_exercise_id, new_exercise_id, old_exercise_name_hint } = args;

    let todayDow = DAY_NAMES[(new Date().getDay() + 6) % 7];
    try {
        const tz = await getUserTimezone(userId);
        todayDow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
            .format(new Date())
            .toLowerCase() as (typeof DAY_NAMES)[number];
    } catch { /* server day fallback */ }

    const { data: plan, error: planError } = await supabase
        .from("workout_plans")
        .select("id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (planError || !plan) {
        return {
            success: false,
            error: "No live workout session and no active plan found — nothing to swap. TOOL ERROR: DO NOT retry.",
        };
    }

    const { data: dayRow, error: dayError } = await supabase
        .from("daily_workouts")
        .select("id, day_of_week, exercises_structured")
        .eq("plan_id", plan.id)
        .eq("day_of_week", todayDow)
        .maybeSingle();
    if (dayError || !dayRow) {
        return {
            success: false,
            error: `Today (${todayDow}) is a rest day on the plan — there's no session to swap in. Offer to swap it on the day that actually has the exercise, or use swap_permanent_exercise.`,
        };
    }

    const { data: replacement, error: replacementError } = await fetchExerciseById(new_exercise_id);
    if (replacementError || !replacement) {
        return {
            success: false,
            error: describeError(replacementError ?? "exercise not found", "Failed to load replacement exercise"),
        };
    }

    const currentStructured: ExerciseRow[] = Array.isArray(dayRow.exercises_structured)
        ? (dayRow.exercises_structured as ExerciseRow[])
        : [];
    let replacedName = "";
    let didSwap = false;
    const nextStructured = currentStructured.map((row) => {
        if (!didSwap && matchesExerciseId(row, old_exercise_id, old_exercise_name_hint)) {
            didSwap = true;
            replacedName = String(row.name ?? "");
            return {
                ...row,
                id: replacement.id,
                name: replacement.name,
                target_muscle: replacement.target_muscle ?? null,
                body_part: replacement.body_part ?? null,
                equipment: replacement.equipment ?? null,
                gif_path: replacement.gif_path ?? null,
                instructions: replacement.instructions ?? null,
                isReplacement: true,
                isTemporarySwap: true,
                replacedExercise: row.name ?? null,
            };
        }
        return row;
    });

    if (!didSwap) {
        return {
            success: false,
            error: "Could not find that exercise in today's workout. Check the exercise name against today's session in the plan context.",
        };
    }

    const { error: updateError } = await supabase
        .from("daily_workouts")
        .update({
            exercises_structured: nextStructured,
            exercises: nextStructured.map((r) => String(r.name ?? "")),
        })
        .eq("id", dayRow.id);
    if (updateError) {
        return {
            success: false,
            error: describeError(updateError, "Failed to update today's workout"),
        };
    }

    recordExerciseAvoidance(userId, replacedName);

    return {
        success: true,
        swappedInPlanDay: todayDow,
        replacedWith: replacement.name,
        avoidanceRecorded: Boolean(replacedName),
        message: `Swapped ${replacedName || "that exercise"} → "${replacement.name}" for today's session.`,
    };
}

export const swapSessionExerciseTool = new DynamicStructuredTool({
    name: "swap_session_exercise",
    description:
        "Replace an exercise for TODAY only (one-off swap, e.g. machine taken). " +
        "Targets the user's live workout session when one exists; otherwise swaps the exercise " +
        "on TODAY's row in the plan (a session swap the user sees immediately). " +
        "For changes that should persist across all future sessions call `swap_permanent_exercise` instead.",
    schema: z
        .object({
            userId: z
                .string()
                .describe("User ID — used to resolve the live session / today's workout, and to record the avoidance preference."),
            session_id: z
                .string()
                .optional()
                .describe("Optional active_workout_sessions.id if known. Usually omit — the tool resolves the user's live session itself."),
            target_index: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Exact exercises_structured slot to replace in-place."),
            old_exercise_id: z
                .string()
                .describe("Exercise id (or substring of name) currently in the session."),
            new_exercise_id: z
                .string()
                .min(1)
                .describe("Exercise id from the `exercises` library to swap in."),
            old_exercise_name_hint: z
                .string()
                .optional()
                .describe(
                    "Optional human-readable hint used as a fallback match when ids are missing on the session row."
                ),
        })
        .strict(),
    func: async ({
        userId,
        session_id,
        target_index,
        old_exercise_id,
        new_exercise_id,
        old_exercise_name_hint,
    }) => {
        try {
            // Resolve the live session: by id when a real one was passed,
            // otherwise by user (most recently started). The old contract
            // required a session_id the agent never actually had, and silently
            // reported success when it was missing — the swap never happened.
            const isUuid =
                typeof session_id === "string" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id);
            let session: { id: string; exercises: unknown; exercises_structured: unknown } | null = null;
            if (isUuid) {
                const { data, error } = await supabase
                    .from("active_workout_sessions")
                    .select("id, exercises, exercises_structured")
                    .eq("id", session_id as string)
                    .maybeSingle();
                if (error) {
                    return {
                        success: false,
                        error: describeError(error, "Failed to load active_workout_sessions row"),
                    };
                }
                session = data;
            }
            if (!session) {
                const { data } = await supabase
                    .from("active_workout_sessions")
                    .select("id, exercises, exercises_structured")
                    .eq("user_id", userId)
                    .order("started_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();
                session = data ?? null;
            }

            if (!session) {
                // No live session — swap on TODAY's plan row instead so the
                // change is actually visible when the user opens the workout.
                return swapInTodaysPlanDay({
                    userId,
                    old_exercise_id,
                    new_exercise_id,
                    old_exercise_name_hint,
                });
            }

            const { data: replacement, error: replacementError } =
                await fetchExerciseById(new_exercise_id);

            if (replacementError || !replacement) {
                return {
                    success: false,
                    error: describeError(
                        replacementError ?? "exercise not found",
                        "Failed to load replacement exercise"
                    ),
                };
            }

            const currentStructured: ExerciseRow[] = Array.isArray(
                session.exercises_structured
            )
                ? (session.exercises_structured as ExerciseRow[])
                : [];

            let didSwap = false;
            let swappedIndex = -1;
            let replacedName = "";
            const nextStructured = [...currentStructured];

            const buildReplacementRow = (row: ExerciseRow) => ({
                ...row,
                id: replacement.id,
                name: replacement.name,
                target_muscle: replacement.target_muscle ?? null,
                body_part: replacement.body_part ?? null,
                equipment: replacement.equipment ?? null,
                gif_path: replacement.gif_path ?? null,
                instructions: replacement.instructions ?? null,
                isReplacement: true,
                replacedExerciseId: row.id ?? null,
            });

            if (typeof target_index === "number") {
                if (target_index < 0 || target_index >= nextStructured.length) {
                    return {
                        success: false,
                        error: `target_index ${target_index} is out of bounds for exercises_structured length ${nextStructured.length}.`,
                    };
                }

                const currentRow = nextStructured[target_index];
                if (!currentRow) {
                    return {
                        success: false,
                        error: `Could not load exercise row at target_index ${target_index}.`,
                    };
                }

                replacedName = String(currentRow.name ?? "");
                nextStructured[target_index] = buildReplacementRow(currentRow);
                didSwap = true;
                swappedIndex = target_index;
            } else {
                for (let i = 0; i < nextStructured.length; i += 1) {
                    const row = nextStructured[i];
                    if (!didSwap && matchesExerciseId(row, old_exercise_id, old_exercise_name_hint)) {
                        replacedName = String(row.name ?? "");
                        nextStructured[i] = buildReplacementRow(row);
                        didSwap = true;
                        swappedIndex = i;
                        break;
                    }
                }
            }

            if (!didSwap) {
                return {
                    success: false,
                    error:
                        "Could not locate the requested exercise in this session's structured list.",
                };
            }

            const nextNames = nextStructured.map((row) =>
                String(row.name ?? "")
            );

            const { error: updateError } = await supabase
                .from("active_workout_sessions")
                .update({
                    exercises_structured: nextStructured,
                    exercises: nextNames,
                })
                .eq("id", session.id);

            if (updateError) {
                return {
                    success: false,
                    error: describeError(
                        updateError,
                        "Failed to update active_workout_sessions"
                    ),
                };
            }

            // Soft, decaying avoidance for the swapped-out movement.
            recordExerciseAvoidance(userId, replacedName);

            return {
                success: true,
                sessionId: session.id,
                swappedIndex,
                replacedWith: replacement.name,
                avoidanceRecorded: Boolean(userId && replacedName),
                message:
                    `Swapped in "${replacement.name}".` +
                    (userId && replacedName
                        ? ` Noted your preference — I'll favor alternatives to ${replacedName} in future workouts (tell me if you want it back).`
                        : ""),
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "swap_session_exercise threw"),
            };
        }
    },
});

// ============================================================================
// swap_permanent_exercise
// ============================================================================

export const swapPermanentExerciseTool = new DynamicStructuredTool({
    name: "swap_permanent_exercise",
    description:
        "Permanently replace an exercise inside the user's master plan. " +
        "Updates every matching row in `daily_workouts` for the supplied plan_id by mutating `exercises` and `exercises_structured`. " +
        "Use only for durable changes the user wants applied to all future sessions on every matching day. " +
        "For a single-session swap use `swap_session_exercise` instead.",
    schema: z
        .object({
            user_id: z.string(),
            plan_id: z
                .string()
                .uuid()
                .describe("workout_plans.id whose daily_workouts rows should be edited."),
            old_exercise_id: z
                .string()
                .describe(
                    "Exercise id to remove. Falls back to name substring match on `exercises_structured[*].name` when no id is on the row."
                ),
            new_exercise_id: z
                .string()
                .uuid()
                .describe("Exercise id from the `exercises` library to insert."),
            old_exercise_name_hint: z
                .string()
                .optional()
                .describe(
                    "Optional human-readable hint used as a fallback match when ids are missing on plan rows."
                ),
        })
        .strict(),
    func: async ({
        user_id,
        plan_id,
        old_exercise_id,
        new_exercise_id,
        old_exercise_name_hint,
    }) => {
        try {
            // Free tier: capped at 3 permanent plan modifications.
            const gate = await consumePlanModification(user_id);
            if (gate.allowed === false) {
                return {
                    success: false,
                    error: gate.reason,
                    limit: gate.limit,
                    used: gate.used,
                    message: gate.message,
                };
            }

            const { data: plan, error: planError } = await supabase
                .from("workout_plans")
                .select("id, user_id")
                .eq("id", plan_id)
                .maybeSingle();

            if (planError) {
                return {
                    success: false,
                    error: describeError(planError, "Failed to load workout_plans"),
                };
            }

            if (!plan) {
                return { success: false, error: `No workout_plans row for id ${plan_id}.` };
            }

            if (plan.user_id !== user_id) {
                return {
                    success: false,
                    error: "Plan does not belong to the supplied user_id.",
                };
            }

            const { data: replacement, error: replacementError } =
                await fetchExerciseById(new_exercise_id);

            if (replacementError || !replacement) {
                return {
                    success: false,
                    error: describeError(
                        replacementError ?? "exercise not found",
                        "Failed to load replacement exercise"
                    ),
                };
            }

            const { data: dayRows, error: daysError } = await supabase
                .from("daily_workouts")
                .select("id, exercises, exercises_structured, day_of_week")
                .eq("plan_id", plan_id);

            if (daysError) {
                return {
                    success: false,
                    error: describeError(daysError, "Failed to load daily_workouts"),
                };
            }

            const affectedDays: string[] = [];
            let totalSwaps = 0;
            let replacedName = "";

            for (const day of dayRows ?? []) {
                const currentStructured: ExerciseRow[] = Array.isArray(
                    day.exercises_structured
                )
                    ? (day.exercises_structured as ExerciseRow[])
                    : [];

                let dayMutated = false;
                const nextStructured = currentStructured.map((row) => {
                    if (matchesExerciseId(row, old_exercise_id, old_exercise_name_hint)) {
                        dayMutated = true;
                        totalSwaps += 1;
                        if (!replacedName) replacedName = String(row.name ?? "");
                        return {
                            ...row,
                            id: replacement.id,
                            name: replacement.name,
                            target_muscle: replacement.target_muscle ?? null,
                            body_part: replacement.body_part ?? null,
                            equipment: replacement.equipment ?? null,
                            gif_path: replacement.gif_path ?? null,
                            instructions: replacement.instructions ?? null,
                        };
                    }
                    return row;
                });

                if (!dayMutated) continue;

                const nextNames = nextStructured.map((row) =>
                    String(row.name ?? "")
                );

                const { error: updateError } = await supabase
                    .from("daily_workouts")
                    .update({
                        exercises_structured: nextStructured,
                        exercises: nextNames,
                    })
                    .eq("id", day.id);

                if (updateError) {
                    return {
                        success: false,
                        error: describeError(
                            updateError,
                            `Failed to update daily_workouts row ${day.id}`
                        ),
                    };
                }

                affectedDays.push(String(day.day_of_week));
            }

            if (totalSwaps === 0) {
                return {
                    success: false,
                    error:
                        "Could not find the target exercise on any day of this plan. Double-check the old_exercise_id or hint.",
                };
            }

            // Permanent swap = a strong preference signal. Record a soft,
            // decaying avoidance for the removed movement (blends upward if the
            // user keeps swapping the same thing out).
            recordExerciseAvoidance(user_id, replacedName);

            recordPlanChangeNote(
                user_id,
                `Swapped ${replacedName || "an exercise"} → ${replacement.name}`,
                `I permanently replaced ${replacedName || "that exercise"} with ${replacement.name} across ${affectedDays.length} day(s) of your plan, as you asked. I'll also steer future workouts away from ${replacedName || "it"} — tell me if you ever want it back.`,
                { replaced: replacedName, replacement: replacement.name, affectedDays }
            );

            return {
                success: true,
                replacedWith: replacement.name,
                swapsApplied: totalSwaps,
                affectedDays,
                avoidanceRecorded: Boolean(replacedName),
                message:
                    `Permanently swapped ${totalSwaps} occurrence(s) on ${affectedDays.length} day(s).` +
                    (replacedName
                        ? ` I'll keep ${replacedName} out of your future workouts unless you ask for it back.`
                        : ""),
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "swap_permanent_exercise threw"),
            };
        }
    },
});

// ============================================================================
// shift_workout_schedule
// ============================================================================

export const shiftWorkoutScheduleTool = new DynamicStructuredTool({
    name: "shift_workout_schedule",
    description:
        "Shift every scheduled day on the user's active plan forward by N days (negative values shift backward). " +
        "Mutates the `day_of_week` column on every `daily_workouts` row of the active plan, preserving the rest of the row. " +
        "Use when the user misses a day, takes a deload, or wants to slide the whole week. " +
        "Returns the mapping of old_day -> new_day so the caller can summarize.",
    schema: z
        .object({
            user_id: z.string(),
            days_to_shift: z
                .number()
                .int()
                .min(-6)
                .max(6)
                .describe(
                    "Number of days to shift the schedule. Positive = push forward, negative = pull backward. Range -6..6."
                ),
        })
        .strict(),
    func: async ({ user_id, days_to_shift }) => {
        try {
            if (days_to_shift === 0) {
                return {
                    success: true,
                    message: "No shift requested (days_to_shift = 0).",
                    shifts: [],
                };
            }

            // Free tier: capped at 3 permanent plan modifications.
            const gate = await consumePlanModification(user_id);
            if (gate.allowed === false) {
                return {
                    success: false,
                    error: gate.reason,
                    limit: gate.limit,
                    used: gate.used,
                    message: gate.message,
                };
            }

            const { data: plan, error: planError } = await supabase
                .from("workout_plans")
                .select("id")
                .eq("user_id", user_id)
                .eq("is_active", true)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (planError) {
                return {
                    success: false,
                    error: describeError(planError, "Failed to load active workout_plans"),
                };
            }

            if (!plan) {
                return {
                    success: false,
                    error: "User has no active workout plan to shift.",
                };
            }

            const { data: dayRows, error: daysError } = await supabase
                .from("daily_workouts")
                .select("id, day_of_week")
                .eq("plan_id", plan.id);

            if (daysError) {
                return {
                    success: false,
                    error: describeError(daysError, "Failed to load daily_workouts"),
                };
            }

            if (!dayRows || dayRows.length === 0) {
                return {
                    success: false,
                    error: "Active plan has no daily_workouts rows to shift.",
                };
            }

            const shifts: Array<{ id: string; from: string; to: string }> = [];
            const offset = ((days_to_shift % 7) + 7) % 7;

            for (const row of dayRows) {
                const currentDow = String(row.day_of_week ?? "").toLowerCase();
                const idx = DAY_NAMES.findIndex((d) => d === currentDow);
                if (idx === -1) {
                    return {
                        success: false,
                        error: `Encountered unknown day_of_week "${row.day_of_week}" on row ${row.id}.`,
                    };
                }
                const nextDow = DAY_NAMES[(idx + offset) % 7];
                shifts.push({ id: String(row.id), from: currentDow, to: nextDow });
            }

            for (const shift of shifts) {
                const { error: updateError } = await supabase
                    .from("daily_workouts")
                    .update({ day_of_week: shift.to })
                    .eq("id", shift.id);

                if (updateError) {
                    return {
                        success: false,
                        error: describeError(
                            updateError,
                            `Failed to shift day_of_week on row ${shift.id}`
                        ),
                    };
                }
            }

            recordPlanChangeNote(
                user_id,
                "Schedule shifted",
                `I moved your whole training week ${days_to_shift > 0 ? "forward" : "back"} by ${Math.abs(days_to_shift)} day(s) so your plan lines up with your schedule again.`,
                { daysShifted: days_to_shift }
            );

            return {
                success: true,
                planId: plan.id,
                daysShifted: days_to_shift,
                shifts,
                message: `Shifted ${shifts.length} day(s) by ${days_to_shift} day(s).`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "shift_workout_schedule threw"),
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const editorActionTools = [
    swapSessionExerciseTool,
    swapPermanentExerciseTool,
    shiftWorkoutScheduleTool,
];
