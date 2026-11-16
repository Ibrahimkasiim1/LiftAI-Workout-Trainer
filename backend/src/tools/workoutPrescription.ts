/**
 * Workout Prescription Helpers
 *
 * Two concerns the rest of the codebase kept hardcoding:
 *
 *  1. Set/rep/rest prescription. The LLM planner already periodizes by goal, but
 *     every NON-planner path (swaps, quick/one-off workouts, search fallbacks)
 *     stamped a flat `3 × 8-12 @ 90s` regardless of whether the user is chasing
 *     strength, size, or fat loss. `prescriptionForGoal` is the single source of
 *     truth for those fallbacks, using the same goal taxonomy as
 *     `buildAutoRegulationBlock` in plannerGraph.
 *
 *  2. Warmup / cooldown. The library already contains `mobility` and
 *     `stretching` rows that were never surfaced. `fetchWarmup` / `fetchCooldown`
 *     pull a small, region-matched block deterministically (no embeddings) so a
 *     generated day can open with dynamic mobility and close with static
 *     stretches for the muscles it trained.
 */

import { supabase } from "../services/db";

export interface Prescription {
    sets: number;
    reps: string;
    rest_seconds: number;
}

const STRENGTH = /strength|stronger|power/;
const HYPERTROPHY = /muscle|hypertrophy|size|build|gain/;
const FATLOSS = /lose|lean|cut|shred|endurance|tone/;

/**
 * Goal-appropriate default prescription. Mirrors the goal buckets used by the
 * planner's auto-regulation block so fallback paths stay consistent with plans.
 */
export function prescriptionForGoal(
    goal: string | null | undefined,
    fitnessLevel?: string | null | undefined
): Prescription {
    const g = (goal || "").toLowerCase();
    const beginner = (fitnessLevel || "").toLowerCase() === "beginner";

    let rx: Prescription;
    if (STRENGTH.test(g)) {
        rx = { sets: 4, reps: "4-6", rest_seconds: 180 };
    } else if (FATLOSS.test(g)) {
        rx = { sets: 3, reps: "12-15", rest_seconds: 60 };
    } else if (HYPERTROPHY.test(g)) {
        rx = { sets: 4, reps: "8-12", rest_seconds: 90 };
    } else {
        // maintain / unknown
        rx = { sets: 3, reps: "8-12", rest_seconds: 90 };
    }

    // Keep beginner volume conservative regardless of goal.
    if (beginner && rx.sets > 3) rx = { ...rx, sets: 3 };
    return rx;
}

// ============================================================================
// WARMUP / COOLDOWN
// ============================================================================

export type WorkoutPhase = "warmup" | "main" | "cooldown";

export interface PhaseExercise {
    id: string;
    name: string;
    gif_path: string | null;
    target_muscle: string | null;
    body_part: string | null;
    equipment: string | null;
    instructions: string[] | null;
    phase: WorkoutPhase;
    /** Display prescription for a non-loaded movement (e.g. "30-45s"). */
    sets: number;
    reps: string;
    rest_seconds: number;
}

interface RawRow {
    id: string;
    name: string;
    gif_path: string | null;
    target_muscle: string | null;
    body_part: string | null;
    equipment: string | null;
    instructions: string[] | null;
}

/**
 * Map a day focus / muscle token to the source DB `body_part` taxonomy
 * ("upper arms", "upper legs", "waist", ...). Accepts split labels (Push/Pull/
 * Legs) and muscle names; returns the body_part buckets to prefer for matching.
 */
export function focusToBodyParts(focus: string | null | undefined): string[] {
    const f = (focus || "").toLowerCase();
    const out = new Set<string>();
    const add = (...xs: string[]) => xs.forEach((x) => out.add(x));

    if (/push|chest|press|pec/.test(f)) add("chest", "shoulders", "upper arms");
    if (/pull|back|lat|row|bicep/.test(f)) add("back", "upper arms");
    if (/leg|quad|hamstring|glute|squat|lower/.test(f)) add("upper legs", "lower legs");
    if (/shoulder|delt/.test(f)) add("shoulders", "upper arms");
    if (/arm|tricep|bicep/.test(f)) add("upper arms", "lower arms");
    if (/core|ab|waist|oblique/.test(f)) add("waist");
    if (/full|total|whole/.test(f)) add("upper legs", "back", "chest", "waist");

    return [...out];
}

const PHASE_RX: Record<Exclude<WorkoutPhase, "main">, Prescription> = {
    warmup: { sets: 1, reps: "30-45s", rest_seconds: 15 },
    cooldown: { sets: 1, reps: "Hold 30s", rest_seconds: 15 },
};

async function fetchPhase(
    category: "mobility" | "stretching",
    phase: Exclude<WorkoutPhase, "main">,
    bodyParts: string[],
    limit: number
): Promise<PhaseExercise[]> {
    const cols = "id, name, gif_path, target_muscle, body_part, equipment, instructions";

    // Region-matched first; top up with any rows in the category so a thin region
    // (e.g. shoulders has 1 stretch) still yields a usable block.
    const regionQuery = supabase
        .from("exercises")
        .select(cols)
        .eq("category", category)
        .not("gif_path", "is", null)
        .neq("gif_path", "");

    const { data: regionRows } = bodyParts.length
        ? await regionQuery.in("body_part", bodyParts).limit(limit * 2)
        : await regionQuery.limit(limit * 2);

    let rows = (regionRows ?? []) as RawRow[];

    if (rows.length < limit) {
        const { data: anyRows } = await supabase
            .from("exercises")
            .select(cols)
            .eq("category", category)
            .not("gif_path", "is", null)
            .neq("gif_path", "")
            .limit(limit * 3);
        const seen = new Set(rows.map((r) => r.id));
        for (const r of (anyRows ?? []) as RawRow[]) {
            if (rows.length >= limit) break;
            if (!seen.has(r.id)) {
                rows.push(r);
                seen.add(r.id);
            }
        }
    }

    const rx = PHASE_RX[phase];
    return rows.slice(0, limit).map((r) => ({
        id: r.id,
        name: r.name,
        gif_path: r.gif_path,
        target_muscle: r.target_muscle,
        body_part: r.body_part,
        equipment: r.equipment,
        instructions: r.instructions,
        phase,
        ...rx,
    }));
}

/** Dynamic mobility block for the muscles a day will train. */
export function fetchWarmup(focus: string | null | undefined, limit = 3): Promise<PhaseExercise[]> {
    return fetchPhase("mobility", "warmup", focusToBodyParts(focus), limit);
}

/** Static stretch block for the muscles a day just trained. */
export function fetchCooldown(focus: string | null | undefined, limit = 3): Promise<PhaseExercise[]> {
    return fetchPhase("stretching", "cooldown", focusToBodyParts(focus), limit);
}
