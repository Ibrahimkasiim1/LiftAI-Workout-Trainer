/**
 * Planner Action Tools
 *
 * DynamicStructuredTool implementations the Planner subgraph uses to manage
 * draft plans (`pending_plan_edits`) and to publish them to the live runtime
 * tables (`workout_plans` + `daily_workouts`). All DB access goes through the
 * shared Supabase client in `services/db.ts` so RLS / service-role context is
 * consistent with the rest of the backend.
 *
 * Contract for every tool:
 *   - validates inputs with Zod
 *   - returns `{ success: true, ... }` on happy path
 *   - returns `{ success: false, error: "<safe llm-readable string>" }` on failure
 *   - never throws (every supabase call is wrapped in try/catch)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { supabase } from "../services/db";
import { recordPlanChangeNote } from "../services/proactiveCheckins";
import { estimateWorkoutDurationMinutes } from "../services/workoutDuration";
import { getUserTimezone } from "../services/userTimezone";

// ============================================================================
// SHARED HELPERS
// ============================================================================

const DAY_NAMES = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
] as const;

type Weekday = (typeof DAY_NAMES)[number];

function indexOfDayName(name: string | undefined): number {
    if (!name) return -1;
    const low = name.trim().toLowerCase();
    return DAY_NAMES.findIndex((d) => d === low);
}

function normalizeWeekday(name: string | null | undefined): Weekday | null {
    if (!name) return null;
    const low = name.trim().toLowerCase();
    return (DAY_NAMES as readonly string[]).includes(low) ? (low as Weekday) : null;
}

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

// ============================================================================
// ROLLING SCHEDULE HELPERS
// ============================================================================

/**
 * Resolve "today" as a canonical weekday in the user's local timezone.
 * Falls back to UTC if `timezone` is missing or invalid.
 */
function resolveTodayWeekday(timezone: string | null | undefined): Weekday {
    const tz = timezone && timezone.trim().length > 0 ? timezone : "UTC";
    let dayName = "Monday";
    try {
        dayName = new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            timeZone: tz,
        }).format(new Date());
    } catch {
        try {
            dayName = new Intl.DateTimeFormat("en-US", {
                weekday: "long",
                timeZone: "UTC",
            }).format(new Date());
        } catch {
            dayName = "Monday";
        }
    }
    return normalizeWeekday(dayName) ?? "monday";
}

/**
 * Sort preferred days starting from today's weekday, walking forward through the week.
 * Example: today=wednesday, preferred=[monday, wednesday, friday, saturday]
 *          -> [wednesday, friday, saturday, monday]
 *
 * Duplicates and unknown day names are filtered out.
 */
function rotatePreferredDaysFromToday(
    preferredDays: Weekday[],
    today: Weekday
): Weekday[] {
    if (preferredDays.length === 0) return [];
    const preferredSet = new Set<Weekday>(preferredDays);
    const todayIdx = DAY_NAMES.indexOf(today);
    const rotated: Weekday[] = [];
    for (let offset = 0; offset < 7; offset++) {
        const day = DAY_NAMES[(todayIdx + offset) % 7];
        if (preferredSet.has(day)) {
            rotated.push(day);
        }
    }
    return rotated;
}

/**
 * Roll the core workout array onto the rotated preferred days using modulo wrap.
 * Each rotated day i gets coreWorkouts[i % coreWorkouts.length].
 */
function rollWorkoutsOntoDays<T extends Record<string, unknown>>(
    coreWorkouts: T[],
    rotatedDays: Weekday[]
): Array<T & { day_of_week: Weekday }> {
    if (coreWorkouts.length === 0 || rotatedDays.length === 0) return [];
    return rotatedDays.map((day, idx) => {
        const workout = coreWorkouts[idx % coreWorkouts.length];
        return { ...workout, day_of_week: day };
    });
}

/**
 * Parse a `selected_workout_days` value (which may be string[], object map, or CSV)
 * into a deduped array of canonical Weekday strings.
 */
function parseSelectedWorkoutDays(raw: unknown): Weekday[] {
    if (!raw) return [];
    const collected: string[] = [];
    if (Array.isArray(raw)) {
        if (raw.length === 0) return [];
        if (typeof raw[0] === "string") {
            collected.push(...(raw as string[]));
        } else if (
            typeof raw[0] === "object" &&
            raw[0] !== null &&
            "day" in (raw[0] as object)
        ) {
            for (const entry of raw as Array<{ day: string; enabled?: boolean }>) {
                if (entry.enabled !== false) collected.push(entry.day);
            }
        }
    } else if (typeof raw === "object" && raw !== null) {
        const map = raw as Record<string, unknown>;
        for (const [key, value] of Object.entries(map)) {
            if (value === true) collected.push(key);
        }
    } else if (typeof raw === "string") {
        collected.push(...raw.split(",").map((s) => s.trim()));
    }

    const seen = new Set<Weekday>();
    const out: Weekday[] = [];
    for (const candidate of collected) {
        const normalized = normalizeWeekday(candidate);
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            out.push(normalized);
        }
    }
    return out;
}

// ============================================================================
// SHARED ZOD SCHEMAS
// ============================================================================

const planDayInputSchema = z
    .object({
        day_of_week: z
            .string()
            .describe("Lowercase day name: monday|tuesday|...|sunday"),
        split_day_name: z
            .string()
            .describe("Display label, e.g. 'Push', 'Legs', 'Pull A'"),
        estimated_time: z
            .number()
            .int()
            .min(10)
            .max(300)
            .default(45)
            .describe("Estimated session duration in minutes"),
        exercises: z
            .array(
                z.object({
                    id: z.string().optional(),
                    name: z.string(),
                    sets: z.number().optional(),
                    reps: z.union([z.string(), z.number()]).optional(),
                    rest_seconds: z.number().optional(),
                    body_part: z.string().optional(),
                    target_muscle: z.string().optional(),
                    equipment: z.string().optional(),
                    gif_path: z.string().optional(),
                    quick_alternatives: z
                        .array(z.string())
                        .optional()
                        .describe(
                            "2-3 alternative exercise names from the allowed dictionary, used for instant frontend swap UI."
                        ),
                    intensity_target: z
                        .string()
                        .optional()
                        .describe(
                            "RIR / RPE auto-regulation target string (e.g. '2 RIR - stop 2 reps shy of failure', 'RPE 8')."
                        ),
                })
            )
            .min(0)
            .describe("Structured exercises for this day"),
        notes: z.string().optional().describe("Optional coaching notes"),
    })
    .strict();

const onboardingPayloadSchema = z
    .object({
        plan_name: z.string().min(1).default("My Plan"),
        split: z
            .string()
            .min(1)
            .describe("Split label, e.g. 'PPL', 'Upper/Lower', 'Full Body'"),
        goal: z.string().optional(),
        days: z.array(planDayInputSchema).min(1),
    })
    .strict();

// ============================================================================
// generate_draft_plan
// ============================================================================

export const generateDraftPlanTool = new DynamicStructuredTool({
    name: "generate_draft_plan",
    description:
        "Persist a NEW draft workout plan to `pending_plan_edits` for the supplied user + conversation. " +
        "IMPORTANT: `payload.days` MUST be the array of unique CORE SPLIT ROUTINES " +
        "(e.g. exactly 3 entries for PPL, 2 for Upper/Lower, 1 for Full Body, 5 for Bro Split). " +
        "Do NOT submit one entry per preferred training day. The tool re-maps these core routines " +
        "onto the user's selected weekdays using a deterministic rolling modulo wrap anchored on " +
        "the user's local 'today' (timezone from user_profiles, fallback UTC). " +
        "Use this when the planner has finished gathering onboarding info (split, days, equipment) and " +
        "needs to stage a plan the user can review before it goes live. " +
        "Idempotent on (user_id, conversation_id) — calling again replaces the existing draft for that conversation. " +
        "Does NOT modify `workout_plans` or `daily_workouts`; call `approve_and_publish_plan` for that.",
    schema: z
        .object({
            user_id: z.string().describe("Owner of the draft plan."),
            conversation_id: z
                .string()
                .min(1)
                .describe(
                    "Conversation/thread id used to scope the draft (one draft per conversation)."
                ),
            payload: onboardingPayloadSchema.describe(
                "Full onboarding plan blob: split, goal, plan_name, and `days` containing the CORE split routines (count = unique routines for the split, NOT one per preferred day). The tool will roll these onto preferred days for you."
            ),
        })
        .strict(),
    func: async ({ user_id, conversation_id, payload }) => {
        try {
            // The incoming `payload.days` is treated as the AI's CORE workout array
            // (one entry per unique routine, e.g. [Push, Pull, Legs] for PPL).
            // We re-map those onto the user's preferred weekdays using a rolling
            // modulo wrap, anchored on the user's local "today".
            const coreWorkouts = Array.isArray(payload.days) ? payload.days : [];
            if (coreWorkouts.length === 0) {
                return {
                    success: false,
                    error:
                        "Cannot generate draft plan: no core workouts were provided. Generate the split routines first.",
                };
            }

            const { data: profileRow, error: profileError } = await supabase
                .from("user_profiles")
                .select("*")
                .eq("id", user_id)
                .maybeSingle();

            if (profileError) {
                console.warn(
                    "generate_draft_plan: failed to load user_profiles, falling back to payload days for preferred-day source:",
                    profileError.message
                );
            }

            const profile = (profileRow ?? {}) as Record<string, unknown>;
            // Timezone is NOT a column on user_profiles — it lives on
            // user_quotas (written by the client's set_user_timezone RPC).
            // Reading profile["timezone"] always returned undefined → UTC.
            const timezone = await getUserTimezone(user_id);

            let preferredDays = parseSelectedWorkoutDays(
                profile["selected_workout_days"]
            );

            if (preferredDays.length === 0) {
                const fromPayload: Weekday[] = [];
                const seen = new Set<Weekday>();
                for (const day of coreWorkouts) {
                    const normalized = normalizeWeekday(
                        (day as { day_of_week?: string }).day_of_week
                    );
                    if (normalized && !seen.has(normalized)) {
                        seen.add(normalized);
                        fromPayload.push(normalized);
                    }
                }
                preferredDays = fromPayload;
            }

            if (preferredDays.length === 0) {
                return {
                    success: false,
                    error:
                        "No preferred training days found on the user profile. Ask the user which days they want to train before drafting a plan.",
                };
            }

            const today = resolveTodayWeekday(timezone);
            const rotatedDays = rotatePreferredDaysFromToday(preferredDays, today);

            if (rotatedDays.length === 0) {
                return {
                    success: false,
                    error:
                        "Could not rotate preferred days; the user's selected days appear to be invalid.",
                };
            }

            const rolledDays = rollWorkoutsOntoDays(
                coreWorkouts as Array<Record<string, unknown>>,
                rotatedDays
            );

            const persistedPayload = {
                ...payload,
                days: rolledDays,
            };

            const { data, error } = await supabase
                .from("pending_plan_edits")
                .upsert(
                    {
                        user_id,
                        conversation_id,
                        payload: persistedPayload,
                    },
                    { onConflict: "user_id,conversation_id" }
                )
                .select("id, created_at")
                .single();

            if (error) {
                return {
                    success: false,
                    error: describeError(error, "Failed to upsert pending_plan_edits"),
                };
            }

            return {
                success: true,
                draftId: data?.id,
                createdAt: data?.created_at,
                message:
                    `Draft plan staged for conversation ${conversation_id}. ` +
                    `Mapped ${coreWorkouts.length} core routine(s) onto ${rolledDays.length} training day(s) ` +
                    `starting ${today} (${timezone ?? "UTC"}).`,
                coreWorkoutCount: coreWorkouts.length,
                mappedDayCount: rolledDays.length,
                startDay: today,
                timezone: timezone ?? "UTC",
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "generate_draft_plan threw"),
            };
        }
    },
});

// ============================================================================
// modify_draft_plan
// ============================================================================

const draftPatchSchema = z
    .object({
        plan_name: z.string().optional(),
        split: z.string().optional(),
        goal: z.string().optional(),
        replace_days: z
            .array(planDayInputSchema)
            .optional()
            .describe("If provided, REPLACES the entire days array."),
        upsert_days: z
            .array(planDayInputSchema)
            .optional()
            .describe(
                "If provided, upserts each day by `day_of_week` into the existing days array."
            ),
        remove_day_of_week: z
            .array(z.string())
            .optional()
            .describe("Day names to remove from the draft (case-insensitive)."),
    })
    .strict();

export const modifyDraftPlanTool = new DynamicStructuredTool({
    name: "modify_draft_plan",
    description:
        "Apply a controlled patch to an existing draft plan stored in `pending_plan_edits`. " +
        "Supports updating top-level fields (plan_name, split, goal) and three day-level operations: " +
        "`replace_days` (overwrite all), `upsert_days` (merge by day_of_week), or `remove_day_of_week` (delete). " +
        "Reads the existing payload, merges the patch, and writes the result back. " +
        "Returns an error if no draft exists for that user/conversation — call `generate_draft_plan` first.",
    schema: z
        .object({
            user_id: z.string(),
            conversation_id: z.string().min(1),
            patch: draftPatchSchema,
        })
        .strict(),
    func: async ({ user_id, conversation_id, patch }) => {
        try {
            const { data: existing, error: fetchError } = await supabase
                .from("pending_plan_edits")
                .select("id, payload")
                .eq("user_id", user_id)
                .eq("conversation_id", conversation_id)
                .maybeSingle();

            if (fetchError) {
                return {
                    success: false,
                    error: describeError(
                        fetchError,
                        "Failed to load pending_plan_edits"
                    ),
                };
            }

            if (!existing) {
                return {
                    success: false,
                    error:
                        "No draft plan found for this conversation. Call generate_draft_plan first.",
                };
            }

            const current = (existing.payload ?? {}) as Record<string, unknown>;
            const currentDays: Array<Record<string, unknown>> = Array.isArray(
                (current as { days?: unknown }).days
            )
                ? ((current as { days: Array<Record<string, unknown>> }).days)
                : [];

            const next: Record<string, unknown> = { ...current };

            if (patch.plan_name !== undefined) next.plan_name = patch.plan_name;
            if (patch.split !== undefined) next.split = patch.split;
            if (patch.goal !== undefined) next.goal = patch.goal;

            let nextDays = currentDays;

            if (patch.replace_days) {
                nextDays = patch.replace_days as unknown as Array<
                    Record<string, unknown>
                >;
            } else {
                if (patch.upsert_days?.length) {
                    const byDow = new Map<string, Record<string, unknown>>();
                    for (const day of nextDays) {
                        const dow = String(day.day_of_week ?? "").toLowerCase();
                        if (dow) byDow.set(dow, day);
                    }
                    for (const day of patch.upsert_days) {
                        const dow = day.day_of_week.toLowerCase();
                        byDow.set(dow, {
                            ...(byDow.get(dow) ?? {}),
                            ...(day as unknown as Record<string, unknown>),
                        });
                    }
                    nextDays = Array.from(byDow.values());
                }

                if (patch.remove_day_of_week?.length) {
                    const drop = new Set(
                        patch.remove_day_of_week.map((d) => d.toLowerCase())
                    );
                    nextDays = nextDays.filter(
                        (d) => !drop.has(String(d.day_of_week ?? "").toLowerCase())
                    );
                }
            }

            nextDays = nextDays.slice().sort((a, b) => {
                const ai = indexOfDayName(String(a.day_of_week ?? ""));
                const bi = indexOfDayName(String(b.day_of_week ?? ""));
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });

            next.days = nextDays;

            const { error: updateError } = await supabase
                .from("pending_plan_edits")
                .update({ payload: next })
                .eq("id", existing.id);

            if (updateError) {
                return {
                    success: false,
                    error: describeError(
                        updateError,
                        "Failed to update pending_plan_edits"
                    ),
                };
            }

            return {
                success: true,
                message: `Draft plan updated. ${nextDays.length} day(s) on plan.`,
                dayCount: nextDays.length,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "modify_draft_plan threw"),
            };
        }
    },
});

// ============================================================================
// approve_and_publish_plan
// ============================================================================

export const approveAndPublishPlanTool = new DynamicStructuredTool({
    name: "approve_and_publish_plan",
    description:
        "Promote a staged draft from `pending_plan_edits` into the live runtime tables. " +
        "Steps performed atomically per call: (1) read latest draft for the user (optionally scoped to a conversation), " +
        "(2) deactivate any existing active workout_plans rows, (3) insert a new row in `workout_plans`, " +
        "(4) insert one row per day into `daily_workouts`, and (5) clear the consumed pending_plan_edits row. " +
        "Use ONLY when the user has approved the plan. Returns the new plan id and day count.",
    schema: z
        .object({
            user_id: z.string(),
            conversation_id: z
                .string()
                .optional()
                .describe(
                    "If provided, publishes that specific draft. Otherwise publishes the most recent draft for the user."
                ),
        })
        .strict(),
    func: async ({ user_id, conversation_id }) => {
        try {
            let draftQuery = supabase
                .from("pending_plan_edits")
                .select("id, conversation_id, payload, created_at")
                .eq("user_id", user_id)
                .order("created_at", { ascending: false })
                .limit(1);

            if (conversation_id) {
                draftQuery = supabase
                    .from("pending_plan_edits")
                    .select("id, conversation_id, payload, created_at")
                    .eq("user_id", user_id)
                    .eq("conversation_id", conversation_id)
                    .limit(1);
            }

            const { data: drafts, error: draftError } = await draftQuery;

            if (draftError) {
                return {
                    success: false,
                    error: describeError(draftError, "Failed to load draft plan"),
                };
            }

            const draft = drafts?.[0];
            if (!draft) {
                return {
                    success: false,
                    error:
                        "No draft plan found to publish. Call generate_draft_plan first.",
                };
            }

            const payload = (draft.payload ?? {}) as {
                plan_name?: string;
                split?: string;
                goal?: string;
                days?: Array<{
                    day_of_week: string;
                    split_day_name: string;
                    estimated_time?: number;
                    exercises?: Array<Record<string, unknown>>;
                    notes?: string;
                }>;
            };

            if (!payload.days || payload.days.length === 0) {
                return {
                    success: false,
                    error:
                        "Draft plan has no days to publish. Add days via modify_draft_plan first.",
                };
            }

            const { error: deactivateError } = await supabase
                .from("workout_plans")
                .update({ is_active: false })
                .eq("user_id", user_id);

            if (deactivateError) {
                return {
                    success: false,
                    error: describeError(
                        deactivateError,
                        "Failed to deactivate existing plans"
                    ),
                };
            }

            const { data: insertedPlan, error: insertPlanError } = await supabase
                .from("workout_plans")
                .insert({
                    user_id,
                    plan_name: payload.plan_name ?? `${payload.split ?? "Custom"} Plan`,
                    is_active: true,
                })
                .select("id")
                .single();

            if (insertPlanError || !insertedPlan) {
                return {
                    success: false,
                    error: describeError(
                        insertPlanError ?? "no row returned",
                        "Failed to insert workout_plans row"
                    ),
                };
            }

            const dailyRows = payload.days.map((day) => {
                const exercises = day.exercises ?? [];
                return {
                    plan_id: insertedPlan.id,
                    day_of_week: day.day_of_week.toLowerCase(),
                    split_day_name: day.split_day_name,
                    estimated_time: day.estimated_time ?? estimateWorkoutDurationMinutes(exercises as any[]),
                    exercises: exercises.map((e) => String((e as { name?: string }).name ?? "")),
                    exercises_structured: exercises,
                    notes: day.notes ?? null,
                };
            });

            const { error: insertDaysError } = await supabase
                .from("daily_workouts")
                .insert(dailyRows);

            if (insertDaysError) {
                return {
                    success: false,
                    error: describeError(
                        insertDaysError,
                        "Failed to insert daily_workouts rows"
                    ),
                };
            }

            const { error: clearError } = await supabase
                .from("pending_plan_edits")
                .delete()
                .eq("id", draft.id);

            if (clearError) {
                console.warn(
                    "approve_and_publish_plan: plan published but failed to clear pending edit:",
                    clearError.message
                );
            }

            recordPlanChangeNote(
                user_id,
                `New plan published: ${payload.plan_name ?? payload.split ?? "Custom"}`,
                `Your new ${payload.split ?? "custom"} plan is live with ${dailyRows.length} training day(s)${payload.goal ? `, built around your ${payload.goal} goal` : ""}. Your old plan was archived — everything you log from now on counts toward the new structure.`,
                { planId: insertedPlan.id, split: payload.split ?? null, dayCount: dailyRows.length }
            );

            return {
                success: true,
                planId: insertedPlan.id,
                dayCount: dailyRows.length,
                message: `Published plan with ${dailyRows.length} day(s) for user ${user_id}.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "approve_and_publish_plan threw"),
            };
        }
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const plannerActionTools = [
    generateDraftPlanTool,
    modifyDraftPlanTool,
    approveAndPublishPlanTool,
];
