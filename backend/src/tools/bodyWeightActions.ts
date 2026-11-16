/**
 * Body Weight Action Tools
 *
 * The progress tab shows body weight pulled from `user_profiles.weight_kg`,
 * but until now nothing wrote a time-series — there was no chartable history
 * and the chat couldn't log weigh-ins. These tools write to
 * `body_weight_logs` (the new time-series table) and keep
 * `user_profiles.weight_kg` in sync so the existing UI still works.
 *
 * Values are stored in kg server-side. The schema accepts `unit` for
 * convenience so the chat doesn't need to convert; lb is converted before
 * write.
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

const LB_PER_KG = 2.2046226218;

// ============================================================================
// log_body_weight
// ============================================================================

export const logBodyWeightTool = new DynamicStructuredTool({
    name: "log_body_weight",
    description:
        "Record a body-weight measurement. Inserts a time-series row in `body_weight_logs` AND updates `user_profiles.weight_kg` so the progress card stays current. Use when the user reports weighing themselves ('I'm 82.4kg this morning', 'down to 178 lbs'). The `unit` param tells the tool how to interpret `weight` — values are always stored in kg.",
    schema: z
        .object({
            user_id: z.string(),
            weight: z
                .number()
                .positive()
                .max(1000)
                .describe("Raw weight value as reported by the user"),
            unit: z
                .enum(["kg", "lbs"])
                .default("kg")
                .describe("Unit of the `weight` value. Defaults to kg."),
            logged_at: z
                .string()
                .datetime()
                .optional()
                .describe(
                    "ISO timestamp for when the weigh-in happened. Defaults to now."
                ),
            note: z
                .string()
                .max(280)
                .optional()
                .describe("Optional short note ('post-workout', 'fasted', etc.)"),
        })
        .strict(),
    func: async ({ user_id, weight, unit, logged_at, note }) => {
        try {
            const weightKg = unit === "lbs" ? weight / LB_PER_KG : weight;
            const roundedKg = Math.round(weightKg * 100) / 100;
            const timestamp = logged_at ?? new Date().toISOString();

            const { data, error } = await supabase
                .from("body_weight_logs")
                .insert({
                    user_id,
                    weight_kg: roundedKg,
                    logged_at: timestamp,
                    note: note ?? null,
                })
                .select("*")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to insert body weight log"),
                };
            }

            // Keep profile in sync so progress tab and onboarding-derived plans
            // see the latest weight without joining the log table.
            const { error: profileErr } = await supabase
                .from("user_profiles")
                .update({
                    weight_kg: roundedKg,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", user_id);

            if (profileErr) {
                console.warn(
                    "log_body_weight: profile sync failed (non-fatal):",
                    profileErr.message
                );
            }

            return {
                success: true,
                log: data,
                message: `Logged ${roundedKg} kg (${(roundedKg * LB_PER_KG).toFixed(1)} lbs).`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "log_body_weight threw"),
            };
        }
    },
});

// ============================================================================
// get_body_weight_history
// ============================================================================

export const getBodyWeightHistoryTool = new DynamicStructuredTool({
    name: "get_body_weight_history",
    description:
        "Read recent body-weight log entries (most recent first). Use to answer 'how's my weight trending?' style questions. Read-only. Pair this with calculate_volume_trend when discussing cut/bulk progress.",
    schema: z
        .object({
            user_id: z.string(),
            days: z
                .number()
                .int()
                .min(1)
                .max(365)
                .default(90)
                .describe("Lookback window in days (default 90)."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(500)
                .default(50)
                .describe("Hard cap on returned rows (default 50)."),
        })
        .strict(),
    func: async ({ user_id, days, limit }) => {
        try {
            const since = new Date();
            since.setDate(since.getDate() - days);

            const { data, error } = await supabase
                .from("body_weight_logs")
                .select("id, weight_kg, logged_at, note")
                .eq("user_id", user_id)
                .gte("logged_at", since.toISOString())
                .order("logged_at", { ascending: false })
                .limit(limit);

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to read body weight logs"),
                    entries: [],
                };
            }

            const entries = (data ?? []).map((row) => ({
                id: row.id,
                weightKg: Number(row.weight_kg),
                weightLbs: Math.round(Number(row.weight_kg) * LB_PER_KG * 10) / 10,
                loggedAt: row.logged_at,
                note: row.note,
            }));

            const latest = entries[0]?.weightKg ?? null;
            const earliest = entries[entries.length - 1]?.weightKg ?? null;
            const deltaKg =
                latest != null && earliest != null
                    ? Math.round((latest - earliest) * 100) / 100
                    : null;

            return {
                success: true,
                count: entries.length,
                windowDays: days,
                latestKg: latest,
                deltaKg,
                entries,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "get_body_weight_history threw"),
                entries: [],
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const bodyWeightActionTools = [
    logBodyWeightTool,
    getBodyWeightHistoryTool,
];
