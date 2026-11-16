/**
 * Database Service
 * 
 * Provides Supabase client and core database operations.
 * All types are kept flexible with `any` casting where needed
 * to support both legacy and new code until full type migration.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { estimateWorkoutDurationMinutes } from "./workoutDuration";
import { filterByAvailableEquipment, toAvailableBuckets } from "./equipmentAvailability";
import { getUserTimezone, localTodayInTimezone } from "./userTimezone";
import {
  DailyWorkout,
  SplitType,
  UserProfile,
  WorkoutPlan
} from "../types";

// Re-export types for convenience
export type { DailyWorkout, UserProfile, WorkoutPlan };

export type InitialPlanGenerationStatus = "idle" | "running" | "failed";

export interface InitialPlanGenerationState {
  status: InitialPlanGenerationStatus;
  startedAt: string | null;
}

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ============================================================================
// USER PROFILE
// ============================================================================

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("Failed to load user profile:", error.message);
    return null;
  }

  return data as UserProfile | null;
}

export async function getInitialPlanGenerationState(
  userId: string
): Promise<InitialPlanGenerationState | null> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("initial_plan_generation_status,initial_plan_generation_started_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load generation state:", error.message);
    return null;
  }

  if (!data) return null;

  return {
    status: (data.initial_plan_generation_status as InitialPlanGenerationStatus) || "idle",
    startedAt: data.initial_plan_generation_started_at || null,
  };
}

export async function setInitialPlanGenerationState(
  userId: string,
  status: InitialPlanGenerationStatus,
  startedAt: string | null
): Promise<void> {
  const { error } = await supabase
    .from("user_profiles")
    .update({
      initial_plan_generation_status: status,
      initial_plan_generation_started_at: startedAt,
    })
    .eq("id", userId);

  if (error) {
    throw new Error(`Failed to set generation state: ${error.message}`);
  }
}

// ============================================================================
// CHAT TURN CONTEXT (single-RPC bundle)
// ============================================================================

export interface ChatTurnContextBundle {
  profile: UserProfile | null;
  /** Active plan row extended with `days` (same shape as getLatestPlan). */
  plan: WorkoutPlan | null;
  /** IANA timezone from user_quotas (falls back to "UTC"). */
  timezone: string;
  /** Active coach memories as {category, fact} rows. */
  memories: { category: string; fact: string }[];
}

/**
 * One-round-trip fetch of everything prepareChatTurn needs (profile, active
 * plan + days, timezone, coach memories) via the get_chat_turn_context RPC
 * (migration 20260713010000). Returns null when the RPC isn't deployed yet or
 * fails for any reason — callers keep the legacy parallel loads as fallback.
 */
export async function getChatTurnContext(userId: string): Promise<ChatTurnContextBundle | null> {
  try {
    const { data, error } = await supabase.rpc("get_chat_turn_context", {
      p_user_id: userId,
    });
    if (error) {
      if (error.code === "PGRST202") {
        // Migration not applied yet — silent fallback, log once per boot would
        // be nicer but this path disappears once the RPC lands.
        return null;
      }
      console.warn(`getChatTurnContext RPC failed (${error.message}); falling back`);
      return null;
    }
    const bundle = (data ?? {}) as {
      profile?: unknown;
      plan?: unknown;
      timezone?: unknown;
      memories?: unknown;
    };
    const tz = typeof bundle.timezone === "string" && bundle.timezone.trim().length > 0
      ? bundle.timezone
      : "UTC";
    return {
      profile: (bundle.profile ?? null) as UserProfile | null,
      plan: (bundle.plan ?? null) as WorkoutPlan | null,
      timezone: tz,
      memories: Array.isArray(bundle.memories)
        ? (bundle.memories as { category: string; fact: string }[]).filter(
            (m) => m && typeof m.category === "string" && typeof m.fact === "string"
          )
        : [],
    };
  } catch (err) {
    console.warn("getChatTurnContext threw; falling back:", err);
    return null;
  }
}

// ============================================================================
// EXERCISES
// ============================================================================

export async function fetchExercisesByIds(ids: string[]) {
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("exercises")
    .select("*")
    .in("id", ids);

  if (error) {
    console.error("Failed to fetch exercises:", error.message);
    return [];
  }

  return data || [];
}

// ============================================================================
// ALLOWED EXERCISE DICTIONARY (RAG)
// ============================================================================

/**
 * Compact row used to ground the planner LLM in a vetted exercise list.
 * Mirrors the minimum subset of the `exercises` table required for prompting
 * and post-generation matching.
 */
export interface AllowedExerciseRow {
  id: string;
  name: string;
  equipment: string | null;
  equipment_canonical?: string | null;
  target_muscle: string | null;
  body_part: string | null;
}

export interface AllowedExerciseDictionary {
  rows: AllowedExerciseRow[];
  formatted: string;
  source: "supabase" | "fallback";
  warnings: string[];
}

/**
 * Hardcoded fallback used when Supabase is unreachable or returns nothing.
 * Provides a small but balanced set of canonical compounds + accessories so
 * the planner can still produce a non-empty plan in degraded conditions.
 *
 * IMPORTANT: ids here are stable string sentinels (NOT real Supabase ids).
 * They are accepted by the planner's matching layer because the post-generation
 * pipeline only uses ids when they exist in the live exercise pool, and falls
 * back to fuzzy-name matching otherwise.
 */
export const FALLBACK_EXERCISE_DICTIONARY: AllowedExerciseRow[] = [
  { id: "fallback-back-squat", name: "Barbell Back Squat", equipment: "barbell", target_muscle: "quadriceps", body_part: "legs" },
  { id: "fallback-goblet-squat", name: "Dumbbell Goblet Squat", equipment: "dumbbell", target_muscle: "quadriceps", body_part: "legs" },
  { id: "fallback-bw-squat", name: "Bodyweight Squat", equipment: "body weight", target_muscle: "quadriceps", body_part: "legs" },
  { id: "fallback-rdl", name: "Romanian Deadlift", equipment: "barbell", target_muscle: "hamstrings", body_part: "legs" },
  { id: "fallback-glute-bridge", name: "Glute Bridge", equipment: "body weight", target_muscle: "glutes", body_part: "legs" },
  { id: "fallback-lunge", name: "Reverse Lunge", equipment: "dumbbell", target_muscle: "quadriceps", body_part: "legs" },
  { id: "fallback-bench-press", name: "Barbell Bench Press", equipment: "barbell", target_muscle: "chest", body_part: "chest" },
  { id: "fallback-db-bench", name: "Dumbbell Bench Press", equipment: "dumbbell", target_muscle: "chest", body_part: "chest" },
  { id: "fallback-pushup", name: "Push-Up", equipment: "body weight", target_muscle: "chest", body_part: "chest" },
  { id: "fallback-ohp", name: "Overhead Press", equipment: "barbell", target_muscle: "shoulders", body_part: "shoulders" },
  { id: "fallback-db-shoulder-press", name: "Dumbbell Shoulder Press", equipment: "dumbbell", target_muscle: "shoulders", body_part: "shoulders" },
  { id: "fallback-bb-row", name: "Barbell Bent-Over Row", equipment: "barbell", target_muscle: "back", body_part: "back" },
  { id: "fallback-db-row", name: "Single-Arm Dumbbell Row", equipment: "dumbbell", target_muscle: "back", body_part: "back" },
  { id: "fallback-inverted-row", name: "Inverted Row", equipment: "body weight", target_muscle: "back", body_part: "back" },
  { id: "fallback-pullup", name: "Pull-Up", equipment: "body weight", target_muscle: "lats", body_part: "back" },
  { id: "fallback-lat-pulldown", name: "Lat Pulldown", equipment: "cable", target_muscle: "lats", body_part: "back" },
  { id: "fallback-bicep-curl", name: "Dumbbell Bicep Curl", equipment: "dumbbell", target_muscle: "biceps", body_part: "arms" },
  { id: "fallback-tricep-ext", name: "Dumbbell Triceps Extension", equipment: "dumbbell", target_muscle: "triceps", body_part: "arms" },
  { id: "fallback-plank", name: "Plank", equipment: "body weight", target_muscle: "core", body_part: "core" },
  { id: "fallback-deadbug", name: "Dead Bug", equipment: "body weight", target_muscle: "core", body_part: "core" },
];

/**
 * Format the dictionary into a compact prompt-friendly block.
 * Each row is one line: `- <name> [id=<id>] (equipment, target | body_part)`.
 */
export function formatAllowedExerciseDictionary(rows: AllowedExerciseRow[]): string {
  if (rows.length === 0) return "(empty)";
  return rows
    .map((row) => {
      const meta = [row.equipment, row.target_muscle, row.body_part]
        .filter((v) => v && String(v).trim().length > 0)
        .join(" | ");
      return `- ${row.name} [id=${row.id}]${meta ? ` (${meta})` : ""}`;
    })
    .join("\n");
}

/**
 * Resilient RAG fetch used by the planner before plan generation.
 *
 * Behaviour:
 * - Tries Supabase first, optionally filtering by canonical equipment list.
 * - On any error, on empty result, or on missing `gif_path`, falls back to
 *   `FALLBACK_EXERCISE_DICTIONARY` and emits a non-fatal warning.
 * - Never throws — callers can rely on a populated `rows` array.
 */
/**
 * Even the degraded-mode fallback must not hand a bodyweight-only user a
 * barbell program: filter it like the live rows, and only give up on
 * filtering when it would leave too few movements to build a plan from.
 */
function fallbackDictionaryRows(equipment: string[] | null): AllowedExerciseRow[] {
  if (!equipment || equipment.length === 0) return FALLBACK_EXERCISE_DICTIONARY;
  const filtered = filterByAvailableEquipment(FALLBACK_EXERCISE_DICTIONARY, equipment);
  return filtered.length >= 5 ? filtered : FALLBACK_EXERCISE_DICTIONARY;
}

export async function getAllowedExerciseDictionary(options?: {
  equipment?: string[] | null;
  limit?: number;
}): Promise<AllowedExerciseDictionary> {
  const limit = Math.min(Math.max(options?.limit ?? 250, 25), 800);
  const rawEquipment = options?.equipment ?? [];
  const equipmentFilter = Array.isArray(rawEquipment)
    ? rawEquipment
        .map((eq) => String(eq).trim().toLowerCase())
        .filter((eq) => eq.length > 0)
    : [];
  const fallbackRows = fallbackDictionaryRows(
    equipmentFilter.length > 0 ? equipmentFilter : null
  );

  const warnings: string[] = [];

  try {
    let queryBuilder = supabase
      .from("exercises")
      .select("id, name, equipment, equipment_canonical, target_muscle, body_part, gif_path")
      .not("gif_path", "is", null)
      .neq("gif_path", "")
      .limit(limit);

    if (equipmentFilter.length > 0) {
      // Match the CANONICAL bucket (clean, enriched) OR the raw equipment
      // column (legacy rows without enrichment). Matching raw-only silently
      // dropped enriched rows whose dirty raw value ("leverage machine",
      // "assisted", …) never equals a user-facing bucket.
      const buckets = [...toAvailableBuckets(equipmentFilter)];
      const quoted = (vals: string[]) => vals.map((v) => `"${v}"`).join(",");
      queryBuilder = queryBuilder.or(
        `equipment_canonical.in.(${quoted(buckets)}),equipment.in.(${quoted([...new Set([...equipmentFilter, ...buckets])])})`
      );
    }

    const { data, error } = await queryBuilder;

    if (error) {
      warnings.push(
        `getAllowedExerciseDictionary: supabase error (${error.message}); using fallback dictionary.`
      );
      return {
        rows: fallbackRows,
        formatted: formatAllowedExerciseDictionary(fallbackRows),
        source: "fallback",
        warnings,
      };
    }

    const rows: AllowedExerciseRow[] = filterByAvailableEquipment(
      (data ?? [])
        .filter((row: any) => row && row.id && row.name)
        .map((row: any) => ({
          id: String(row.id),
          name: String(row.name),
          equipment: row.equipment ?? null,
          equipment_canonical: row.equipment_canonical ?? null,
          target_muscle: row.target_muscle ?? null,
          body_part: row.body_part ?? null,
        })),
      // Accessory pass: drops bucket-matched rows that still need gear the
      // user doesn't own (bench lifts without a bench, hangs without a bar).
      equipmentFilter.length > 0 ? equipmentFilter : null
    );

    if (rows.length === 0) {
      warnings.push(
        "getAllowedExerciseDictionary: supabase returned 0 rows; using fallback dictionary."
      );
      return {
        rows: fallbackRows,
        formatted: formatAllowedExerciseDictionary(fallbackRows),
        source: "fallback",
        warnings,
      };
    }

    return {
      rows,
      formatted: formatAllowedExerciseDictionary(rows),
      source: "supabase",
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `getAllowedExerciseDictionary: threw (${message}); using fallback dictionary.`
    );
    return {
      rows: fallbackRows,
      formatted: formatAllowedExerciseDictionary(fallbackRows),
      source: "fallback",
      warnings,
    };
  }
}

// ============================================================================
// WORKOUT PLANS
// ============================================================================

/**
 * Get the latest active workout plan for a user
 * Returns plan with extended `days` property for convenience
 */
export async function getLatestPlan(userId: string): Promise<WorkoutPlan | null> {
  // Get the active plan
  const { data: plan, error } = await supabase
    .from("workout_plans")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch latest plan:", error.message);
    return null;
  }

  if (!plan) return null;

  // Get the daily workouts for this plan
  const { data: days, error: daysError } = await supabase
    .from("daily_workouts")
    .select("*")
    .eq("plan_id", plan.id)
    .order("id", { ascending: true });

  if (daysError) {
    console.error("Failed to fetch daily workouts:", daysError.message);
  }

  // Return extended plan with days
  return {
    ...plan,
    days: days || [],
  } as WorkoutPlan;
}

/**
 * Save a new workout plan
 */
export async function saveWorkoutPlan(
  userId: string,
  split: SplitType,
  days: any[],
  goal?: string
): Promise<WorkoutPlan> {
  // Deactivate any existing plans
  await supabase
    .from("workout_plans")
    .update({ is_active: false })
    .eq("user_id", userId);

  // Create new plan
  const { data: plan, error } = await supabase
    .from("workout_plans")
    .insert({
      user_id: userId,
      plan_name: `${split} Plan`,
      is_active: true,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to save workout plan: ${error.message}`);
  }

  // Insert daily workouts
  const preparedDays = days.map((day, idx) => {
    const structured = day.exercises || day.exercises_structured || [];
    return {
      plan_id: plan.id,
      day_of_week: day.dayOfWeek || day.day_of_week || getDayName(idx),
      split_day_name: day.focus || day.split_day_name || "Workout",
      exercises: (day.exercises || []).map((e: any) => typeof e === 'string' ? e : e.name),
      exercises_structured: structured,
      estimated_time:
        day.estimatedTime ||
        day.estimated_time ||
        estimateWorkoutDurationMinutes(structured),
    };
  });

  const { error: daysError } = await supabase
    .from("daily_workouts")
    .insert(preparedDays);

  if (daysError) {
    console.error("Failed to save daily workouts:", daysError.message);
  }

  return {
    ...plan,
    days: preparedDays,
  } as WorkoutPlan;
}

/**
 * Save a quick/replacement workout
 */
export async function saveQuickWorkout(userId: string, workout: any) {
  const { error } = await supabase.from("saved_workouts").insert({
    user_id: userId,
    workout_name: workout.focus || "Quick Workout",
    // Library row; extra_workout is in base schema (not only migration 005)
    workout_type: "extra_workout",
    exercises: (workout.exercises || []).map((e: any) => typeof e === 'string' ? e : e.name),
    exercises_structured: workout.exercises || [],
    estimated_time: workout.estimatedTime || estimateWorkoutDurationMinutes(workout.exercises || []),
    difficulty: "intermediate",
  });

  if (error) {
    console.error("Failed to save quick workout:", error.message);
  }
}

/**
 * Log an adjusted workout
 */
export async function logAdjustedWorkout(userId: string, workout: any) {
  const { error } = await supabase.from("saved_workouts").insert({
    user_id: userId,
    workout_name: workout.focus || "Adjusted Workout",
    workout_type: "replacement_workout",
    exercises: (workout.exercises || []).map((e: any) => typeof e === 'string' ? e : e.name),
    exercises_structured: workout.exercises || [],
    estimated_time: workout.estimatedTime || workout.estimated_time || estimateWorkoutDurationMinutes(workout.exercises || []),
    difficulty: workout.difficulty || "intermediate",
    // The user's LOCAL today (matches WorkoutService.resolveToday's local
    // read). UTC here put the replacement on the wrong day for off-UTC users.
    replacement_date: localTodayInTimezone(await getUserTimezone(userId)),
  });

  if (error) {
    console.error("Failed to persist adjusted workout:", error.message);
  }
}

/**
 * Persist a chat-built one-off workout so it exists beyond the chat card.
 *
 * Placement rule: if TODAY (user's timezone) is a rest day on the active plan,
 * save it as a `replacement_workout` dated today — that's the row
 * WorkoutService.resolveToday reads, so the workout surfaces on the home
 * screen instead of "Rest day". If today already has a scheduled session,
 * save to the library as `extra_workout` so the scheduled workout isn't
 * silently replaced.
 */
export async function persistChatBuiltWorkout(
  userId: string,
  workout: any,
  currentPlan: any | null
): Promise<void> {
  try {
    // The extend tool updates its saved_workouts row in place — inserting
    // again here would duplicate it.
    if (workout?.alreadyPersisted) return;

    const tz = await getUserTimezone(userId);
    const todayDow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(new Date())
      .toLowerCase();

    const days: any[] = currentPlan?.days ?? currentPlan?.daily_workouts ?? [];
    const todayRow = Array.isArray(days)
      ? days.find(
          (d: any) => String(d?.dayOfWeek ?? d?.day_of_week ?? "").toLowerCase() === todayDow
        )
      : undefined;
    const focus = String(todayRow?.focus ?? todayRow?.split_day_name ?? "");
    const scheduled = todayRow?.exercises_structured ?? todayRow?.exercises ?? [];
    const isRestDay =
      !todayRow || /rest/i.test(focus) || !Array.isArray(scheduled) || scheduled.length === 0;

    if (isRestDay) {
      await logAdjustedWorkout(userId, workout);
    } else {
      await saveQuickWorkout(userId, workout);
    }
  } catch (err) {
    // Persistence must never break the chat reply — the card was already
    // delivered over SSE.
    console.error(
      "Failed to persist chat-built workout:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Log a missed day action
 */
export async function logMissedDayAction(userId: string, date: string, preference: string) {
  const { error } = await supabase.from("workout_completions").insert({
    user_id: userId,
    completion_date: date,
    workout_type: "rest",
  });

  if (error) {
    console.error("Failed to log missed day:", error.message);
  }
}

// ============================================================================
// PENDING PLAN EDITS
// ============================================================================

// ============================================================================
// HELPERS
// ============================================================================

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function getDayName(index: number): string {
  return DAY_NAMES[index % 7];
}
