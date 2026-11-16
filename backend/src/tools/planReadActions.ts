/**
 * Plan read tools (read-only).
 *
 * `get_todays_workout` gives any agent a grounded view of the user's ACTIVE
 * plan: today's session (in the user's timezone), the week structure, and the
 * plan id. The analyst needs this to answer cross-cutting questions ("does my
 * volume match my plan?", "what am I supposed to train today?") that history
 * tools alone can't ground.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { getUserTimezone } from "../services/userTimezone";

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
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

interface PlanExerciseRow {
    id?: string;
    name?: string;
    sets?: number;
    reps?: string | number;
    rest_seconds?: number;
    equipment?: string;
    target_muscle?: string;
    isReplacement?: boolean;
    isTemporarySwap?: boolean;
    [key: string]: unknown;
}

export const getTodaysWorkoutTool = new DynamicStructuredTool({
    name: "get_todays_workout",
    description:
        "Read the user's ACTIVE plan: today's scheduled session (resolved in their local timezone), " +
        "the full week structure (day → focus → exercise count), and the plan id. Read-only. " +
        "Use to answer 'what am I training today / this week?', to ground volume-vs-plan comparisons, " +
        "or to look up exact exercise names/sets/reps before discussing or editing the plan. " +
        "Pass `day` to read a specific weekday instead of today.",
    schema: z
        .object({
            user_id: z.string(),
            day: z
                .enum(DAY_NAMES)
                .optional()
                .describe("Optional specific weekday to read; defaults to today in the user's timezone."),
        })
        .strict(),
    func: async ({ user_id, day }) => {
        try {
            const { data: plan, error: planError } = await supabase
                .from("workout_plans")
                .select("id, plan_name, created_at")
                .eq("user_id", user_id)
                .eq("is_active", true)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (planError) {
                return { success: false, error: describeError(planError, "Failed to load active plan") };
            }
            if (!plan) {
                return {
                    success: false,
                    error: "User has no active workout plan.",
                };
            }

            const { data: days, error: daysError } = await supabase
                .from("daily_workouts")
                .select("day_of_week, split_day_name, estimated_time, exercises_structured, notes")
                .eq("plan_id", plan.id);

            if (daysError) {
                return { success: false, error: describeError(daysError, "Failed to load plan days") };
            }

            let targetDay: string = day ?? "";
            if (!targetDay) {
                const tz = await getUserTimezone(user_id);
                try {
                    targetDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
                        .format(new Date())
                        .toLowerCase();
                } catch {
                    targetDay = DAY_NAMES[(new Date().getDay() + 6) % 7];
                }
            }

            const ordered = (days ?? []).slice().sort((a, b) => {
                const ai = DAY_NAMES.indexOf(String(a.day_of_week).toLowerCase() as any);
                const bi = DAY_NAMES.indexOf(String(b.day_of_week).toLowerCase() as any);
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });

            const week = ordered.map((d) => {
                const exs = Array.isArray(d.exercises_structured)
                    ? (d.exercises_structured as PlanExerciseRow[])
                    : [];
                return {
                    day_of_week: String(d.day_of_week).toLowerCase(),
                    focus: d.split_day_name ?? "Workout",
                    exercise_count: exs.length,
                    estimated_time: d.estimated_time ?? null,
                };
            });

            const todayRow = ordered.find(
                (d) => String(d.day_of_week).toLowerCase() === targetDay
            );

            const todaysWorkout = todayRow
                ? {
                      day_of_week: targetDay,
                      focus: todayRow.split_day_name ?? "Workout",
                      estimated_time: todayRow.estimated_time ?? null,
                      notes: todayRow.notes ?? null,
                      exercises: (Array.isArray(todayRow.exercises_structured)
                          ? (todayRow.exercises_structured as PlanExerciseRow[])
                          : []
                      ).map((ex) => ({
                          id: ex.id ?? null,
                          name: ex.name ?? "",
                          sets: ex.sets ?? 3,
                          reps: ex.reps ?? "8-12",
                          rest_seconds: ex.rest_seconds ?? 90,
                          equipment: ex.equipment ?? null,
                          target_muscle: ex.target_muscle ?? null,
                          is_temporary_swap: Boolean(ex.isTemporarySwap),
                      })),
                  }
                : null;

            return {
                success: true,
                plan_id: plan.id,
                plan_name: plan.plan_name ?? null,
                requested_day: targetDay,
                is_rest_day: !todayRow,
                todays_workout: todaysWorkout,
                week,
            };
        } catch (err) {
            return { success: false, error: describeError(err, "get_todays_workout threw") };
        }
    },
});

export const planReadTools = [getTodaysWorkoutTool];
