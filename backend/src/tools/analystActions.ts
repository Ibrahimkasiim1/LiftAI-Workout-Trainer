/**
 * Analyst Action Tools
 *
 * Read-only DynamicStructuredTool implementations the Analyst subgraph uses
 * to answer progress / metrics questions. Nothing here mutates user data.
 *
 * Both tools query `exercise_performance` (the canonical per-set performance
 * log inserted by `log_workout_completion`) and shape the result into a compact
 * JSON the LLM can summarize without hallucinating numbers.
 *
 * The legacy "tool()" exports of the same logical tools in
 * `backend/src/agents/tools.ts` remain in place so existing call sites keep
 * working. The DynamicStructuredTool versions here are bound into the
 * analyst tool array via the registry wiring in `tools.ts`.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { aggregateExercisePerformanceRows } from "./performanceAggregation";

// ============================================================================
// SHARED HELPERS
// ============================================================================

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

const WINDOW_TO_DAYS: Record<string, number> = {
    "30": 30,
    "60": 60,
    "90": 90,
    "all": 365 * 5,
};

// ============================================================================
// get_performance_history
// ============================================================================

export const getPerformanceHistoryActionTool = new DynamicStructuredTool({
    name: "get_performance_history",
    description:
        "Read recent sets logged in `exercise_performance` for a specific exercise the user has performed. " +
        "Use ONLY for analysis / coaching answers; this tool is read-only and never mutates state. " +
        "Returns compact per-session rows ordered most-recent-first with sets, reps, and the heaviest set's weight. " +
        "Pass `window` to scope the lookback to the most common rolling windows (30 / 60 / 90 days) or 'all'.",
    schema: z
        .object({
            user_id: z.string(),
            exercise_id: z
                .string()
                .optional()
                .describe(
                    "Optional exercise_performance.exercise_id to scope to one movement. Omit for a cross-exercise recent-session summary."
                ),
            exercise_name: z
                .string()
                .optional()
                .describe(
                    "Optional case-insensitive substring filter on exercise_name (e.g. 'bench')."
                ),
            window: z
                .enum(["30", "60", "90", "all"])
                .default("30")
                .describe(
                    "Lookback window in days, or 'all' for everything. Defaults to '30'."
                ),
            max_rows: z
                .number()
                .int()
                .min(1)
                .max(200)
                .default(50)
                .describe("Hard cap on returned rows (default 50)."),
        })
        .strict(),
    func: async ({ user_id, exercise_id, exercise_name, window, max_rows }) => {
        try {
            const days = WINDOW_TO_DAYS[window] ?? 30;
            const since = new Date();
            since.setDate(since.getDate() - days);

            // exercise_performance stores one row PER SET. Pull all matching set
            // rows in the window, then collapse them into per-day sessions.
            let query = supabase
                .from("exercise_performance")
                .select(
                    "exercise_id, exercise_name, set_number, reps_completed, weight_used, workout_date"
                )
                .eq("user_id", user_id)
                .gte("workout_date", since.toISOString())
                .order("workout_date", { ascending: false })
                .limit(max_rows * 6);

            if (exercise_id) query = query.eq("exercise_id", exercise_id);
            if (exercise_name) query = query.ilike("exercise_name", `%${exercise_name}%`);

            const { data, error } = await query;

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to query exercise_performance"),
                    sessions: [],
                };
            }

            const sessions = aggregateExercisePerformanceRows(data ?? []).slice(0, max_rows);

            const heaviest =
                sessions.reduce<number>(
                    (max, row) =>
                        typeof row.weight === "number" && row.weight > max ? row.weight : max,
                    0
                ) || 0;

            return {
                success: true,
                window,
                exerciseId: exercise_id ?? null,
                count: sessions.length,
                heaviestWeight: heaviest,
                sessions,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "get_performance_history threw"),
                sessions: [],
            };
        }
    },
});

// ============================================================================
// calculate_volume_trend
// ============================================================================

export const calculateVolumeTrendActionTool = new DynamicStructuredTool({
    name: "calculate_volume_trend",
    description:
        "Aggregate weekly training volume (sets × reps × weight) for the user over the last N weeks (default 4). " +
        "Returns a sorted weekly series plus an overall trend direction (up / down / flat / insufficient_data). " +
        "Read-only — only inspects rows in `exercise_performance`. Use to summarize whether training load is " +
        "trending in the right direction relative to the user's goal.",
    schema: z
        .object({
            user_id: z.string(),
            weeks: z
                .number()
                .int()
                .min(1)
                .max(26)
                .default(4)
                .describe("Lookback window in weeks (1-26, default 4)."),
            minimum_weight_floor: z
                .number()
                .min(0)
                .default(1)
                .describe(
                    "Floor applied to weight when computing volume so bodyweight reps still contribute meaningfully (default 1)."
                ),
        })
        .strict(),
    func: async ({ user_id, weeks, minimum_weight_floor }) => {
        try {
            const since = new Date();
            since.setDate(since.getDate() - weeks * 7);

            const { data, error } = await supabase
                .from("exercise_performance")
                .select(
                    "exercise_name, reps_completed, weight_used, workout_date"
                )
                .eq("user_id", user_id)
                .gte("workout_date", since.toISOString())
                .order("workout_date", { ascending: true });

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to query exercise_performance"),
                    weekly: [],
                };
            }

            // Each row is a single set, so volume per row = reps × weight. We
            // count distinct workout days per week as "sessions".
            const weekly = new Map<string, { volume: number; days: Set<string> }>();

            for (const row of data ?? []) {
                const completedAt = row.workout_date as string | null;
                if (!completedAt) continue;

                const date = new Date(completedAt);
                const day = (date.getUTCDay() + 6) % 7;
                const monday = new Date(date);
                monday.setUTCDate(date.getUTCDate() - day);
                monday.setUTCHours(0, 0, 0, 0);
                const bucket = monday.toISOString().slice(0, 10);

                const reps = Number(row.reps_completed) || 0;
                const weight = Math.max(
                    Number(row.weight_used) || 0,
                    minimum_weight_floor
                );
                const volume = reps * weight;

                const prev = weekly.get(bucket) ?? { volume: 0, days: new Set<string>() };
                prev.volume += volume;
                prev.days.add(completedAt.slice(0, 10));
                weekly.set(bucket, prev);
            }

            const series = Array.from(weekly.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([weekStart, agg]) => ({
                    weekStart,
                    volume: Math.round(agg.volume),
                    sessions: agg.days.size,
                }));

            const totalVolume = series.reduce((s, w) => s + w.volume, 0);
            const trendDirection: "up" | "down" | "flat" | "insufficient_data" =
                series.length >= 2
                    ? series[series.length - 1].volume > series[0].volume
                        ? "up"
                        : series[series.length - 1].volume < series[0].volume
                          ? "down"
                          : "flat"
                    : "insufficient_data";

            const averagePerWeek =
                series.length > 0 ? Math.round(totalVolume / series.length) : 0;

            return {
                success: true,
                weeks,
                totalVolume,
                averagePerWeek,
                trendDirection,
                weekly: series,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "calculate_volume_trend threw"),
                weekly: [],
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const analystActionTools = [
    getPerformanceHistoryActionTool,
    calculateVolumeTrendActionTool,
];
