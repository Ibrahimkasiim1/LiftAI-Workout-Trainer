/**
 * Profile-edit + manual performance-logging tools for the chat agents.
 *
 * - `update_user_profile`: lets the coach change a whitelisted set of
 *   `user_profiles` columns (name, units, goal, days/week, body metrics, …)
 *   from chat. Only known columns are written — arbitrary keys are dropped.
 * - `log_exercise_set`: writes one-or-more sets straight into the per-set
 *   `exercise_performance` log (the same table the analyst reads), so users can
 *   record a lift without going through the full workout-completion flow.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

// ============================================================================
// update_user_profile
// ============================================================================

const LBS_PER_KG = 2.20462;

export const updateUserProfileTool = new DynamicStructuredTool({
    name: "update_user_profile",
    description:
        "Update the user's profile / settings in `user_profiles`. Use when the user asks to change their name, " +
        "training goal, target weight, fitness level, training days per week, split type, session length, units, " +
        "location, gender, height, body weight, or birthday. Only the fields the user explicitly wants changed " +
        "should be supplied. Weight is stored in kg (pass `weight_kg`); if the user gives lbs, convert first.",
    schema: z
        .object({
            user_id: z.string(),
            name: z.string().optional(),
            gender: z.string().optional(),
            birthday: z.string().optional().describe("ISO date (YYYY-MM-DD)."),
            height_cm: z.number().positive().optional(),
            weight_kg: z.number().positive().optional(),
            weight_unit: z.enum(["kg", "lbs"]).optional(),
            height_unit: z.enum(["cm", "ft"]).optional(),
            goal: z.string().optional().describe("e.g. 'lose_weight', 'build_muscle', 'maintain'."),
            goal_weight_kg: z.number().positive().optional(),
            fitness_level: z.string().optional().describe("e.g. 'beginner', 'intermediate', 'advanced'."),
            workout_days_per_week: z.number().int().min(1).max(7).optional(),
            workout_split_type: z.string().optional(),
            workout_duration_minutes: z.number().int().min(5).max(240).optional(),
            location: z.string().optional(),
        })
        .strict(),
    func: async ({ user_id, ...rest }) => {
        try {
            // Whitelist: only these columns may be written from chat.
            const ALLOWED = new Set([
                "name",
                "gender",
                "birthday",
                "height_cm",
                "weight_kg",
                "weight_unit",
                "height_unit",
                "goal",
                "goal_weight_kg",
                "fitness_level",
                "workout_days_per_week",
                "workout_split_type",
                "workout_duration_minutes",
                "location",
            ]);

            const updates: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(rest)) {
                if (value === undefined || value === null) continue;
                if (ALLOWED.has(key)) updates[key] = value;
            }

            if (Object.keys(updates).length === 0) {
                return {
                    success: false,
                    error: "No recognized profile fields to update.",
                };
            }

            updates.updated_at = new Date().toISOString();

            const { error } = await supabase
                .from("user_profiles")
                .update(updates)
                .eq("id", user_id);

            if (error) {
                return { success: false, error: describeError(error, "Failed to update profile") };
            }

            const changed = Object.keys(updates).filter((k) => k !== "updated_at");
            return {
                success: true,
                message: `Updated ${changed.join(", ")}.`,
                updatedFields: changed,
            };
        } catch (err) {
            return { success: false, error: describeError(err, "update_user_profile threw") };
        }
    },
});

// ============================================================================
// log_exercise_set
// ============================================================================

export const logExerciseSetTool = new DynamicStructuredTool({
    name: "log_exercise_set",
    description:
        "Record a performed exercise straight into the per-set `exercise_performance` log. Use when the user " +
        "says something like 'log 3 sets of 8 at 80kg on bench'. Expands `sets` into individual set rows. " +
        "weight is in kg (convert from lbs first if needed). Use this for ad-hoc set logging; use " +
        "log_workout_completion when finishing a full structured session.",
    schema: z
        .object({
            user_id: z.string(),
            exercise_name: z.string().min(1),
            exercise_id: z.string().optional(),
            weight: z.number().min(0).describe("Weight per set in kg (0 for bodyweight)."),
            reps: z.number().int().min(1),
            sets: z.number().int().min(1).max(20).default(1),
            workout_date: z.string().optional().describe("ISO timestamp; defaults to now."),
            comment: z.string().optional(),
        })
        .strict(),
    func: async ({ user_id, exercise_name, exercise_id, weight, reps, sets, workout_date, comment }) => {
        try {
            const when = workout_date || new Date().toISOString();
            const rows = Array.from({ length: sets }, (_, i) => ({
                user_id,
                exercise_id: exercise_id ?? null,
                exercise_name,
                set_number: i + 1,
                reps_completed: reps,
                weight_used: weight,
                workout_date: when,
                comment: comment ?? null,
            }));

            const { error } = await supabase.from("exercise_performance").insert(rows);
            if (error) {
                return { success: false, error: describeError(error, "Failed to log sets") };
            }

            return {
                success: true,
                message: `Logged ${sets} × ${reps} of ${exercise_name}${weight > 0 ? ` @ ${weight}kg` : ""}.`,
                setsLogged: sets,
            };
        } catch (err) {
            return { success: false, error: describeError(err, "log_exercise_set threw") };
        }
    },
});

export const profileAndLoggingTools = [updateUserProfileTool, logExerciseSetTool];

// Helper exported for unit tests: convert lbs to kg.
export function lbsToKg(lbs: number): number {
    return lbs / LBS_PER_KG;
}
