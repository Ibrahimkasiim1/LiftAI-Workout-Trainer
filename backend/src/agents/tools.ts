// @ts-nocheck
/**
 * LangChain Tools for Workout Operations
 * 
 * FIXES:
 * 1. Fixed schema column names (effective_from/effective_until vs start_date/end_date)
 * 2. Added modify_plan_permanently tool for permanent changes
 * 3. Improved override application logic
 * 4. Removed create_workout_plan from chat tools (onboarding only)
 * 
 * NOTE: Type checking disabled due to LangChain's complex nested types
 */

import { tool } from "@langchain/core/tools";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { supabase } from "../services/db";
import { filterByAvailableEquipment } from "../services/equipmentAvailability";
import { filterExercisesByInjury } from "../services/injuryFiltering";
import { getUserTimezone } from "../services/userTimezone";
import { estimateWorkoutDurationMinutes } from "../services/workoutDuration";
import { resolveExercisesForOneOffWorkout } from "../tools/oneOffWorkoutSearch";
import { aggregateExercisePerformanceRows } from "../tools/performanceAggregation";
import { consumePlanModification } from "../tools/planModificationGate";
import { searchExercises, serializeSearchResultsForLlm } from "../tools/supabaseExerciseSearch";
import { prescriptionForGoal } from "../tools/workoutPrescription";
import { getAgentModel } from "./modelFactory";

// New modular DynamicStructuredTool registries (Comprehensive Tool Registry).
// These wrap stricter schemas + table-targeted Supabase logic and supersede
// the legacy `tool()` exports above for the multi-agent supervisor stack.
import {
    approveAndPublishPlanTool,
    generateDraftPlanTool,
    modifyDraftPlanTool,
} from "../tools/plannerActions";
import {
    shiftWorkoutScheduleTool,
    swapPermanentExerciseTool,
    swapSessionExerciseTool,
} from "../tools/editorActions";
import {
    calculateVolumeTrendActionTool,
    getPerformanceHistoryActionTool,
} from "../tools/analystActions";
import { fetchUserContextTool, saveCoreMemoryTool } from "../tools/memoryActions";
import { getTodaysWorkoutTool } from "../tools/planReadActions";
import { logExerciseSetTool, updateUserProfileTool } from "../tools/profileAndLogging";
import { recordPlanChangeNote } from "../services/proactiveCheckins";
import { findSimilarExercisesTool } from "../tools/findSimilarExercises";
import { findSimilarExercises } from "../services/embeddings";
import {
    deleteNutritionEntryTool,
    editNutritionEntryTool,
    getDailyMacroGoalsTool,
    logNutritionEntryTool,
    setDailyMacroGoalsTool,
} from "../tools/nutritionActions";
import {
    getBodyWeightHistoryTool,
    logBodyWeightTool,
} from "../tools/bodyWeightActions";
import {
    deleteSavedWorkoutTool,
    listSavedWorkoutsTool,
    saveWorkoutToLibraryTool,
} from "../tools/savedWorkoutActions";

/**
 * Strict: an empty `{}` from the LLM must throw, not silently coerce to all-zero
 * macros. The route catches the throw and falls back to the heuristic estimator.
 * Vitamins remain optional because foods legitimately lack them.
 *
 * `confidence` + `clarification` drive the follow-up pill UX: when the log is
 * ambiguous (cooking method, brand, serving size, common add-ons), the LLM
 * returns up to 3 single-tap options with a macro delta. The frontend applies
 * the delta via PATCH /nutrition/log/:id without burning another LLM call.
 */
const nutritionClarificationOptionSchema = z.object({
    label: z.string().min(1).max(40).describe("Short pill text, e.g. 'Pan-fried'"),
    delta: z.object({
        calories: z.coerce.number().int(),
        protein: z.coerce.number().int(),
        carbs: z.coerce.number().int(),
        fats: z.coerce.number().int(),
    }).describe("Macro change to ADD to the base estimate when the user picks this option. Zero deltas mean the base estimate already matches this choice."),
});

const nutritionMacroSchema = z.object({
    calories: z.coerce.number().int().nonnegative(),
    protein: z.coerce.number().int().nonnegative(),
    carbs: z.coerce.number().int().nonnegative(),
    fats: z.coerce.number().int().nonnegative(),
    vitamin_a_mcg: z.coerce.number().int().nonnegative().nullable().optional(),
    vitamin_c_mg: z.coerce.number().int().nonnegative().nullable().optional(),
    calcium_mg: z.coerce.number().int().nonnegative().nullable().optional(),
    iron_mg: z.coerce.number().int().nonnegative().nullable().optional(),
    confidence: z.enum(["high", "medium", "low"]).default("high"),
    clarification: z
        .object({
            question: z.string().min(1).max(80),
            options: z.array(nutritionClarificationOptionSchema).min(2).max(3),
        })
        .nullable()
        .optional(),
});

// Nutrition parsing model is resolved through the factory so it picks up the
// `NUTRITION_MODEL` env override (defaults to Haiku 4.5). Cost flows through
// the model_pricing table; just ensure pricing rows exist for whatever model
// you select (see migration 018).
const getNutritionParserLLM = () => getAgentModel("nutrition");

// ============================================================================
// SHARED SAFETY / PRESCRIPTION PROFILE
// ============================================================================

interface SafetyProfile {
    goal: string | null;
    fitness_level: string | null;
    injuries: string | null;
    available_equipment: string[] | null;
}

/**
 * The deterministic safety + prescription context every exercise-mutating tool
 * needs: goal/fitness level (set/rep/rest prescription) and injuries/equipment
 * (hard server-side filters). Never trust the LLM to pass these — a model that
 * forgets `avoidBodyParts` must not be able to put a contraindicated movement
 * into the user's plan. Best-effort: returns nulls on failure so tools degrade
 * to their previous behavior instead of erroring.
 */
async function getSafetyProfile(userId: string): Promise<SafetyProfile> {
    try {
        const { data } = await supabase
            .from("user_profiles")
            .select("goal, fitness_level, injuries, available_equipment")
            .eq("id", userId)
            .maybeSingle();
        return {
            goal: (data as any)?.goal ?? null,
            fitness_level: (data as any)?.fitness_level ?? null,
            injuries: typeof (data as any)?.injuries === "string" ? (data as any).injuries : null,
            available_equipment: Array.isArray((data as any)?.available_equipment)
                ? (data as any).available_equipment
                : null,
        };
    } catch {
        return { goal: null, fitness_level: null, injuries: null, available_equipment: null };
    }
}

/**
 * Server-side selection safety: drop exercises the user's injuries
 * contraindicate or that need gear they don't own. Returns what survived plus
 * the names that were blocked so the caller can be honest about skips.
 */
function enforceSelectionSafety<T extends { name: string; equipment?: string | null; equipment_canonical?: string | null }>(
    exercises: T[],
    profile: SafetyProfile
): { kept: T[]; blockedNames: string[] } {
    const afterEquipment = filterByAvailableEquipment(exercises, profile.available_equipment);
    const kept = filterExercisesByInjury(afterEquipment, profile.injuries);
    const keptIds = new Set(kept.map((e) => e.name));
    const blockedNames = exercises.filter((e) => !keptIds.has(e.name)).map((e) => e.name);
    return { kept, blockedNames };
}

// ============================================================================
// SHARED EXERCISE SEARCH TOOL
// ============================================================================

export const searchExercisesTool = tool(
    async ({ query, muscleGroup, equipment, count, avoidBodyParts, userId }) => {
        console.log(`Searching exercises: "${query}" | equipment: ${equipment?.join(", ") || "any"}`);

        const searchQuery = muscleGroup ? `${muscleGroup} ${query}` : query;

        const searchResult = await searchExercises({
            query: searchQuery,
            matchCount: count + 5,
            filterEquipment: equipment && equipment.length > 0 ? equipment : undefined,
        });

        if (!searchResult.success) {
            console.warn(`search_exercises failed`);
            return {
                success: false,
                exercises: [],
                error: searchResult.error || "No exercises found matching criteria",
            };
        }

        let validExercises = searchResult.exercises.filter((ex) => Boolean(ex.id));

        // Accessory pass on top of the bucket-level search filter: a result
        // can match "dumbbell" yet still need a bench or a bar the user never
        // listed. Same module used by onboarding plan generation.
        if (equipment && equipment.length > 0) {
            validExercises = filterByAvailableEquipment(validExercises, equipment);
        }

        // Filter out injured body parts
        if (avoidBodyParts && avoidBodyParts.length > 0) {
            validExercises = validExercises.filter(ex => {
                const targets = [
                    ex.body_part?.toLowerCase(),
                    ex.target_muscle?.toLowerCase()
                ].filter(Boolean);

                const avoidsInjury = !avoidBodyParts.some(injury =>
                    targets.some(target => target?.includes(injury.toLowerCase()))
                );

                if (!avoidsInjury) {
                    console.log(`Filtered: ${ex.name} (targets ${ex.body_part})`);
                }

                return avoidsInjury;
            });
        }

        // Deterministic injury safety on top of the model-passed avoidBodyParts:
        // the execution layer injects userId, so search results never include a
        // movement the user's STORED injuries contraindicate — even when the
        // model forgot to pass avoidBodyParts.
        if (userId) {
            const profile = await getSafetyProfile(userId);
            validExercises = filterExercisesByInjury(validExercises, profile.injuries);
        }

        const mappedResults = validExercises.slice(0, count);
        const serialized = serializeSearchResultsForLlm(mappedResults);
        const parsed = JSON.parse(serialized) as unknown[];

        console.log(`Returning ${parsed.length}/${count} valid exercises`);
        return JSON.stringify(parsed, null, 2);
    },
    {
        name: "search_exercises",
        description: "Search for exercises using vector search. Use this to FIND exercises for replacements, recommendations, or discussion. This does NOT create workouts - it only returns exercise data. For creating workouts, use create_one_off_workout instead. ALWAYS use this tool to find exercises - never invent exercise names.",
        schema: z.object({
            query: z.string().describe("Search query (e.g., 'chest pressing movements', 'leg exercises')"),
            muscleGroup: z.string().optional().describe("Specific muscle group (chest, legs, back, shoulders, etc.)"),
            equipment: z.array(z.string()).optional().describe("Available equipment filter"),
            count: z.number().default(6).describe("Number of exercises to return"),
            avoidBodyParts: z.array(z.string()).optional().describe("Body parts to avoid (injuries)"),
            // Injected server-side by the execution layer (toolExecutionNode) so
            // stored-injury filtering never depends on the model passing it.
            userId: z.string().optional().describe("User ID (auto-injected; models may omit)"),
        }),
    }
);

// ============================================================================
// NUTRITION PARSING TOOL
// ============================================================================

export const parseNutritionStringTool = tool(
    async ({ raw_text }) => {
        // Shared parse cache (nutrition_cache): the HTTP route and
        // log_nutrition_entry check it before calling this tool, but the
        // analyst can also invoke parse_nutrition_string directly — without
        // this check, that path paid an LLM call for every repeat of
        // "2 eggs" / "coffee with milk". Cache rows are high-confidence only,
        // so a hit needs no clarification.
        const { getCachedLookup, normalizeQueryKey, setCachedLookup } = await import(
            "../services/nutritionLookup"
        );
        const queryKey = normalizeQueryKey(raw_text ?? "");
        if (queryKey) {
            const cached = await getCachedLookup(queryKey);
            if (cached) {
                console.log(`parse_nutrition_string cache hit: "${queryKey}"`);
                return {
                    calories: cached.calories,
                    protein: cached.protein,
                    carbs: cached.carbs,
                    fats: cached.fats,
                    vitamin_a_mcg: cached.vitamin_a_mcg ?? undefined,
                    vitamin_c_mg: cached.vitamin_c_mg ?? undefined,
                    calcium_mg: cached.calcium_mg ?? undefined,
                    iron_mg: cached.iron_mg ?? undefined,
                    confidence: "high",
                    clarification: null,
                };
            }
        }

        const structured = getNutritionParserLLM().withStructuredOutput(nutritionMacroSchema, {
            strict: false,
        });

        const parsed = await structured.invoke([
            new SystemMessage(
                [
                    "You are a nutrition expert. Estimate calories and macros for the described food using USDA standard database values. All macro values must be non-negative integers; vitamins are optional.",
                    "",
                    "Your goal is to be ACCURATE, not assumption-heavy. Most short food entries are ambiguous and a wrong default can be off by 200+ kcal. Default to asking for clarification — only skip it when the input is genuinely unambiguous.",
                    "",
                    "Set `confidence`:",
                    "  - 'high' ONLY when the input fully specifies BOTH quantity AND key variables (preparation, brand, additions). Examples that qualify: '1 medium banana', 'one slice plain white bread', '12 oz Coca-Cola can', '100g grilled chicken breast no oil'.",
                    "  - 'medium' when one variable is missing but the realistic range across choices is < ~15% calories.",
                    "  - 'low' when ANY of the following are true: (a) no quantity given, (b) cooking method missing for a food where it matters (eggs, meat, vegetables, fish), (c) brand/type missing for a packaged food (cereal, protein bar, yogurt, bread, milk), (d) common add-ons unspecified (milk with cereal/coffee/oats, oil/butter with cooked food, dressing with salad), (e) serving size ambiguous (bowl, plate, cup, slice — without a size).",
                    "",
                    "RULE OF THUMB: if the input is 1–3 words and not a precisely-measured item, confidence is almost always 'low' or 'medium' — return a clarification.",
                    "",
                    "When confidence is NOT 'high', return a `clarification` block with a single short question and 2–3 pill options. Each option's `delta` is the macro change to ADD to your base estimate when the user taps it; use 0s for the option that matches the default you already assumed. Pick the MOST IMPACTFUL ambiguity to clarify — the one that changes the macros the most. Examples:",
                    "  - 'cereal' → 'What kind & how much?' [Small bowl Cheerios w/ skim milk (0/0/0/0), Medium bowl Frosted Flakes w/ 2% milk (+120/+2/+22/+3), Granola bowl w/ whole milk (+200/+5/+30/+8)]",
                    "  - 'sandwich' → 'What kind?' [Turkey & cheese on white (0/0/0/0), PB&J (+60/-8/+18/+8), Grilled cheese (+120/+4/+4/+12)]",
                    "  - '2 eggs' → 'How were they cooked?' [Boiled/poached (0/0/0/0), Pan-fried in oil (+90/0/0/+10), Scrambled w/ butter (+70/+1/0/+8)]",
                    "  - 'protein bar' → 'Which brand?' [Quest (0/0/0/0), RXBAR (+10/-5/+8/0), Clif Bar (+50/-10/+15/+3)]",
                    "  - 'coffee' → 'How is it made?' [Black (0/0/0/0), With milk & sugar (+50/+2/+8/+2), Latte / cappuccino (+120/+8/+15/+5)]",
                    "  - 'salad' → 'With what?' [Plain greens (0/0/0/0), Greens + chicken + light dressing (+250/+25/+5/+12), Caesar w/ croutons & dressing (+350/+12/+15/+25)]",
                    "  - 'pasta' → 'Sauce & portion?' [Small bowl marinara (0/0/0/0), Medium bowl meat sauce (+180/+12/+15/+8), Large bowl alfredo (+400/+10/+20/+30)]",
                    "",
                    "Set the BASE estimate to the LEFTMOST option (the lowest-calorie reasonable guess) so adding a delta is always non-negative cognitively. Never invent option labels that aren't realistic.",
                ].join("\n")
            ),
            new HumanMessage(raw_text),
        ]);

        // Persist confident parses so the next identical log (any caller) is
        // free. Low/medium-confidence rows are never cached — that would
        // permanently suppress the clarification UI for that text.
        if ((parsed.confidence ?? "high") === "high" && queryKey) {
            await setCachedLookup(queryKey, raw_text, {
                source: "llm",
                calories: parsed.calories,
                protein: parsed.protein,
                carbs: parsed.carbs,
                fats: parsed.fats,
                vitamin_a_mcg: parsed.vitamin_a_mcg ?? undefined,
                vitamin_c_mg: parsed.vitamin_c_mg ?? undefined,
                calcium_mg: parsed.calcium_mg ?? undefined,
                iron_mg: parsed.iron_mg ?? undefined,
            });
        }

        return {
            calories: parsed.calories,
            protein: parsed.protein,
            carbs: parsed.carbs,
            fats: parsed.fats,
            vitamin_a_mcg: parsed.vitamin_a_mcg ?? undefined,
            vitamin_c_mg: parsed.vitamin_c_mg ?? undefined,
            calcium_mg: parsed.calcium_mg ?? undefined,
            iron_mg: parsed.iron_mg ?? undefined,
            confidence: parsed.confidence ?? "high",
            clarification: parsed.clarification ?? null,
        };
    },
    {
        name: "parse_nutrition_string",
        description:
            "Parse a natural-language food log string into estimated calories, protein, carbs, and fats. Returns strict JSON with numeric macro values only.",
        schema: z.object({
            raw_text: z.string().min(1).describe("Natural-language food description to parse into macros"),
        }),
    }
);


// ============================================================================
// ADD TO TODAY'S WORKOUT TOOL
// ============================================================================

const CANONICAL_DAYS = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
] as const;

function normalizeDayToken(s: string): string {
    return String(s || "")
        .trim()
        .toLowerCase();
}

function resolveCalendarDayOfWeek(args: {
    targetDay?: string;
    todayDow: string;
}): string {
    const raw = args.targetDay?.trim();
    if (!raw || /^today$/i.test(raw)) {
        return normalizeDayToken(args.todayDow);
    }
    const t = normalizeDayToken(raw);
    if (CANONICAL_DAYS.includes(t as (typeof CANONICAL_DAYS)[number])) {
        return t;
    }
    return normalizeDayToken(args.todayDow);
}

function findRowByCalendarDay(rows: any[], calendarDow: string): any | undefined {
    const c = normalizeDayToken(calendarDow);
    return (rows as any[]).find(
        (day: any) => normalizeDayToken(day?.day_of_week) === c
    );
}

function dedupeByExerciseId(exList: any[]): any[] {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const ex of exList) {
        const id = String(ex?.id || "").trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(ex);
    }
    return out;
}

async function upsertMainPlanActiveSession(
    userId: string,
    splitLabel: string,
    exercises_structured: any[]
): Promise<void> {
    if (!exercises_structured || exercises_structured.length === 0) return;
    const exercises = exercises_structured.map((e: any) => String(e.name || "").trim()).filter(Boolean);
    const firstSets = Number(exercises_structured[0]?.sets) || 3;
    const est = estimateWorkoutDurationMinutes(exercises_structured);
    const { error } = await supabase.from("active_workout_sessions").upsert(
        {
            user_id: userId,
            workout_id: null,
            workout_type: "main_plan",
            workout_name: splitLabel,
            exercises,
            exercises_structured: exercises_structured,
            estimated_time: est,
            difficulty: "intermediate",
            current_exercise_index: 0,
            current_set: 1,
            total_sets: firstSets,
            sets_completed: [],
            is_resting: false,
            rest_time_remaining: null,
            rest_time_duration: null,
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        } as any,
        { onConflict: "user_id,workout_type" }
    );
    if (error) {
        console.warn("add_to_todays_workout: active_workout_sessions upsert failed (non-fatal):", error.message);
    }
}

export const addToTodaysWorkoutTool = tool(
    async ({ userId, exercises, targetDay }) => {
        const requestedExerciseIds: string[] = Array.isArray(exercises)
            ? exercises
                  .map((e: { exercise_id?: string }) => String(e?.exercise_id || "").trim())
                  .filter(Boolean)
            : [];
        if (requestedExerciseIds.length === 0) {
            return {
                success: false,
                error: "At least one exercise_id is required.",
            };
        }

        // "Today" in the USER's timezone — the server clock (UTC) is up to a
        // day ahead for evening users in the Americas, which silently added
        // exercises to tomorrow's workout. Profile fetch (prescription +
        // injury/equipment safety) runs in parallel — it's the same trip.
        let todayDow: string = CANONICAL_DAYS[new Date().getDay()];
        const [tzResult, profile] = await Promise.all([
            getUserTimezone(userId).catch(() => null),
            getSafetyProfile(userId),
        ]);
        if (tzResult) {
            try {
                todayDow = new Intl.DateTimeFormat("en-US", { timeZone: tzResult, weekday: "long" })
                    .format(new Date())
                    .toLowerCase();
            } catch { /* fall back to server day */ }
        }
        const calendarDow = resolveCalendarDayOfWeek({ targetDay, todayDow });

        console.log(
            `add_to_todays_workout user=${userId} calendar=${calendarDow} n=${requestedExerciseIds.length}`
        );

        const uniqueRequestedIds = Array.from(new Set(requestedExerciseIds));
        const { data: exerciseRows, error: exerciseLookupError } = await supabase
            .from("exercises")
            .select("id, name, target_muscle, body_part, equipment, equipment_canonical, difficulty, gif_path, instructions")
            .in("id", uniqueRequestedIds);

        if (exerciseLookupError) {
            return {
                success: false,
                error: `Failed to validate exercise ids: ${exerciseLookupError.message}`,
            };
        }

        const foundIds = new Set((exerciseRows || []).map((row) => String(row.id)));
        const missingIds = uniqueRequestedIds.filter((id) => !foundIds.has(id));
        if (missingIds.length > 0) {
            throw new Error(`Invalid exercise_id provided: ${missingIds.join(", ")}`);
        }

        // Deterministic safety gate: even if the model picked an exercise that
        // conflicts with the user's stored injuries or missing gear, it must
        // not land in the plan. Goal-aware prescription replaces the old flat
        // 3 × 8-12 @ 90s defaults.
        const rx = prescriptionForGoal(profile.goal, profile.fitness_level);
        const { kept: safeRows, blockedNames } = enforceSelectionSafety(
            (exerciseRows || []) as { name: string; equipment?: string | null; equipment_canonical?: string | null }[],
            profile
        );
        if (safeRows.length === 0) {
            return {
                success: false,
                error:
                    `TOOL ERROR: none of the requested exercises are safe for this user (blocked: ${blockedNames.join(", ")}) — ` +
                    "they conflict with the user's stored injuries or unavailable equipment. DO NOT retry the same ids; " +
                    "search for alternatives that fit their constraints instead.",
            };
        }

        const validNewExercises = (safeRows as any[]).map((row) => ({
            id: row.id,
            name: row.name,
            target_muscle: row.target_muscle,
            body_part: row.body_part,
            equipment: row.equipment,
            difficulty: row.difficulty,
            gif_path: row.gif_path,
            instructions: row.instructions,
            sets: rx.sets,
            reps: rx.reps,
            rest_seconds: rx.rest_seconds,
            isTemporaryAddition: true,
        }));

        const { data: plan, error: planError } = await supabase
            .from("workout_plans")
            .select("id, daily_workouts(*)")
            .eq("user_id", userId)
            .eq("is_active", true)
            .single();

        if (planError || !plan) {
            return { success: false, error: "No active plan found" };
        }

        const dayRows: any[] = (plan as any).daily_workouts as any[] || [];
        if (dayRows.length === 0) {
            return { success: false, error: "Active plan has no daily_workouts rows" };
        }

        const row = findRowByCalendarDay(dayRows, calendarDow);

        let baseStructured: any[] = [];
        let splitLabel = row?.split_day_name || "Workout";

        if (row) {
            const cur = row.exercises_structured || [];
            baseStructured = Array.isArray(cur) ? [...cur] : [];
        }

        const merged = dedupeByExerciseId([...baseStructured, ...validNewExercises]);
        if (merged.length === 0) {
            return { success: false, error: "No exercises to persist after merge" };
        }

        const exNames = merged.map((e: any) => e.name);
        const estTime = estimateWorkoutDurationMinutes(merged);

        if (row) {
            const { error: updateError } = await supabase
                .from("daily_workouts")
                .update({
                    split_day_name: row.split_day_name || splitLabel,
                    exercises_structured: merged,
                    exercises: exNames,
                    estimated_time: estTime,
                })
                .eq("id", row.id);

            if (updateError) {
                console.error("Failed to update daily_workouts:", updateError);
                return { success: false, error: `Failed to add exercises: ${updateError.message}` };
            }
        } else {
            const { error: insErr } = await supabase.from("daily_workouts").insert({
                plan_id: (plan as any).id,
                day_of_week: calendarDow,
                split_day_name: splitLabel,
                exercises: exNames,
                exercises_structured: merged,
                estimated_time: estTime,
            });
            if (insErr) {
                return { success: false, error: `Failed to create day row: ${insErr.message}` };
            }
        }

        await upsertMainPlanActiveSession(userId, splitLabel, merged);

        // This message doubles as the user-facing recap (deterministic-recap
        // short circuit skips the LLM restatement), so keep it coach-voiced.
        const addedNames = validNewExercises.map((e: any) => e.name);
        const dayLabel = calendarDow.charAt(0).toUpperCase() + calendarDow.slice(1);
        let message = `Added ${addedNames.join(", ")} to ${dayLabel}'s workout.`;
        if (blockedNames.length > 0) {
            message += ` I skipped ${blockedNames.join(", ")} — not a safe fit for your injuries or available equipment.`;
        }

        console.log(`${message}`);
        return {
            success: true,
            message,
            dayOfWeek: calendarDow,
            addedExerciseIds: validNewExercises.map((e: any) => e.id),
            addedExercises: validNewExercises.map((e: any) => e.name),
            workout: {
                day: calendarDow,
                focus: splitLabel,
                exercises: merged,
            },
        };
    },
    {
        name: "add_to_todays_workout",
        description:
            "Add verified exercise library ids to a plan day. This tool only accepts exact exercise identifiers and never performs search/fallback by name.",
        schema: z.object({
            userId: z.string().describe("User ID"),
            exercises: z.array(z.object({ exercise_id: z.string().describe("The exact ID of the exercise retrieved from search_exercises") })),
            targetDay: z
                .string()
                .optional()
                .describe("Calendar day to update: 'monday'…'sunday' or 'today' (default = today)"),
        }),
    }
);


// ============================================================================
// ONE-OFF WORKOUT CREATION TOOL
// ============================================================================

/** Confidence a soft avoidance must reach before the generator excludes it. */
const AVOIDANCE_INJECT_THRESHOLD = 0.5;
const AVOID_FACT_PREFIX = "prefers to avoid ";

/**
 * Exercise names the user has repeatedly swapped out, strong enough to honor.
 * Reads the soft "prefers to avoid {name}" preferences written by the swap
 * tools; only those above the confidence threshold (≈2+ swaps) and unexpired
 * are returned, so a single one-off swap is never a permanent ban.
 */
async function getAvoidedExerciseNames(userId: string): Promise<string[]> {
    if (!userId) return [];
    try {
        const { data, error } = await supabase
            .from("coach_memories")
            .select("fact, confidence, expires_at")
            .eq("user_id", userId)
            .eq("category", "preference")
            .is("archived_at", null)
            .ilike("fact", `${AVOID_FACT_PREFIX}%`)
            .gte("confidence", AVOIDANCE_INJECT_THRESHOLD);
        if (error || !data) return [];
        const now = Date.now();
        return data
            .filter((r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now)
            .map((r) => String(r.fact).slice(AVOID_FACT_PREFIX.length).trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

export const createOneOffWorkoutTool = tool(
    async ({ targetMuscle, equipment, durationMinutes, avoidBodyParts, userId }) => {
        console.log(`Creating ${durationMinutes}-minute ${targetMuscle} workout`);

        // Calculate exercise count based on duration (roughly 3-5 minutes per exercise)
        const exerciseCount = Math.max(3, Math.min(8, Math.ceil(durationMinutes / 4)));

        // Soft avoidances learned from repeated swaps ("prefers to avoid X").
        // Only inject once confidence has crossed the threshold (≈2+ swaps) so a
        // single one-off swap never becomes a permanent ban.
        // The profile fetch supplies the DETERMINISTIC safety constraints
        // (owned equipment + injuries) — the model's args only narrow, never
        // widen, what the user can be given.
        const [avoidExerciseNames, profileConstraints] = await Promise.all([
            getAvoidedExerciseNames(userId),
            supabase
                .from("user_profiles")
                .select("available_equipment, injuries, goal, fitness_level")
                .eq("id", userId)
                .maybeSingle()
                .then(({ data }) => data as {
                    available_equipment?: string[] | null;
                    injuries?: string | null;
                    goal?: string | null;
                    fitness_level?: string | null;
                } | null)
                .catch(() => null),
        ]);

        const resolved = await resolveExercisesForOneOffWorkout({
            targetMuscle,
            equipment,
            exerciseCount,
            avoidBodyParts,
            avoidExerciseNames,
            availableEquipment: profileConstraints?.available_equipment ?? null,
            injuries: profileConstraints?.injuries ?? null,
            // Recent-fatigue avoidance: skip exercises this user finished in
            // the last 3 days unless the library is too thin to fill the slot.
            userId,
        });

        if (!resolved.ok) {
            return {
                success: false,
                error: "no_exercises_in_library",
            };
        }

        const selectedExercises = resolved.exercises;
        let note = `Generated ${durationMinutes}-minute workout`;
        if (resolved.usedEquipmentFallback) {
            note += ". Some movements use the closest matches in our library when strict equipment matches were limited.";
        }
        if (resolved.warning) {
            note += ` ${resolved.warning}`;
        }

        // Format as workout object. Prescription is goal-aware (strength →
        // 4×4-6@180s, fat loss → 3×12-15@60s, …) instead of a flat 3×8-12.
        const rx = prescriptionForGoal(profileConstraints?.goal, profileConstraints?.fitness_level);
        const workout = {
            id: `workout-${Date.now()}`,
            focus: `${resolved.focusLabel} Workout`,
            exercises: selectedExercises.map(ex => ({
                ...ex,
                sets: rx.sets,
                reps: rx.reps,
                rest_seconds: rx.rest_seconds,
            })),
            estimatedTime: durationMinutes,
            difficulty: "intermediate",
            note,
            // Must match saved_workouts_workout_type_check (extra_workout works on all DB versions)
            workoutType: "extra_workout",
            createdFor: userId,
        };

        console.log(`Created workout with ${selectedExercises.length} exercises`);
        return {
            success: true,
            workout,
            exerciseCount: selectedExercises.length,
            warning: resolved.warning,
            missingSlots: resolved.missingSlots,
        };
    },
    {
        name: "create_one_off_workout",
        description:
            "Build ONE session the user will perform in the app's interactive workout card/modal—not in chat text. Use whenever they want a workout to do now (chest day, quick legs, hotel session, etc.). Do not satisfy workout requests with prose lists; call this tool. Before calling, verify the request is feasible with the user's equipment context; if not feasible (e.g., barbell bench request but only bands available), ask one clarifying question first.",
        schema: z.object({
            userId: z.string().describe("User ID"),
            targetMuscle: z.string().describe("Target muscle group or workout focus (e.g., 'chest', 'legs', 'full body', 'arms')"),
            equipment: z.array(z.string()).optional().describe("Available equipment (use 'body weight' for bodyweight exercises)"),
            durationMinutes: z.number().min(10).max(120).default(30).describe("Target workout duration in minutes (10-120)"),
            avoidBodyParts: z.array(z.string()).optional().describe("Body parts to avoid due to injury"),
        }),
    }
);

// ============================================================================
// EXTEND ONE-OFF WORKOUT TOOL
// ============================================================================

/** How far back a chat-built workout can be and still count as "the one you just made". */
const EXTENDABLE_WORKOUT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const extendOneOffWorkoutTool = tool(
    async ({ userId, exercises }) => {
        const requestedExerciseIds: string[] = Array.isArray(exercises)
            ? exercises
                  .map((e: { exercise_id?: string }) => String(e?.exercise_id || "").trim())
                  .filter(Boolean)
            : [];
        if (requestedExerciseIds.length === 0) {
            return { success: false, error: "At least one exercise_id is required." };
        }

        const { data: rows, error: fetchError } = await supabase
            .from("saved_workouts")
            .select("id, workout_name, workout_type, exercises_structured, estimated_time, difficulty, created_at")
            .eq("user_id", userId)
            .in("workout_type", ["extra_workout", "replacement_workout"])
            .order("created_at", { ascending: false })
            .limit(1);
        if (fetchError) {
            return { success: false, error: `Failed to look up recent workout: ${fetchError.message}` };
        }

        const row = (rows ?? [])[0];
        const freshEnough =
            row && Date.now() - new Date(row.created_at as string).getTime() < EXTENDABLE_WORKOUT_MAX_AGE_MS;
        if (!row || !freshEnough) {
            return {
                success: false,
                error:
                    "TOOL ERROR: No recent one-off workout to extend — DO NOT retry this tool. " +
                    "Build a fresh workout with create_one_off_workout instead, covering the previous focus PLUS the newly requested muscle group.",
            };
        }

        const uniqueRequestedIds = Array.from(new Set(requestedExerciseIds));
        const [{ data: exerciseRows, error: exerciseLookupError }, profile] = await Promise.all([
            supabase
                .from("exercises")
                .select("id, name, target_muscle, body_part, equipment, equipment_canonical, difficulty, gif_path, instructions")
                .in("id", uniqueRequestedIds),
            getSafetyProfile(userId),
        ]);
        if (exerciseLookupError) {
            return {
                success: false,
                error: `Failed to validate exercise ids: ${exerciseLookupError.message}`,
            };
        }
        const foundIds = new Set((exerciseRows || []).map((r) => String(r.id)));
        const missingIds = uniqueRequestedIds.filter((id) => !foundIds.has(id));
        if (missingIds.length > 0) {
            throw new Error(`Invalid exercise_id provided: ${missingIds.join(", ")}`);
        }

        // Same deterministic safety gate + goal-aware prescription as
        // add_to_todays_workout — id validation alone let injury-conflicting
        // or gear-they-don't-own exercises into the card.
        const { kept: safeRows, blockedNames } = enforceSelectionSafety(
            (exerciseRows || []) as { name: string; equipment?: string | null; equipment_canonical?: string | null }[],
            profile
        );
        if (safeRows.length === 0) {
            return {
                success: false,
                error:
                    `TOOL ERROR: none of the requested exercises are safe for this user (blocked: ${blockedNames.join(", ")}) — ` +
                    "they conflict with the user's stored injuries or unavailable equipment. DO NOT retry the same ids; " +
                    "search for alternatives that fit their constraints instead.",
            };
        }
        const rx = prescriptionForGoal(profile.goal, profile.fitness_level);

        const validNewExercises = (safeRows as any[]).map((r) => ({
            id: r.id,
            name: r.name,
            target_muscle: r.target_muscle,
            body_part: r.body_part,
            equipment: r.equipment,
            difficulty: r.difficulty,
            gif_path: r.gif_path,
            instructions: r.instructions,
            sets: rx.sets,
            reps: rx.reps,
            rest_seconds: rx.rest_seconds,
        }));

        const existing: any[] = Array.isArray(row.exercises_structured) ? row.exercises_structured : [];
        const merged = dedupeByExerciseId([...existing, ...validNewExercises]);
        const estTime = estimateWorkoutDurationMinutes(merged);

        const { error: updateError } = await supabase
            .from("saved_workouts")
            .update({
                exercises: merged.map((e: any) => e.name),
                exercises_structured: merged,
                estimated_time: estTime,
            })
            .eq("id", row.id);
        if (updateError) {
            return { success: false, error: `Failed to extend workout: ${updateError.message}` };
        }

        let message = `Added ${validNewExercises.length} exercise(s) to "${row.workout_name}".`;
        if (blockedNames.length > 0) {
            message += ` Skipped ${blockedNames.join(", ")} — not safe for the user's injuries or unavailable with their equipment.`;
        }
        console.log(`${message}`);
        return {
            success: true,
            message,
            addedExercises: validNewExercises.map((e: any) => e.name),
            workout: {
                id: row.id,
                focus: row.workout_name,
                exercises: merged,
                estimatedTime: estTime,
                difficulty: row.difficulty || "intermediate",
                workoutType: row.workout_type,
                // Row was updated in place — the chat route must NOT insert a
                // second saved_workouts row when this workout is re-delivered.
                alreadyPersisted: true,
            },
        };
    },
    {
        name: "extend_one_off_workout",
        description:
            "Append verified exercise library ids to the user's MOST RECENT chat-built (one-off) workout and re-deliver the updated card. Use when the user asks to add something to the workout that was just built ('add calves to it'). Requires exact ids from search_exercises.",
        schema: z.object({
            userId: z.string().describe("User ID"),
            exercises: z.array(
                z.object({
                    exercise_id: z
                        .string()
                        .describe("The exact ID of the exercise retrieved from search_exercises"),
                })
            ),
        }),
    }
);

// ============================================================================
// TEMPORARY OVERRIDE TOOL (Fixed Schema)
// ============================================================================

export const createTemporaryOverrideTool = tool(
    async ({ userId, reason, durationWeeks, overrideType, modifications }) => {
        console.log(`Creating ${durationWeeks}-week override for ${userId}: ${reason}`);

        // Get current active plan
        const { data: currentPlan } = await supabase
            .from("workout_plans")
            .select("id")
            .eq("user_id", userId)
            .eq("is_active", true)
            .single();

        if (!currentPlan) {
            return {
                success: false,
                error: "No active plan to override",
            };
        }

        // Calculate dates
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + (durationWeeks * 7));

        // Insert override with CORRECT column names
        const { data: override, error } = await supabase
            .from("durational_plan_overrides")
            .insert({
                user_id: userId,
                plan_id: currentPlan.id,
                rule_type: overrideType,
                reason,
                effective_from: startDate.toISOString(),
                effective_until: endDate.toISOString(),
                rule_data: modifications,
                is_active: true,
                priority: 1,
            })
            .select()
            .single();

        if (error) {
            console.error("Failed to create override:", error);
            return {
                success: false,
                error: `Failed to create override: ${error.message}`,
            };
        }

        // Apply override to workouts
        const { replacedCount, affectedDays } = await applyOverrideToUpcomingWorkouts(
            userId,
            override.id,
            modifications
        );

        const avoidParts = modifications.avoidBodyParts?.join(", ") || "";

        let message = `I've adjusted your plan for the next ${durationWeeks} weeks to accommodate ${reason}.`;
        if (replacedCount > 0) {
            message += ` I replaced ${replacedCount} exercises across ${affectedDays.length} workout days`;
            if (avoidParts) message += ` to avoid ${avoidParts}`;
            message += ".";
        }
        message += " The changes will automatically revert after the accommodation period.";

        // "Why did my plan change?" note the user sees in the coach feed.
        recordPlanChangeNote(
            userId,
            "Plan adjusted temporarily",
            `I adjusted your plan for the next ${durationWeeks} week(s) because of ${reason}.` +
                (replacedCount > 0
                    ? ` ${replacedCount} exercise(s) across ${affectedDays.length} day(s) were replaced${avoidParts ? ` to avoid ${avoidParts}` : ""}.`
                    : "") +
                " Everything reverts automatically when the period ends.",
            { overrideType, durationWeeks, replacedCount, affectedDays }
        );

        console.log(`${message}`);
        return {
            success: true,
            overrideId: override.id,
            message,
            expiresAt: override.effective_until,
            replacementsSummary: {
                replacedCount,
                affectedDays,
            },
        };
    },
    {
        name: "create_temporary_override",
        description: "Create a temporary modification to user's plan (injuries, vacation, equipment changes). Auto-expires after duration. Use for SHORT-TERM changes (1-12 weeks typically). For permanent changes, use modify_plan_permanently instead.",
        schema: z.object({
            userId: z.string(),
            reason: z.string().describe("Why this override is needed"),
            durationWeeks: z.number().min(1).max(52).describe("Duration in weeks (1-52, though typically 1-12)"),
            overrideType: z.enum(["equipment_change", "injury_accommodation", "vacation", "intensity_reduction"]),
            modifications: z.object({
                equipmentOverride: z.array(z.string()).optional().describe("Temporary equipment available"),
                avoidBodyParts: z.array(z.string()).optional().describe("Body parts to avoid (injuries)"),
                intensityMultiplier: z.number().optional().describe("0.7 = easier, 1.0 = normal, 1.3 = harder"),
                location: z.string().optional().describe("Temporary location (hotel, home, etc.)"),
            }),
        }),
    }
);

// ============================================================================
// PERMANENT PLAN MODIFICATION TOOL
// ============================================================================

export const modifyPlanPermanentlyTool = tool(
    async ({ userId, changeType, modifications, reason }) => {
        console.log(`Permanent plan modification for ${userId}: ${changeType}`);

        // Free tier: capped at 3 permanent plan modifications. Premium unlimited.
        const gate = await consumePlanModification(userId);
        if (!gate.allowed) {
            return {
                success: false,
                error: gate.reason,
                limit: gate.limit,
                used: gate.used,
                message: gate.message,
            };
        }

        // Get current active plan
        const { data: plan, error: planError } = await supabase
            .from("workout_plans")
            .select("id, daily_workouts(*)")
            .eq("user_id", userId)
            .eq("is_active", true)
            .single();

        if (planError || !plan) {
            return {
                success: false,
                error: "No active plan found",
            };
        }

        let affectedDays: string[] = [];
        let changesMade = 0;

        // The LLM frequently omits targetDay ("swap bench everywhere") or
        // passes loose shapes — `modifications` is a free-form record, so every
        // field must be defensively normalized. An empty targetDay matches ALL
        // days (that's the correct semantic for "everywhere").
        const dayMatches = (day: any, targetDay: unknown): boolean => {
            const t = typeof targetDay === "string" ? targetDay.trim().toLowerCase() : "";
            if (!t || t === "all" || t === "every day" || t === "everywhere") return true;
            const dow = String(day?.day_of_week ?? "").toLowerCase();
            const label = String(day?.split_day_name ?? "").toLowerCase();
            return dow.includes(t) || label.includes(t);
        };

        // Handle different change types
        switch (changeType) {
            case "swap_exercise": {
                // Find and replace exercise
                const { targetDay, oldExercise, newExercise } = modifications;
                if (typeof oldExercise !== "string" || !oldExercise.trim() ||
                    typeof newExercise !== "string" || !newExercise.trim()) {
                    return {
                        success: false,
                        error:
                            "swap_exercise needs modifications.oldExercise and modifications.newExercise (exercise names). Re-call with both.",
                    };
                }

                for (const day of plan.daily_workouts as any[]) {
                    if (!dayMatches(day, targetDay)) continue;

                    const exercises = day.exercises_structured || [];
                    let modified = false;

                    // Search for exercise to replace
                    const newExercises = await Promise.all(exercises.map(async (ex: any) => {
                        if (!ex.name.toLowerCase().includes(oldExercise.toLowerCase())) {
                            return ex;
                        }

                        // Stimulus-preserving lookup. The embedding query
                        // combines what the user wants ("incline press") with
                        // what they're replacing ("alternative to bench press")
                        // so the top hit is biomechanically similar — not just
                        // a name match. Falls back to keyword search when the
                        // embedding column hasn't been backfilled or the
                        // similarity search returns nothing.
                        let candidate: any | null = null;
                        try {
                            const semantic = await findSimilarExercises({
                                text: `${newExercise} as alternative to ${oldExercise}`,
                                matchCount: 3,
                                equipment: ex.equipment ? [ex.equipment] : undefined,
                            });
                            if (semantic.length > 0) candidate = semantic[0];
                        } catch (err) {
                            console.warn(
                                "[modify_plan_permanently] semantic lookup failed, falling back to keyword:",
                                err instanceof Error ? err.message : err
                            );
                        }

                        if (!candidate) {
                            const searchResult = await searchExercises({
                                query: newExercise,
                                matchCount: 1,
                            });
                            if (searchResult.success && searchResult.exercises.length > 0) {
                                candidate = searchResult.exercises[0];
                            }
                        }

                        if (candidate) {
                            modified = true;
                            changesMade++;
                            return {
                                ...candidate,
                                sets: ex.sets,
                                reps: ex.reps,
                                rest_seconds: ex.rest_seconds,
                            };
                        }
                        return ex;
                    }));

                    if (modified) {
                        affectedDays.push(day.day_of_week);
                        await supabase
                            .from("daily_workouts")
                            .update({
                                exercises_structured: newExercises,
                                exercises: newExercises.map((e: any) => e.name),
                            })
                            .eq("id", day.id);
                    }
                }
                break;
            }

            case "add_exercises": {
                // Add exercises to specific day
                const { targetDay, exercises: exercisesToAdd } = modifications;
                if (!Array.isArray(exercisesToAdd) || exercisesToAdd.length === 0) {
                    return {
                        success: false,
                        error:
                            "add_exercises needs modifications.exercises (array of exercise names) and modifications.targetDay (day to add them to).",
                    };
                }
                if (typeof targetDay !== "string" || !targetDay.trim()) {
                    return {
                        success: false,
                        error:
                            "add_exercises needs modifications.targetDay — which day should these be added to? Ask the user if unclear.",
                    };
                }

                for (const day of plan.daily_workouts as any[]) {
                    if (!dayMatches(day, targetDay)) continue;

                    // Search for exercises to add
                    const searchResults = await Promise.all(
                        exercisesToAdd.map((ex: string) =>
                            searchExercises({ query: ex, matchCount: 1 })
                        )
                    );

                    const validNewExercises = searchResults
                        .filter(r => r.success && r.exercises.length > 0)
                        .map(r => ({
                            ...r.exercises[0],
                            sets: 3,
                            reps: "8-12",
                            rest_seconds: 90,
                        }));

                    if (validNewExercises.length > 0) {
                        const currentExercises = day.exercises_structured || [];
                        const updatedExercises = [...currentExercises, ...validNewExercises];

                        affectedDays.push(day.day_of_week);
                        changesMade += validNewExercises.length;

                        await supabase
                            .from("daily_workouts")
                            .update({
                                exercises_structured: updatedExercises,
                                exercises: updatedExercises.map((e: any) => e.name),
                            })
                            .eq("id", day.id);
                    }
                }
                break;
            }

            case "remove_exercises": {
                // Remove exercises from day
                const { targetDay, exercises: exercisesToRemove } = modifications;
                if (!Array.isArray(exercisesToRemove) || exercisesToRemove.length === 0) {
                    return {
                        success: false,
                        error:
                            "remove_exercises needs modifications.exercises (array of exercise names to remove). An empty targetDay removes from every day.",
                    };
                }

                for (const day of plan.daily_workouts as any[]) {
                    if (!dayMatches(day, targetDay)) continue;

                    const currentExercises = day.exercises_structured || [];
                    const filteredExercises = currentExercises.filter((ex: any) =>
                        !exercisesToRemove.some((name: string) =>
                            ex.name.toLowerCase().includes(name.toLowerCase())
                        )
                    );

                    if (filteredExercises.length < currentExercises.length) {
                        affectedDays.push(day.day_of_week);
                        changesMade += currentExercises.length - filteredExercises.length;

                        await supabase
                            .from("daily_workouts")
                            .update({
                                exercises_structured: filteredExercises,
                                exercises: filteredExercises.map((e: any) => e.name),
                            })
                            .eq("id", day.id);
                    }
                }
                break;
            }

            case "change_equipment": {
                // Permanently change equipment (not an override)
                const { equipment } = modifications;
                if (!Array.isArray(equipment) || equipment.length === 0) {
                    return {
                        success: false,
                        error:
                            "change_equipment needs modifications.equipment (array of canonical equipment strings, e.g. ['dumbbell','body weight']).",
                    };
                }

                await supabase
                    .from("user_profiles")
                    .update({ available_equipment: equipment })
                    .eq("id", userId);

                return {
                    success: true,
                    message: `Updated your available equipment to: ${equipment.join(", ")}. Your future workouts will use this equipment.`,
                    changesMade: 1,
                    affectedDays: ["equipment_profile"],
                };
            }
        }

        if (changesMade === 0) {
            return {
                success: false,
                error:
                    "No changes were made — the target exercise/day wasn't found in the plan. Check the exercise name against the plan context (or search first), then re-call with the exact name. DO NOT retry with identical arguments.",
            };
        }

        const message = `Successfully made ${changesMade} permanent change(s) to your plan affecting ${affectedDays.length} day(s): ${affectedDays.join(", ")}.`;

        recordPlanChangeNote(
            userId,
            "Plan updated",
            `I made ${changesMade} permanent change(s) to your plan (${changeType.replace(/_/g, " ")}) on ${affectedDays.join(", ")}${reason ? ` — ${reason}` : ""}.`,
            { changeType, changesMade, affectedDays }
        );

        console.log(`${message}`);
        return {
            success: true,
            message,
            changesMade,
            affectedDays,
        };
    },
    {
        name: "modify_plan_permanently",
        description: "Permanently modify user's workout plan structure. Use for exercise swaps, adding/removing exercises, or permanent equipment changes. These changes are PERMANENT unless manually reverted.",
        schema: z.object({
            userId: z.string(),
            changeType: z.enum(["swap_exercise", "add_exercises", "remove_exercises", "change_equipment"]).describe("Type of permanent modification"),
            modifications: z.record(z.any()).describe("Modification details specific to changeType"),
            reason: z.string().describe("Why this permanent change is being made"),
        }),
    }
);

// ============================================================================
// HELPER: Apply Override to Workouts
// ============================================================================

async function applyOverrideToUpcomingWorkouts(
    userId: string,
    overrideId: string,
    modifications: any
): Promise<{ replacedCount: number; affectedDays: string[] }> {
    console.log(`Applying override to workouts...`);

    const { data: plan, error: planError } = await supabase
        .from("workout_plans")
        .select("id, daily_workouts(*)")
        .eq("user_id", userId)
        .eq("is_active", true)
        .single();

    if (planError || !plan) {
        console.error("Error fetching plan:", planError);
        return { replacedCount: 0, affectedDays: [] };
    }

    let totalReplaced = 0;
    const affectedDays: string[] = [];
    // Pre-mutation snapshot — written back to durational_plan_overrides so the
    // expiry cron can restore the original daily_workouts rows when this
    // override's effective_until passes. Without this, the user-facing promise
    // "the changes will automatically revert" is a lie.
    const snapshot: {
        id: string;
        exercises_structured: any[];
        exercises: string[];
    }[] = [];

    for (const day of plan.daily_workouts as any[]) {
        if (!day.exercises_structured || day.exercises_structured.length === 0) {
            continue;
        }

        const updatedExercises: any[] = [];
        let dayHadChanges = false;

        for (const ex of day.exercises_structured) {
            let modifiedExercise = { ...ex };
            let wasModified = false;

            // Check conflicts with injuries or equipment
            const conflictsWithInjury = modifications.avoidBodyParts?.some(
                (part: string) => {
                    const bodyPartMatch = ex.body_part?.toLowerCase().includes(part.toLowerCase());
                    const targetMatch = ex.target_muscle?.toLowerCase().includes(part.toLowerCase());
                    return bodyPartMatch || targetMatch;
                }
            );

            const conflictsWithEquipment =
                modifications.equipmentOverride &&
                ex.equipment &&
                !modifications.equipmentOverride.includes(ex.equipment);

            // Handle injury/equipment conflicts by finding replacements
            if (conflictsWithInjury || conflictsWithEquipment) {
                const replacements = await searchExercises({
                    query: `${ex.target_muscle || ex.body_part} exercises`,
                    matchCount: 3,
                    filterEquipment: modifications.equipmentOverride,
                });

                const safeReplacement = replacements.exercises.find(r =>
                    r.id && r.gif_path &&
                    !modifications.avoidBodyParts?.some(
                        (part: string) => r.body_part?.toLowerCase().includes(part.toLowerCase())
                    )
                );

                if (safeReplacement) {
                    modifiedExercise = {
                        ...safeReplacement,
                        sets: ex.sets || 3,
                        reps: ex.reps || "8-12",
                        rest_seconds: ex.rest_seconds || 90,
                        isReplacement: true,
                        replacedExercise: ex.name,
                    };
                    totalReplaced++;
                    wasModified = true;
                    dayHadChanges = true;
                }
            }

            // Handle intensity reduction by reducing sets
            if (modifications.intensityMultiplier && modifications.intensityMultiplier < 1.0) {
                const originalSets = modifiedExercise.sets || 3;
                const reducedSets = Math.max(1, Math.round(originalSets * modifications.intensityMultiplier));

                if (reducedSets !== originalSets) {
                    modifiedExercise.sets = reducedSets;
                    modifiedExercise.intensityReduced = true;
                    modifiedExercise.originalSets = originalSets;

                    if (!wasModified) {
                        totalReplaced++;
                    }
                    wasModified = true;
                    dayHadChanges = true;
                }
            }

            // Handle intensity increase by adding sets
            if (modifications.intensityMultiplier && modifications.intensityMultiplier > 1.0) {
                const originalSets = modifiedExercise.sets || 3;
                const increasedSets = Math.round(originalSets * modifications.intensityMultiplier);

                if (increasedSets !== originalSets) {
                    modifiedExercise.sets = increasedSets;
                    modifiedExercise.intensityIncreased = true;
                    modifiedExercise.originalSets = originalSets;

                    if (!wasModified) {
                        totalReplaced++;
                    }
                    wasModified = true;
                    dayHadChanges = true;
                }
            }

            updatedExercises.push(modifiedExercise);
        }

        if (dayHadChanges) {
            affectedDays.push(day.day_of_week);
            // Capture the ORIGINAL row contents before we mutate them. The
            // revert cron reads this snapshot and writes the pre-mutation
            // arrays back when the override expires.
            snapshot.push({
                id: day.id,
                exercises_structured: day.exercises_structured,
                exercises: day.exercises_structured.map((e: any) => e.name),
            });
        }

        await supabase
            .from("daily_workouts")
            .update({
                exercises_structured: updatedExercises,
                exercises: updatedExercises.map((e: any) => e.name),
            })
            .eq("id", day.id);
    }

    if (snapshot.length > 0) {
        const { error: snapErr } = await supabase
            .from("durational_plan_overrides")
            .update({ daily_workouts_snapshot: snapshot })
            .eq("id", overrideId);
        if (snapErr) {
            console.warn(
                "Failed to persist override snapshot (revert won't work for this override):",
                snapErr.message
            );
        }
    }

    console.log(`Replaced ${totalReplaced} exercises across ${affectedDays.length} days`);
    return { replacedCount: totalReplaced, affectedDays };
}

// ============================================================================
// PROFILE MEMORY HELPERS (injuries + coach_memory JSONB)
// ============================================================================

function parseInjuriesField(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw.map((x) => String(x).trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
        try {
            const j = JSON.parse(raw);
            if (Array.isArray(j)) {
                return j.map((x) => String(x).trim()).filter(Boolean);
            }
        } catch {
            return raw
                .split(/[,;]/)
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return [];
}

function serializeInjuries(arr: string[]): string {
    return JSON.stringify(arr);
}

type CoachMemoryEntry = { text: string; recorded_at: string };

function parseCoachMemoryColumn(raw: unknown): CoachMemoryEntry[] {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return [];
    const out: CoachMemoryEntry[] = [];
    for (const x of raw) {
        if (typeof x === "string") {
            out.push({ text: x, recorded_at: new Date().toISOString() });
        } else if (x && typeof x === "object" && "text" in x) {
            const o = x as Record<string, unknown>;
            out.push({
                text: String(o.text),
                recorded_at: typeof o.recorded_at === "string" ? o.recorded_at : new Date().toISOString(),
            });
        }
    }
    return out;
}

// ============================================================================
// LONG-TERM MEMORY (Supabase profile)
// ============================================================================

export const mutateUserMemoryTool = tool(
    async ({ userId, mutations }) => {
        // Injuries live on user_profiles.injuries (load-bearing: workout
        // generation and get_active_user_context both read it). Free-form
        // coach facts live ONLY in the categorized coach_memories table —
        // the legacy user_profiles.coach_memory JSONB dual-write is retired.
        const { upsertCoachMemory, archiveCoachMemory } = await import(
            "../services/longTermMemory"
        );

        const injuryMutations = mutations.filter(
            (m: any) => m.kind === "add_injury" || m.kind === "remove_injury"
        );
        const factMutations = mutations.filter(
            (m: any) => m.kind === "add_coach_fact" || m.kind === "remove_coach_fact"
        );

        let injuries: string[] | undefined;
        if (injuryMutations.length > 0) {
            const { data: row, error: fetchErr } = await supabase
                .from("user_profiles")
                .select("injuries")
                .eq("id", userId)
                .single();

            if (fetchErr || !row) {
                return { success: false, error: fetchErr?.message || "User profile not found" };
            }

            injuries = parseInjuriesField(row.injuries);
            for (const m of injuryMutations) {
                if (m.kind === "add_injury") {
                    const label = m.label.trim();
                    if (!label) continue;
                    const low = label.toLowerCase();
                    if (!injuries.some((i) => i.toLowerCase() === low)) injuries.push(label);
                } else {
                    const low = m.label.trim().toLowerCase();
                    injuries = injuries.filter((i) => i.toLowerCase() !== low);
                }
            }

            const { error: upErr } = await supabase
                .from("user_profiles")
                .update({
                    injuries: serializeInjuries(injuries),
                    updated_at: new Date().toISOString(),
                })
                .eq("id", userId);
            if (upErr) return { success: false, error: upErr.message };
        }

        let factsSaved = 0;
        for (const m of factMutations) {
            try {
                if (m.kind === "add_coach_fact") {
                    const saved = await upsertCoachMemory(userId, {
                        category: "preference",
                        fact: m.fact,
                        confidence: 0.7,
                        source: "mutate_user_memory",
                    });
                    if (saved) factsSaved++;
                } else {
                    await archiveCoachMemory(userId, { factSubstring: m.fact });
                    factsSaved++;
                }
            } catch (err) {
                console.warn("mutate_user_memory: coach_memories write failed (non-fatal):", err);
            }
        }

        return {
            success: true,
            message: `Saved ${mutations.length} update(s) to your long-term coaching profile.`,
            ...(injuries ? { injuries } : {}),
            coachMemoryCount: factsSaved,
        };
    },
    {
        name: "mutate_user_memory",
        description:
            "Persist durable facts to the user's Supabase profile for future sessions. Use when the user shares lasting information: injuries or pain patterns, movement preferences, goals, or anything they want remembered. Prefer this for 'I tweaked my shoulder' when they want it remembered in the profile. Use create_temporary_override when they need automatic plan substitutions for a time window. Do not use for exercise search or generating a workout.",
        schema: z.object({
            userId: z.string(),
            mutations: z
                .array(
                    z.discriminatedUnion("kind", [
                        z.object({
                            kind: z.literal("add_injury"),
                            label: z
                                .string()
                                .describe("Short label, e.g. 'left shoulder — painful overhead'"),
                        }),
                        z.object({
                            kind: z.literal("remove_injury"),
                            label: z.string().describe("Injury label to remove (case-insensitive)"),
                        }),
                        z.object({
                            kind: z.literal("add_coach_fact"),
                            fact: z.string().describe("Stable fact or preference, e.g. 'dislikes burpees'"),
                        }),
                        z.object({
                            kind: z.literal("remove_coach_fact"),
                            fact: z.string().describe("Fact text to remove (case-insensitive)"),
                        }),
                    ])
                )
                .min(1),
        }),
    }
);

// ============================================================================
// OTHER TOOLS
// ============================================================================

export const getActiveUserContextTool = tool(
    async ({ userId }) => {
        console.log(`Getting active context for user ${userId}`);

        const { data: profile } = await supabase
            .from("user_profiles")
            .select("*")
            .eq("id", userId)
            .single();

        if (!profile) {
            return {
                success: false,
                error: "User profile not found",
            };
        }

        // Get active overrides (FIXED column names)
        const { data: overrides } = await supabase
            .from("durational_plan_overrides")
            .select("*")
            .eq("user_id", userId)
            .eq("is_active", true)
            .gte("effective_until", new Date().toISOString());

        const profileInjuries = parseInjuriesField(profile.injuries);
        // Coach facts come from the categorized coach_memories table (the
        // legacy user_profiles.coach_memory JSONB is retired).
        let coachMemoryFacts: string[] = [];
        try {
            const { getActiveCoachMemories } = await import("../services/longTermMemory");
            const map = await getActiveCoachMemories(userId, 5);
            coachMemoryFacts = Object.values(map).flat();
        } catch (err) {
            console.warn("get_active_user_context: coach_memories read failed (non-fatal):", err);
        }

        const overrideInjuries: string[] = [];
        for (const override of overrides || []) {
            if (override.rule_data?.avoidBodyParts) {
                overrideInjuries.push(...override.rule_data.avoidBodyParts);
            }
        }

        const allInjuries = Array.from(new Set([...profileInjuries, ...overrideInjuries]));

        const mergedContext: any = {
            ...profile,
            activeOverrides: overrides || [],
            baseEquipment: profile.available_equipment,
            effectiveEquipment: profile.available_equipment,
            effectiveInjuries: allInjuries,
            coachMemoryFacts,
        };

        for (const override of overrides || []) {
            if (override.rule_data?.equipmentOverride) {
                mergedContext.effectiveEquipment = override.rule_data.equipmentOverride;
            }
        }

        console.log(`Context: equipment=${mergedContext.effectiveEquipment.join(",")}, injuries=${mergedContext.effectiveInjuries.join(",")}`);
        return mergedContext;
    },
    {
        name: "get_active_user_context",
        description: "Get user's current effective context (merges base profile with active temporary overrides). Use this to get equipment and injury constraints.",
        schema: z.object({
            userId: z.string(),
        }),
    }
);

// ============================================================================
// PERFORMANCE HISTORY TOOL (Analyst)
// ============================================================================
//
// Lightweight read-only tool: returns the last N completed exercise sessions
// from `exercise_performance`. Analyst agent uses this to discuss progress
// without granting write access to mutate plans.

export const getPerformanceHistoryTool = tool(
    async ({ userId, limit, exerciseName }) => {
        const cap = Math.min(Math.max(limit ?? 30, 1), 100);
        // exercise_performance stores one row PER SET, so we pull the most recent
        // sets and aggregate them into per-(exercise, day) sessions below.
        let query = supabase
            .from("exercise_performance")
            .select("exercise_id, exercise_name, set_number, reps_completed, weight_used, workout_date")
            .eq("user_id", userId)
            .order("workout_date", { ascending: false })
            .limit(cap * 6);

        if (exerciseName) {
            query = query.ilike("exercise_name", `%${exerciseName}%`);
        }

        const { data, error } = await query;

        if (error) {
            return { success: false, error: error.message, sessions: [] };
        }

        const sessions = aggregateExercisePerformanceRows(data ?? []).slice(0, cap);

        return {
            success: true,
            count: sessions.length,
            sessions,
        };
    },
    {
        name: "get_performance_history",
        description:
            "Read recent completed sessions for the user from exercise_performance. Use ONLY for analysis/coaching answers. Does not mutate the plan. Optionally filter by exerciseName.",
        schema: z.object({
            userId: z.string(),
            limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 30)"),
            exerciseName: z.string().optional().describe("Optional case-insensitive substring filter on exercise_name"),
        }),
    }
);

// ============================================================================
// VOLUME TREND TOOL (Analyst)
// ============================================================================
//
// Aggregates completed sets×reps×weight per week for the last `weeks` weeks.
// Returns a small JSON payload the analyst LLM can summarize.

export const calculateVolumeTrendTool = tool(
    async ({ userId, weeks }) => {
        const span = Math.min(Math.max(weeks ?? 4, 1), 26);
        const since = new Date();
        since.setDate(since.getDate() - span * 7);

        const { data, error } = await supabase
            .from("exercise_performance")
            .select("exercise_name, reps_completed, weight_used, workout_date")
            .eq("user_id", userId)
            .gte("workout_date", since.toISOString())
            .order("workout_date", { ascending: true });

        if (error) {
            return { success: false, error: error.message, weekly: [] };
        }

        // Each row is a single set, so volume per row = reps × weight. We count
        // distinct workout days per week as "sessions".
        const weekly = new Map<string, { volume: number; days: Set<string> }>();
        for (const row of data ?? []) {
            const date = new Date(row.workout_date as string);
            // ISO week bucket: YYYY-Wxx using Monday-anchored week
            const day = (date.getUTCDay() + 6) % 7; // 0 = Monday
            const monday = new Date(date);
            monday.setUTCDate(date.getUTCDate() - day);
            monday.setUTCHours(0, 0, 0, 0);
            const bucket = monday.toISOString().slice(0, 10);

            const reps = Number(row.reps_completed) || 0;
            const weight = Number(row.weight_used) || 0;
            const volume = reps * Math.max(weight, 1);

            const prev = weekly.get(bucket) ?? { volume: 0, days: new Set<string>() };
            prev.volume += volume;
            prev.days.add(String(row.workout_date).slice(0, 10));
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
        const trendDirection =
            series.length >= 2
                ? series[series.length - 1].volume > series[0].volume
                    ? "up"
                    : series[series.length - 1].volume < series[0].volume
                        ? "down"
                        : "flat"
                : "insufficient_data";

        return {
            success: true,
            weeks: span,
            totalVolume,
            trendDirection,
            weekly: series,
        };
    },
    {
        name: "calculate_volume_trend",
        description:
            "Compute weekly training-volume trend (sets × reps × weight) over the last N weeks (default 4). Returns a compact JSON series the analyst can summarize for the user. Read-only.",
        schema: z.object({
            userId: z.string(),
            weeks: z.number().int().min(1).max(26).optional().describe("Lookback window in weeks (default 4)"),
        }),
    }
);

export const logWorkoutCompletionTool = tool(
    async ({ userId, workoutId, exercises, completedAt }) => {
        console.log(`Logging workout completion for user ${userId}`);

        const completionDate = completedAt || new Date().toISOString();
        let improved = false;
        const improvementMessages: string[] = [];
        // Progressive-overload targets for NEXT session, derived from what the
        // user just did (simple double-progression: top of range → add weight;
        // below range → hold; in range → add a rep).
        const nextTargets: {
            exercise: string;
            weight: number;
            reps: number;
            change: "increase_weight" | "add_rep" | "hold";
        }[] = [];

        // Rows for ALL exercises are collected and inserted in ONE batch below —
        // the per-exercise inserts used to run serially with no error check, so
        // a mid-loop failure silently dropped part of the session.
        const performanceRows: {
            user_id: string;
            exercise_id: string;
            exercise_name: string;
            set_number: number;
            reps_completed: number;
            weight_used: number;
            workout_date: string;
            comment: string | null;
        }[] = [];

        for (const ex of exercises) {
            // exercise_performance is a per-SET log; read the heaviest prior set
            // for this movement to detect a PR/improvement.
            const { data: lastPerf } = await supabase
                .from("exercise_performance")
                .select("weight_used, reps_completed")
                .eq("user_id", userId)
                .eq("exercise_id", ex.id)
                .order("workout_date", { ascending: false })
                .limit(1)
                .maybeSingle();

            const exerciseImproved = Boolean(lastPerf && (
                ex.weight > lastPerf.weight_used ||
                (ex.weight === lastPerf.weight_used && ex.reps > lastPerf.reps_completed)
            ));

            if (exerciseImproved) {
                improved = true;
                improvementMessages.push(ex.name);
            }

            if (ex.weight > 0) {
                if (ex.reps >= 12) {
                    nextTargets.push({
                        exercise: ex.name,
                        weight: Math.round((ex.weight + 2.5) * 2) / 2,
                        reps: 8,
                        change: "increase_weight",
                    });
                } else if (ex.reps >= 8) {
                    nextTargets.push({
                        exercise: ex.name,
                        weight: ex.weight,
                        reps: ex.reps + 1,
                        change: "add_rep",
                    });
                } else {
                    nextTargets.push({
                        exercise: ex.name,
                        weight: ex.weight,
                        reps: ex.reps,
                        change: "hold",
                    });
                }
            }

            // Expand the aggregate (sets/reps/weight) into one row per set.
            const setCount = Math.max(1, Number(ex.sets) || 1);
            for (let i = 0; i < setCount; i++) {
                performanceRows.push({
                    user_id: userId,
                    exercise_id: ex.id,
                    exercise_name: ex.name,
                    set_number: i + 1,
                    reps_completed: ex.reps,
                    weight_used: ex.weight || 0,
                    workout_date: completionDate,
                    comment: workoutId ? `workout:${workoutId}` : null,
                });
            }
        }

        if (performanceRows.length > 0) {
            const { error: insertError } = await supabase
                .from("exercise_performance")
                .insert(performanceRows);
            if (insertError) {
                console.error("log_workout_completion insert failed:", insertError.message);
                return {
                    success: false,
                    error: `Failed to save the session log: ${insertError.message}`,
                };
            }
        }

        let message = "Workout logged!";
        if (improved) {
            message = `Great job! You beat your last workout on: ${improvementMessages.join(", ")}! 💪`;
        }
        // Append up to 3 next-session targets so the recap coaches forward,
        // not just backward ("next time: Bench 62.5kg×8").
        const highlights = nextTargets
            .filter((t) => t.change !== "hold")
            .slice(0, 3)
            .map((t) =>
                t.change === "increase_weight"
                    ? `${t.exercise} ${t.weight}kg×${t.reps} (weight up)`
                    : `${t.exercise} ${t.weight}kg×${t.reps} (+1 rep)`
            );
        if (highlights.length > 0) {
            message += ` Next session targets: ${highlights.join(" · ")}.`;
        }

        console.log(`${message}`);
        return {
            success: true,
            message,
            improved,
            improvementsCount: improvementMessages.length,
            nextTargets,
        };
    },
    {
        name: "log_workout_completion",
        description: "Log a completed workout with exercise performance for progressive overload tracking",
        schema: z.object({
            userId: z.string(),
            workoutId: z.string(),
            exercises: z.array(z.object({
                id: z.string(),
                name: z.string(),
                sets: z.number(),
                reps: z.number(),
                weight: z.number(),
            })),
            completedAt: z.string().optional(),
        }),
    }
);

// ============================================================================
// AGENT-SPECIFIC TOOL ARRAYS
// ============================================================================
//
// Each specialized agent in the supervisor router only sees the tools relevant
// to its responsibility. The execution layer continues to know about every
// tool, but agents are scoped via these exports + the `ALLOWED_TOOLS_BY_AGENT`
// map in supervisorGraph.ts.

/** Planner: plan creation / large-scale plan edits in conversation. */
export const plannerTools = [
    searchExercisesTool,
    findSimilarExercisesTool,
    getActiveUserContextTool,
    modifyPlanPermanentlyTool,
    generateDraftPlanTool,
    modifyDraftPlanTool,
    approveAndPublishPlanTool,
];

/** Editor: per-session and short-term plan adjustments. */
export const editorTools = [
    searchExercisesTool,
    findSimilarExercisesTool,
    getActiveUserContextTool,
    addToTodaysWorkoutTool,
    createTemporaryOverrideTool,
    modifyPlanPermanentlyTool,
    createOneOffWorkoutTool,
    swapSessionExerciseTool,
    swapPermanentExerciseTool,
    shiftWorkoutScheduleTool,
    saveWorkoutToLibraryTool,
    listSavedWorkoutsTool,
    deleteSavedWorkoutTool,
    updateUserProfileTool,
];

/** Analyst: read-only progress / metrics tools + nutrition + body-weight writes. */
export const analystTools = [
    getActiveUserContextTool,
    getTodaysWorkoutTool,
    getPerformanceHistoryActionTool,
    calculateVolumeTrendActionTool,
    logWorkoutCompletionTool,
    logExerciseSetTool,
    parseNutritionStringTool,
    logNutritionEntryTool,
    editNutritionEntryTool,
    deleteNutritionEntryTool,
    setDailyMacroGoalsTool,
    getDailyMacroGoalsTool,
    logBodyWeightTool,
    getBodyWeightHistoryTool,
    updateUserProfileTool,
];

/** Memory: long-term context persistence (silent background path). */
export const memoryTools = [
    mutateUserMemoryTool,
    saveCoreMemoryTool,
    fetchUserContextTool,
];

/**
 * Legacy union (kept for backward compatibility with any caller that imports
 * `availableTools` — historically the entire tool surface for the trainer).
 * The new DynamicStructuredTool registry tools are appended so the dispatcher
 * map below can resolve them.
 */
export const availableTools = [
    searchExercisesTool,
    getActiveUserContextTool,
    getTodaysWorkoutTool,
    addToTodaysWorkoutTool,
    createOneOffWorkoutTool,
    createTemporaryOverrideTool,
    modifyPlanPermanentlyTool,
    logWorkoutCompletionTool,
    mutateUserMemoryTool,
    parseNutritionStringTool,
    getPerformanceHistoryActionTool,
    calculateVolumeTrendActionTool,
    generateDraftPlanTool,
    modifyDraftPlanTool,
    approveAndPublishPlanTool,
    swapSessionExerciseTool,
    swapPermanentExerciseTool,
    shiftWorkoutScheduleTool,
    saveCoreMemoryTool,
    fetchUserContextTool,
    logNutritionEntryTool,
    editNutritionEntryTool,
    deleteNutritionEntryTool,
    setDailyMacroGoalsTool,
    getDailyMacroGoalsTool,
    logBodyWeightTool,
    getBodyWeightHistoryTool,
    saveWorkoutToLibraryTool,
    listSavedWorkoutsTool,
    deleteSavedWorkoutTool,
    updateUserProfileTool,
    logExerciseSetTool,
];

/**
 * Maps the LangGraph tool name -> tool object (used by execute_tools).
 *
 * NOTE: `get_performance_history` and `calculate_volume_trend` resolve to the
 * new DynamicStructuredTool implementations (stricter schemas, exercise_id
 * required). The legacy `getPerformanceHistoryTool` / `calculateVolumeTrendTool`
 * exports above remain available for any direct callers.
 */
export const toolByName: Record<string, (typeof availableTools)[number]> = {
    search_exercises: searchExercisesTool,
    find_similar_exercises: findSimilarExercisesTool,
    get_active_user_context: getActiveUserContextTool,
    get_todays_workout: getTodaysWorkoutTool,
    add_to_todays_workout: addToTodaysWorkoutTool,
    create_one_off_workout: createOneOffWorkoutTool,
    extend_one_off_workout: extendOneOffWorkoutTool,
    create_temporary_override: createTemporaryOverrideTool,
    modify_plan_permanently: modifyPlanPermanentlyTool,
    log_workout_completion: logWorkoutCompletionTool,
    mutate_user_memory: mutateUserMemoryTool,
    parse_nutrition_string: parseNutritionStringTool,
    get_performance_history: getPerformanceHistoryActionTool,
    calculate_volume_trend: calculateVolumeTrendActionTool,
    generate_draft_plan: generateDraftPlanTool,
    modify_draft_plan: modifyDraftPlanTool,
    approve_and_publish_plan: approveAndPublishPlanTool,
    swap_session_exercise: swapSessionExerciseTool,
    swap_permanent_exercise: swapPermanentExerciseTool,
    shift_workout_schedule: shiftWorkoutScheduleTool,
    save_core_memory: saveCoreMemoryTool,
    fetch_user_context: fetchUserContextTool,
    log_nutrition_entry: logNutritionEntryTool,
    edit_nutrition_entry: editNutritionEntryTool,
    delete_nutrition_entry: deleteNutritionEntryTool,
    set_daily_macro_goals: setDailyMacroGoalsTool,
    get_daily_macro_goals: getDailyMacroGoalsTool,
    log_body_weight: logBodyWeightTool,
    get_body_weight_history: getBodyWeightHistoryTool,
    save_workout_to_library: saveWorkoutToLibraryTool,
    list_saved_workouts: listSavedWorkoutsTool,
    delete_saved_workout: deleteSavedWorkoutTool,
    update_user_profile: updateUserProfileTool,
    log_exercise_set: logExerciseSetTool,
};
