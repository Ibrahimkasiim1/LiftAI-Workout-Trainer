/**
 * Saved Workout Action Tools
 *
 * Lets the chat persist generated workouts to the user's saved library, list
 * them back, and delete them. Wraps the existing `saved_workouts` table
 * (schema in UNIFIED_DATABASE_SETUP.sql + migration 005).
 *
 * The `create_one_off_workout` tool builds a workout object but only renders
 * it as an in-app modal — it never persists. These tools fix that gap so the
 * user can say "save this workout for next time" without leaving chat.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { estimateWorkoutDurationMinutes } from "../services/workoutDuration";

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

/** Free-tier cap on persisted workout templates. Pro users are unlimited. */
const FREE_SAVED_WORKOUTS_LIMIT = 3;

/** Lowercase, trim, collapse whitespace — for fuzzy name/exercise matching. */
function normalizeName(s: string): string {
    return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Jaccard overlap of two string sets (0..1). Used to detect near-duplicate workouts. */
function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

/**
 * Returns true when the user is on the free (ad-supported) tier and therefore
 * subject to the saved-workouts cap. `premium` users always return false.
 * Defensive: on lookup failure we treat the user as free — better to err on
 * the side of enforcing the limit than to give a paid feature away on errors.
 */
async function isFreeTier(userId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from("user_quotas")
        .select("tier_type")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) return true;
    return (data?.tier_type ?? "ad_supported") !== "premium";
}

const exerciseSchema = z
    .object({
        id: z.string().optional(),
        name: z.string().min(1),
        sets: z.coerce.number().int().min(1).max(20).default(3),
        reps: z.union([z.string(), z.number()]).default("8-12"),
        rest_seconds: z.coerce.number().int().min(0).max(600).default(90),
        equipment: z.string().optional().nullable(),
        target_muscle: z.string().optional().nullable(),
        body_part: z.string().optional().nullable(),
        gif_path: z.string().optional().nullable(),
    })
    .passthrough();

// ============================================================================
// save_workout_to_library
// ============================================================================

export const saveWorkoutToLibraryTool = new DynamicStructuredTool({
    name: "save_workout_to_library",
    description:
        "Persist a workout to the user's saved library so it shows up in the Saved tab and they can run it again later. Use when the user explicitly says to save / keep / bookmark a workout, OR right after `create_one_off_workout` if they ask to save it. Pass the exercises returned by `create_one_off_workout` verbatim (with their ids) — do not invent exercise names.",
    schema: z
        .object({
            user_id: z.string(),
            workout_name: z
                .string()
                .min(1)
                .max(100)
                .describe("Short user-facing label, e.g. 'Hotel Push Day'"),
            workout_type: z
                .enum([
                    "main_plan",
                    "main_plan_edit",
                    "extra_workout",
                    "replacement_workout",
                    "quick_workout",
                ])
                .default("extra_workout")
                .describe(
                    "Category constraint from saved_workouts_workout_type_check. Default `extra_workout` for any chat-generated session."
                ),
            exercises: z
                .array(exerciseSchema)
                .min(1)
                .max(20)
                .describe("Structured exercises (typically the array returned by create_one_off_workout)"),
            estimated_time: z
                .number()
                .int()
                .min(5)
                .max(300)
                .optional()
                .describe("Estimated workout duration in minutes. Omit to auto-compute from sets/reps/rest."),
            difficulty: z
                .enum(["beginner", "intermediate", "advanced"])
                .default("intermediate"),
            description: z
                .string()
                .max(280)
                .optional()
                .describe("Optional one-liner shown under the workout name"),
            note: z
                .string()
                .max(280)
                .optional()
                .describe("Optional coach note attached to the workout"),
        })
        .strict(),
    func: async ({
        user_id,
        workout_name,
        workout_type,
        exercises,
        estimated_time,
        difficulty,
        description,
        note,
    }) => {
        try {
            // Free-tier cap: 3 saved workouts. Pro users skip this check.
            if (await isFreeTier(user_id)) {
                const { count, error: countErr } = await supabase
                    .from("saved_workouts")
                    .select("id", { count: "exact", head: true })
                    .eq("user_id", user_id);
                if (countErr) {
                    return {
                        success: false,
                        error: describeError(countErr, "Failed to count saved workouts"),
                    };
                }
                if ((count ?? 0) >= FREE_SAVED_WORKOUTS_LIMIT) {
                    return {
                        success: false,
                        error: "pro_required:saved_workouts_limit",
                        limit: FREE_SAVED_WORKOUTS_LIMIT,
                        message: `Free plan is capped at ${FREE_SAVED_WORKOUTS_LIMIT} saved workouts. Upgrade to Pro for unlimited saves.`,
                    };
                }
            }

            const exerciseNames = exercises.map((e) => e.name);
            const resolvedEstimatedTime =
                estimated_time ?? estimateWorkoutDurationMinutes(exercises as any[]);

            // ── Dedup: don't insert a near-twin. Match on normalized name OR a
            // high exercise-set overlap (Jaccard ≥ 0.7), and UPDATE the existing
            // row in place instead — keeps the library clean on repeat saves.
            const { data: existingRows } = await supabase
                .from("saved_workouts")
                .select("id, workout_name, exercises")
                .eq("user_id", user_id);

            const newNameKey = normalizeName(workout_name);
            const newSet = new Set(exerciseNames.map(normalizeName));
            const duplicate = (existingRows ?? []).find((row) => {
                if (normalizeName(String(row.workout_name)) === newNameKey) return true;
                const existingSet = new Set(
                    (Array.isArray(row.exercises) ? (row.exercises as string[]) : []).map(normalizeName)
                );
                return jaccard(newSet, existingSet) >= 0.7;
            });

            if (duplicate) {
                const { data: updated, error: updErr } = await supabase
                    .from("saved_workouts")
                    .update({
                        workout_name,
                        workout_type,
                        exercises: exerciseNames,
                        exercises_structured: exercises,
                        estimated_time: resolvedEstimatedTime,
                        difficulty,
                        description: description ?? null,
                        note: note ?? null,
                    })
                    .eq("id", duplicate.id)
                    .eq("user_id", user_id)
                    .select("id, workout_name, workout_type, estimated_time, created_at")
                    .single();
                if (updErr) {
                    return { success: false, error: describeError(updErr, "Failed to update existing saved workout") };
                }
                return {
                    success: true,
                    saved: updated,
                    deduped: true,
                    message: `You already had a very similar workout saved — I updated "${workout_name}" instead of adding a duplicate.`,
                };
            }

            const { data, error } = await supabase
                .from("saved_workouts")
                .insert({
                    user_id,
                    workout_name,
                    workout_type,
                    exercises: exerciseNames,
                    exercises_structured: exercises,
                    estimated_time: resolvedEstimatedTime,
                    difficulty,
                    description: description ?? null,
                    note: note ?? null,
                })
                .select("id, workout_name, workout_type, estimated_time, created_at")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to save workout"),
                };
            }

            return {
                success: true,
                saved: data,
                message: `Saved "${workout_name}" (${exercises.length} exercises) to your library.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "save_workout_to_library threw"),
            };
        }
    },
});

// ============================================================================
// list_saved_workouts
// ============================================================================

export const listSavedWorkoutsTool = new DynamicStructuredTool({
    name: "list_saved_workouts",
    description:
        "List the user's saved workouts (most recent first). Use when the user asks 'what workouts do I have saved?' or to look up an id before calling `delete_saved_workout`. Read-only.",
    schema: z
        .object({
            user_id: z.string(),
            workout_type: z
                .enum([
                    "main_plan",
                    "main_plan_edit",
                    "extra_workout",
                    "replacement_workout",
                    "quick_workout",
                ])
                .optional()
                .describe("Optional filter on workout_type"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(20)
                .describe("Hard cap on returned rows (default 20)."),
        })
        .strict(),
    func: async ({ user_id, workout_type, limit }) => {
        try {
            let query = supabase
                .from("saved_workouts")
                .select(
                    "id, workout_name, workout_type, exercises, estimated_time, difficulty, description, note, created_at"
                )
                .eq("user_id", user_id)
                .order("created_at", { ascending: false })
                .limit(limit);

            if (workout_type) {
                query = query.eq("workout_type", workout_type);
            }

            const { data, error } = await query;
            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to list saved workouts"),
                    workouts: [],
                };
            }

            return {
                success: true,
                count: data?.length ?? 0,
                workouts: data ?? [],
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "list_saved_workouts threw"),
                workouts: [],
            };
        }
    },
});

// ============================================================================
// delete_saved_workout
// ============================================================================

export const deleteSavedWorkoutTool = new DynamicStructuredTool({
    name: "delete_saved_workout",
    description:
        "Remove a workout from the user's saved library. Verifies ownership before deleting. If the user names a workout rather than giving an id, call `list_saved_workouts` first and pick the matching id.",
    schema: z
        .object({
            user_id: z.string(),
            workout_id: z.string().describe("saved_workouts.id to remove"),
        })
        .strict(),
    func: async ({ user_id, workout_id }) => {
        try {
            const { error, count } = await supabase
                .from("saved_workouts")
                .delete({ count: "exact" })
                .eq("id", workout_id)
                .eq("user_id", user_id);

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to delete saved workout"),
                };
            }
            if (!count) {
                return {
                    success: false,
                    error: "No matching workout found (already deleted or not owned by user)",
                };
            }
            return { success: true, message: "Saved workout removed." };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "delete_saved_workout threw"),
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const savedWorkoutActionTools = [
    saveWorkoutToLibraryTool,
    listSavedWorkoutsTool,
    deleteSavedWorkoutTool,
];
