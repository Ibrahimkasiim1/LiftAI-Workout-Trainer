/**
 * Nutrition Action Tools
 *
 * DynamicStructuredTool implementations that let the analyst/editor agents
 * actually WRITE nutrition state — not just parse strings. These wrap the
 * same Supabase tables the REST handlers in `routes/nutrition.ts` already
 * use, so chat-side and app-side stay in sync.
 *
 * - log_nutrition_entry        → POST nutrition_logs (re-parses macros)
 * - edit_nutrition_entry       → PATCH nutrition_logs (re-parses macros)
 * - delete_nutrition_entry     → DELETE nutrition_logs
 * - set_daily_macro_goals      → UPSERT nutrition_goals
 * - get_daily_macro_goals      → SELECT nutrition_goals (read-only helper)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { getUserTimezone, localTodayInTimezone } from "../services/userTimezone";
import { parseNutritionStringTool } from "../agents/tools";
import {
    getCachedLookup,
    normalizeQueryKey,
    setCachedLookup,
    type LookupResult,
} from "../services/nutritionLookup";

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

function clampMacro(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.round(value));
}

type ParsedMacros = {
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
    vitamin_a_mcg?: number;
    vitamin_c_mg?: number;
    calcium_mg?: number;
    iron_mg?: number;
    confidence?: "high" | "medium" | "low";
};

async function parseMacros(rawText: string): Promise<ParsedMacros> {
    const queryKey = normalizeQueryKey(rawText);
    const cached = queryKey ? await getCachedLookup(queryKey) : null;
    if (cached) return cached as ParsedMacros;

    const parsed = (await parseNutritionStringTool.invoke({
        raw_text: rawText,
    })) as ParsedMacros;

    if ((parsed.confidence ?? "high") === "high" && queryKey) {
        await setCachedLookup(queryKey, rawText, {
            source: "llm",
            ...parsed,
        } as LookupResult);
    }
    return parsed;
}

// ============================================================================
// log_nutrition_entry
// ============================================================================

export const logNutritionEntryTool = new DynamicStructuredTool({
    name: "log_nutrition_entry",
    description:
        "Record a meal the user just ate. Parses the natural-language description into calories/macros and inserts a row in `nutrition_logs` so it appears in their daily totals. Use whenever the user reports eating something they want tracked (e.g. 'log a chicken salad', 'I had 2 eggs and toast'). Do NOT use for hypothetical or future foods.",
    schema: z
        .object({
            user_id: z.string(),
            raw_text: z
                .string()
                .min(1)
                .max(400)
                .describe(
                    "Free-text description of the meal exactly as the user said it (preserve quantities, brand, prep)."
                ),
            date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .describe(
                    "ISO date (YYYY-MM-DD) for the log; defaults to today in the user's local timezone."
                ),
        })
        .strict(),
    func: async ({ user_id, raw_text, date }) => {
        try {
            // Default to the user's LOCAL today (not UTC) so a meal logged in
            // the evening in the Americas lands on the right day.
            const normalizedDate =
                date ?? localTodayInTimezone(await getUserTimezone(user_id));

            const parsed = await parseMacros(raw_text);

            const payload: Record<string, unknown> = {
                user_id,
                date: normalizedDate,
                raw_text,
                calories: clampMacro(parsed.calories),
                protein: clampMacro(parsed.protein),
                carbs: clampMacro(parsed.carbs),
                fats: clampMacro(parsed.fats),
            };
            if (parsed.vitamin_a_mcg != null) payload.vitamin_a_mcg = clampMacro(parsed.vitamin_a_mcg);
            if (parsed.vitamin_c_mg != null) payload.vitamin_c_mg = clampMacro(parsed.vitamin_c_mg);
            if (parsed.calcium_mg != null) payload.calcium_mg = clampMacro(parsed.calcium_mg);
            if (parsed.iron_mg != null) payload.iron_mg = clampMacro(parsed.iron_mg);

            const { data, error } = await supabase
                .from("nutrition_logs")
                .insert(payload)
                .select("*")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to insert nutrition log"),
                };
            }

            return {
                success: true,
                log: data,
                confidence: parsed.confidence ?? "high",
                message: `Logged ${payload.calories} kcal · ${payload.protein}P / ${payload.carbs}C / ${payload.fats}F.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "log_nutrition_entry threw"),
            };
        }
    },
});

// ============================================================================
// edit_nutrition_entry
// ============================================================================

export const editNutritionEntryTool = new DynamicStructuredTool({
    name: "edit_nutrition_entry",
    description:
        "Update an existing nutrition log when the user says they mis-logged something. Pass the log id (from `nutrition_logs`) and the corrected description. Macros are re-parsed from the new text. Verifies the row belongs to the calling user.",
    schema: z
        .object({
            user_id: z.string(),
            log_id: z.string().describe("nutrition_logs.id of the entry to edit"),
            raw_text: z
                .string()
                .min(1)
                .max(400)
                .describe("Corrected natural-language description"),
        })
        .strict(),
    func: async ({ user_id, log_id, raw_text }) => {
        try {
            const { data: existing, error: fetchErr } = await supabase
                .from("nutrition_logs")
                .select("id, user_id")
                .eq("id", log_id)
                .eq("user_id", user_id)
                .single();
            if (fetchErr || !existing) {
                return {
                    success: false,
                    error: "Nutrition log not found or not owned by user",
                };
            }

            const parsed = await parseMacros(raw_text);

            const update: Record<string, unknown> = {
                raw_text,
                calories: clampMacro(parsed.calories),
                protein: clampMacro(parsed.protein),
                carbs: clampMacro(parsed.carbs),
                fats: clampMacro(parsed.fats),
                vitamin_a_mcg: parsed.vitamin_a_mcg != null ? clampMacro(parsed.vitamin_a_mcg) : null,
                vitamin_c_mg: parsed.vitamin_c_mg != null ? clampMacro(parsed.vitamin_c_mg) : null,
                calcium_mg: parsed.calcium_mg != null ? clampMacro(parsed.calcium_mg) : null,
                iron_mg: parsed.iron_mg != null ? clampMacro(parsed.iron_mg) : null,
            };

            const { data, error } = await supabase
                .from("nutrition_logs")
                .update(update)
                .eq("id", log_id)
                .select("*")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to update nutrition log"),
                };
            }

            return {
                success: true,
                log: data,
                confidence: parsed.confidence ?? "high",
                message: `Updated log → ${update.calories} kcal · ${update.protein}P / ${update.carbs}C / ${update.fats}F.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "edit_nutrition_entry threw"),
            };
        }
    },
});

// ============================================================================
// delete_nutrition_entry
// ============================================================================

export const deleteNutritionEntryTool = new DynamicStructuredTool({
    name: "delete_nutrition_entry",
    description:
        "Remove a nutrition log when the user wants it undone ('actually I didn't eat that', 'delete the last entry'). Verifies ownership before deleting.",
    schema: z
        .object({
            user_id: z.string(),
            log_id: z.string().describe("nutrition_logs.id of the entry to delete"),
        })
        .strict(),
    func: async ({ user_id, log_id }) => {
        try {
            const { error, count } = await supabase
                .from("nutrition_logs")
                .delete({ count: "exact" })
                .eq("id", log_id)
                .eq("user_id", user_id);

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to delete nutrition log"),
                };
            }
            if (!count) {
                return {
                    success: false,
                    error: "No matching log found (already deleted or not owned by user)",
                };
            }
            return { success: true, message: "Nutrition log deleted." };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "delete_nutrition_entry threw"),
            };
        }
    },
});

// ============================================================================
// set_daily_macro_goals
// ============================================================================

export const setDailyMacroGoalsTool = new DynamicStructuredTool({
    name: "set_daily_macro_goals",
    description:
        "Set or update the user's daily nutrition targets (calories, protein, carbs, fats). Upserts a single row per user in `nutrition_goals`. Use when the user asks to change their cut/bulk targets ('set my protein goal to 180g', 'bump my calories to 2800'). Always pass all four values — partial updates would leave stale numbers on the other macros.",
    schema: z
        .object({
            user_id: z.string(),
            calories: z.number().int().min(0).max(20000),
            protein: z.number().int().min(0).max(2000),
            carbs: z.number().int().min(0).max(2000),
            fats: z.number().int().min(0).max(1000),
        })
        .strict(),
    func: async ({ user_id, calories, protein, carbs, fats }) => {
        try {
            const { data, error } = await supabase
                .from("nutrition_goals")
                .upsert(
                    {
                        user_id,
                        calories,
                        protein,
                        carbs,
                        fats,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: "user_id" }
                )
                .select("*")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to upsert nutrition goals"),
                };
            }

            return {
                success: true,
                goals: data,
                message: `Daily targets set to ${calories} kcal · ${protein}P / ${carbs}C / ${fats}F.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "set_daily_macro_goals threw"),
            };
        }
    },
});

// ============================================================================
// get_daily_macro_goals
// ============================================================================

export const getDailyMacroGoalsTool = new DynamicStructuredTool({
    name: "get_daily_macro_goals",
    description:
        "Read the user's current daily macro targets. Returns null fields if no row has been set yet (frontend default = 2200/160/240/70). Read-only.",
    schema: z.object({ user_id: z.string() }).strict(),
    func: async ({ user_id }) => {
        try {
            const { data, error } = await supabase
                .from("nutrition_goals")
                .select("calories, protein, carbs, fats, updated_at")
                .eq("user_id", user_id)
                .maybeSingle();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to read nutrition goals"),
                };
            }
            return {
                success: true,
                goals: data ?? null,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "get_daily_macro_goals threw"),
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const nutritionActionTools = [
    logNutritionEntryTool,
    editNutritionEntryTool,
    deleteNutritionEntryTool,
    setDailyMacroGoalsTool,
    getDailyMacroGoalsTool,
];
