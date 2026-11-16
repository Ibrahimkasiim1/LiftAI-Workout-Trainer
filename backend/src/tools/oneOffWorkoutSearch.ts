/**
 * Exercise selection for create_one_off_workout: full-body regional assembly,
 * equipment-aware queries, and fallbacks when strict filters return nothing.
 *
 * Logic improvements layered on top of the search:
 *   - Recent-fatigue avoidance: when `userId` is provided, exercises the user
 *     completed within the last `RECENT_FATIGUE_DAYS` days are pushed to the
 *     back of the candidate pool. They're only included if needed to hit the
 *     requested count, which prevents "you just did this 3 days running"
 *     degenerate cases without starving the workout when the library is thin.
 */

import type { ExerciseDetail } from "../types";
import { supabase } from "../services/db";
import { filterByAvailableEquipment } from "../services/equipmentAvailability";
import { filterExercisesByInjury } from "../services/injuryFiltering";
import {
    searchExercises,
    type SearchExercisesParams,
    type SearchExercisesResult,
} from "./supabaseExerciseSearch";

const RECENT_FATIGUE_DAYS = 3;

/**
 * Pull the set of exercise ids the user has completed in the last N days.
 * Returns an empty Set on any failure — recent-fatigue avoidance is an
 * optimization, never a hard requirement.
 */
async function getRecentlyCompletedExerciseIds(
    userId: string,
    days = RECENT_FATIGUE_DAYS
): Promise<Set<string>> {
    try {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const { data, error } = await supabase
            .from("exercise_performance")
            .select("exercise_id")
            .eq("user_id", userId)
            .gte("workout_date", since.toISOString())
            .limit(200);
        if (error) {
            console.warn("[oneOffWorkoutSearch] recent-fatigue lookup failed:", error.message);
            return new Set();
        }
        const ids = new Set<string>();
        for (const row of data ?? []) {
            const id = String((row as { exercise_id?: unknown }).exercise_id ?? "");
            if (id) ids.add(id);
        }
        return ids;
    } catch (err) {
        console.warn("[oneOffWorkoutSearch] recent-fatigue lookup threw:", err);
        return new Set();
    }
}

/**
 * Reorder a candidate pool: fresh exercises first (ones not in
 * `recentlyCompleted`), recent-fatigue ones at the back. We don't drop the
 * latter outright so that the library's small surface still produces a
 * full workout — they're a fallback, not a ban.
 */
function biasAgainstRecentFatigue(
    pool: ExerciseDetail[],
    recentlyCompleted: Set<string>
): ExerciseDetail[] {
    if (recentlyCompleted.size === 0) return pool;
    const fresh: ExerciseDetail[] = [];
    const stale: ExerciseDetail[] = [];
    for (const ex of pool) {
        if (ex.id && recentlyCompleted.has(String(ex.id))) {
            stale.push(ex);
        } else {
            fresh.push(ex);
        }
    }
    return [...fresh, ...stale];
}

export type OneOffSearchFn = (params: SearchExercisesParams) => Promise<SearchExercisesResult>;

export function isFullBodyIntent(targetMuscle: string): boolean {
    const t = targetMuscle.toLowerCase();
    return (
        /\bfull[\s_-]?body\b/.test(t) ||
        /\btotal\s+body\b/.test(t) ||
        /\bwhole\s+body\b/.test(t) ||
        /\bentire\s+body\b/.test(t)
    );
}

function dedupeById(list: ExerciseDetail[]): ExerciseDetail[] {
    const seen = new Set<string>();
    const out: ExerciseDetail[] = [];
    for (const ex of list) {
        if (!ex?.id || seen.has(ex.id)) continue;
        seen.add(ex.id);
        out.push(ex);
    }
    return out;
}

function hasValidGif(ex: ExerciseDetail): boolean {
    return Boolean(ex.id && ex.gif_path && ex.gif_path !== "");
}

function filterAvoid(exercises: ExerciseDetail[], avoidBodyParts?: string[]): ExerciseDetail[] {
    if (!avoidBodyParts?.length) return exercises;
    return exercises.filter((ex) => {
        const targets = [ex.body_part?.toLowerCase(), ex.target_muscle?.toLowerCase()].filter(Boolean);
        return !avoidBodyParts.some((injury) =>
            targets.some((target) => target?.includes(injury.toLowerCase()))
        );
    });
}

function equipmentHint(eq: string[] | undefined): string {
    if (!eq?.length) return "";
    const e = eq.map((x) => x.toLowerCase());
    if (e.includes("dumbbell")) return "dumbbell ";
    if (e.includes("body weight")) return "bodyweight ";
    if (e.includes("barbell")) return "barbell ";
    if (e.includes("cable")) return "cable ";
    if (e.includes("kettlebell")) return "kettlebell ";
    if (e.includes("band")) return "band ";
    return "";
}

function allocateRegionalSlots(n: number): { push: number; pull: number; lower: number; core: number } {
    if (n <= 3) return { push: 1, pull: 1, lower: 1, core: 0 };
    if (n === 4) return { push: 1, pull: 1, lower: 1, core: 1 };
    if (n === 5) return { push: 2, pull: 1, lower: 1, core: 1 };
    if (n === 6) return { push: 2, pull: 1, lower: 2, core: 1 };
    if (n === 7) return { push: 2, pull: 2, lower: 2, core: 1 };
    return { push: 2, pull: 2, lower: 3, core: 1 };
}

async function searchPool(
    searchFn: OneOffSearchFn,
    query: string,
    matchCount: number,
    filterEquipment?: string[]
): Promise<ExerciseDetail[]> {
    // ONE call, no threshold ladder. This used to fire the same search up to
    // three times with descending matchThreshold values — but the threshold
    // was never forwarded to the RPC, so the calls were byte-identical: pure
    // wasted embedding + RPC latency. The RPC already orders by hybrid score,
    // so a single unthresholded call returns the same pool the old code did.
    const r = await searchFn({ query, matchCount, filterEquipment });
    return r.success ? r.exercises : [];
}

async function gatherFullBody(
    searchFn: OneOffSearchFn,
    exerciseCount: number,
    filterEquipment: string[] | undefined,
    avoidBodyParts: string[] | undefined
): Promise<ExerciseDetail[]> {
    const hint = equipmentHint(filterEquipment).trim();
    const hintPrefix = hint ? `${hint} ` : "";
    const slots = allocateRegionalSlots(exerciseCount);
    const pad = 4;

    const [pushPool, pullPool, lowerPool, corePool] = await Promise.all([
        searchPool(
            searchFn,
            `${hintPrefix}chest shoulders pressing compound strength`.trim(),
            slots.push + pad,
            filterEquipment
        ),
        searchPool(
            searchFn,
            `${hintPrefix}back lats rowing pulling compound`.trim(),
            slots.pull + pad,
            filterEquipment
        ),
        searchPool(
            searchFn,
            `${hintPrefix}legs quadriceps hamstrings glutes squat hinge`.trim(),
            slots.lower + pad,
            filterEquipment
        ),
        slots.core > 0
            ? searchPool(
                  searchFn,
                  `${hintPrefix}abs core obliques`.trim(),
                  slots.core + pad,
                  filterEquipment
              )
            : Promise.resolve([]),
    ]);

    const pick = (pool: ExerciseDetail[], n: number) =>
        dedupeById(filterAvoid(pool.filter(hasValidGif), avoidBodyParts)).slice(0, n);

    let chosen: ExerciseDetail[] = [
        ...pick(pushPool, slots.push),
        ...pick(pullPool, slots.pull),
        ...pick(lowerPool, slots.lower),
        ...pick(corePool, slots.core),
    ];
    chosen = dedupeById(chosen);

    if (chosen.length >= exerciseCount) {
        return chosen.slice(0, exerciseCount);
    }

    const combined = dedupeById(
        filterAvoid([...pushPool, ...pullPool, ...lowerPool, ...corePool].filter(hasValidGif), avoidBodyParts)
    );
    for (const ex of combined) {
        if (chosen.length >= exerciseCount) break;
        if (!chosen.some((c) => c.id === ex.id)) chosen.push(ex);
    }

    return dedupeById(chosen).slice(0, exerciseCount);
}

async function gatherSingleFocus(
    searchFn: OneOffSearchFn,
    targetMuscle: string,
    exerciseCount: number,
    filterEquipment?: string[],
    avoidBodyParts?: string[]
): Promise<ExerciseDetail[]> {
    // Progressive query WIDENING (different query text per step, only when the
    // pool is still short). No matchThreshold: the historical ladder values
    // (0.48/0.32/0.22) were never actually applied — they were tuned for a
    // pure-vector score scale and would over-filter today's hybrid scores.
    const r1 = await searchFn({
        query: targetMuscle,
        matchCount: exerciseCount + 8,
        filterEquipment,
    });
    let pool = r1.success ? r1.exercises : [];
    if (pool.length < exerciseCount) {
        const r2 = await searchFn({
            query: `${targetMuscle} strength training exercises`,
            matchCount: exerciseCount + 10,
            filterEquipment,
        });
        if (r2.success) pool = dedupeById([...pool, ...r2.exercises]);
    }
    if (pool.length < exerciseCount) {
        const r3 = await searchFn({
            query: `${targetMuscle} gym exercises`,
            matchCount: exerciseCount + 10,
            filterEquipment,
        });
        if (r3.success) pool = dedupeById([...pool, ...r3.exercises]);
    }
    pool = filterAvoid(pool.filter(hasValidGif), avoidBodyParts);
    return dedupeById(pool).slice(0, exerciseCount);
}

async function topUpWithoutEquipmentFilter(
    searchFn: OneOffSearchFn,
    query: string,
    need: number,
    avoidBodyParts?: string[]
): Promise<ExerciseDetail[]> {
    const r = await searchFn({
        query,
        matchCount: need + 10,
        filterEquipment: undefined,
    });
    if (!r.success) return [];
    return filterAvoid(r.exercises.filter(hasValidGif), avoidBodyParts).slice(0, need);
}

export type OneOffResolveOk = {
    ok: true;
    exercises: ExerciseDetail[];
    usedEquipmentFallback: boolean;
    focusLabel: string;
    warning?: string;
    missingSlots?: number;
};

export type OneOffResolveErr = { ok: false; error: string };

export async function resolveExercisesForOneOffWorkout(
    params: {
        targetMuscle: string;
        equipment?: string[];
        exerciseCount: number;
        avoidBodyParts?: string[];
        /**
         * When provided, exercises completed by this user in the last
         * RECENT_FATIGUE_DAYS days are demoted to the back of each pool so
         * the workout doesn't repeat what they just did. Optional — recent
         * fatigue avoidance is best-effort, not required.
         */
        userId?: string;
        /**
         * Exercise names to exclude — learned soft avoidances from repeated
         * swaps. Best-effort: dropped if honoring them would empty the pool.
         */
        avoidExerciseNames?: string[];
        /**
         * The user's saved equipment. Every candidate pool — including the
         * widened no-filter fallback — is checked against it, so a workout can
         * never contain gear the user doesn't own (bench, bar, machines, …).
         */
        availableEquipment?: string[] | null;
        /** Free-text injuries from the profile; hard-contraindicated names are excluded. */
        injuries?: string | null;
    },
    searchFn: OneOffSearchFn = searchExercises
): Promise<OneOffResolveOk | OneOffResolveErr> {
    const {
        targetMuscle, equipment, exerciseCount, avoidBodyParts, userId,
        avoidExerciseNames, availableEquipment, injuries,
    } = params;
    const filterEquipment = equipment?.length ? equipment : undefined;

    // Safety pass applied to every pool: what the user can actually use +
    // what their injuries allow. Explicit request equipment wins (it's the
    // CURRENT context — "hotel workout, bands only"); the saved profile is
    // the deterministic fallback when the model passes nothing.
    const safetyEquipment =
        filterEquipment ??
        (availableEquipment && availableEquipment.length > 0 ? availableEquipment : null);
    const applySafety = (list: ExerciseDetail[]): ExerciseDetail[] =>
        filterExercisesByInjury(
            filterByAvailableEquipment(list, safetyEquipment),
            injuries ?? null
        );

    // Case-insensitive avoidance predicate (soft preference, not a hard filter).
    const avoidNameSet = new Set((avoidExerciseNames ?? []).map((n) => n.toLowerCase().trim()).filter(Boolean));
    const notAvoided = (ex: ExerciseDetail) =>
        avoidNameSet.size === 0 || !avoidNameSet.has((ex.name ?? "").toLowerCase().trim());

    let usedEquipmentFallback = false;
    const fullBody = isFullBodyIntent(targetMuscle);
    const focusLabel = fullBody ? "Full-body strength" : `${targetMuscle.charAt(0).toUpperCase() + targetMuscle.slice(1)}`;

    // Fire the recent-fatigue lookup in parallel with the first pool gather
    // so it adds zero latency on the happy path.
    const [recentlyCompleted, rawInitialPool] = await Promise.all([
        userId ? getRecentlyCompletedExerciseIds(userId) : Promise.resolve(new Set<string>()),
        fullBody
            ? gatherFullBody(searchFn, exerciseCount, filterEquipment, avoidBodyParts)
            : gatherSingleFocus(searchFn, targetMuscle, exerciseCount, filterEquipment, avoidBodyParts),
    ]);
    const initialPool = applySafety(rawInitialPool);

    let chosen: ExerciseDetail[] = biasAgainstRecentFatigue(initialPool.filter(notAvoided), recentlyCompleted);
    // If avoidances emptied the pool, fall back to the unfiltered pool rather
    // than returning nothing (soft preference must never block a workout).
    if (chosen.length === 0 && initialPool.length > 0) {
        chosen = biasAgainstRecentFatigue(initialPool, recentlyCompleted);
    }

    // Prefer same-equipment "closest possible" results before widening constraints.
    if (chosen.length < exerciseCount) {
        const strictTopUp = await searchFn({
            query: fullBody ? "compound strength training exercises" : `${targetMuscle} training exercises`,
            matchCount: exerciseCount - chosen.length + 8,
            filterEquipment,
        });
        if (strictTopUp.success && strictTopUp.exercises.length > 0) {
            const filtered = applySafety(
                filterAvoid(strictTopUp.exercises.filter(hasValidGif), avoidBodyParts)
            ).filter(notAvoided);
            const reordered = biasAgainstRecentFatigue(filtered, recentlyCompleted);
            const mergedStrict = dedupeById([...chosen, ...reordered]);
            if (mergedStrict.length > chosen.length) usedEquipmentFallback = true;
            chosen = mergedStrict.slice(0, exerciseCount);
        }
    }

    // Only widen beyond the model's narrow search filter when we have zero
    // feasible movements — and even then, the widened pool still passes the
    // safety filter: "no matches" must never mean "hand them gear they lack".
    if (chosen.length < exerciseCount && chosen.length === 0) {
        const broader = await topUpWithoutEquipmentFilter(
            searchFn,
            fullBody ? "compound strength training exercises" : `${targetMuscle} exercises`,
            exerciseCount - chosen.length + 8,
            avoidBodyParts
        );
        const merged = dedupeById([...chosen, ...applySafety(broader)]);
        if (merged.length > chosen.length) usedEquipmentFallback = true;
        chosen = merged.slice(0, exerciseCount);
    }

    if (chosen.length === 0) {
        return { ok: false, error: "no_exercises_in_library" };
    }

    const missingSlots = Math.max(0, exerciseCount - chosen.length);
    const warning =
        missingSlots > 0
            ? `Could only build ${chosen.length} of ${exerciseCount} requested exercises with available constraints.`
            : undefined;

    return {
        ok: true,
        exercises: chosen,
        usedEquipmentFallback,
        focusLabel,
        warning,
        missingSlots: missingSlots > 0 ? missingSlots : undefined,
    };
}
