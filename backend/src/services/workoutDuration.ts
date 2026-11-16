// Estimate workout duration from actual exercise programming
// (sets, reps, rest_seconds) instead of a flat per-exercise constant.

const SECONDS_PER_REP = 3.5;          // tempo + setup per rep, roughly
const TRANSITION_SECONDS = 60;        // moving between exercises / setup
const WARMUP_SECONDS = 5 * 60;        // global warm-up buffer
const DEFAULT_SETS = 3;
const DEFAULT_REPS = 10;
const DEFAULT_REST = 90;
const MIN_MINUTES = 10;
const MAX_MINUTES = 300;

type ExerciseLike = {
    sets?: number | string | null;
    reps?: number | string | null;
    rest_seconds?: number | string | null;
    restSeconds?: number | string | null;
};

function parseReps(reps: ExerciseLike["reps"]): number {
    if (reps == null) return DEFAULT_REPS;
    if (typeof reps === "number" && Number.isFinite(reps)) return Math.max(1, reps);
    const s = String(reps).trim();
    // Ranges like "8-12" → average; AMRAP/failure → use default
    const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        if (Number.isFinite(lo) && Number.isFinite(hi)) return Math.max(1, Math.round((lo + hi) / 2));
    }
    const single = s.match(/\d+/);
    if (single) return Math.max(1, Number(single[0]));
    return DEFAULT_REPS;
}

function num(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Returns an estimated total session duration in whole minutes.
 * Per exercise: sets × (reps × tempo + rest) − one rest (last set has no rest)
 * Plus a transition between exercises and a global warm-up buffer.
 */
export function estimateWorkoutDurationMinutes(exercises: ExerciseLike[] | null | undefined): number {
    if (!Array.isArray(exercises) || exercises.length === 0) return MIN_MINUTES;

    let totalSeconds = WARMUP_SECONDS;
    for (const ex of exercises) {
        const sets = num(ex.sets, DEFAULT_SETS);
        const reps = parseReps(ex.reps);
        const rest = num(ex.rest_seconds ?? ex.restSeconds, DEFAULT_REST);
        const setSeconds = reps * SECONDS_PER_REP;
        // sets working time + rest between sets (one fewer rest than sets)
        const exerciseSeconds = sets * setSeconds + Math.max(0, sets - 1) * rest;
        totalSeconds += exerciseSeconds + TRANSITION_SECONDS;
    }

    const minutes = Math.round(totalSeconds / 60);
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
}
