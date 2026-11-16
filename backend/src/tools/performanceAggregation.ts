/**
 * Helpers for reading the `exercise_performance` table.
 *
 * `exercise_performance` is a per-SET log (one row per completed set). Coaching
 * answers and history tools want per-(exercise, day) sessions, so this module
 * collapses raw set rows into representative sessions. Kept dependency-free so
 * both `agents/tools.ts` and `tools/analystActions.ts` can import it without a
 * circular dependency.
 */

export interface PerformanceSession {
    exerciseId: string | null;
    exerciseName: string;
    sets: number;
    reps: number; // representative (top set) reps
    weight: number; // representative (top set) weight
    completedAt: string | null;
}

export interface ExercisePerformanceRow {
    exercise_id?: unknown;
    exercise_name?: unknown;
    set_number?: unknown;
    reps_completed?: unknown;
    weight_used?: unknown;
    workout_date?: unknown;
}

export function aggregateExercisePerformanceRows(
    rows: ExercisePerformanceRow[]
): PerformanceSession[] {
    const buckets = new Map<
        string,
        {
            exerciseId: string | null;
            exerciseName: string;
            completedAt: string | null;
            sets: number;
            topWeight: number;
            topReps: number;
        }
    >();

    for (const row of rows) {
        const exerciseId = row.exercise_id != null ? String(row.exercise_id) : null;
        const exerciseName = String(row.exercise_name ?? "Exercise");
        const workoutDate = row.workout_date != null ? String(row.workout_date) : null;
        const dayKey = workoutDate ? workoutDate.slice(0, 10) : "unknown";
        const key = `${exerciseId ?? exerciseName}__${dayKey}`;

        const weight = Number(row.weight_used) || 0;
        const reps = Number(row.reps_completed) || 0;

        const prev = buckets.get(key);
        if (!prev) {
            buckets.set(key, {
                exerciseId,
                exerciseName,
                completedAt: workoutDate,
                sets: 1,
                topWeight: weight,
                topReps: reps,
            });
        } else {
            prev.sets += 1;
            // Track the heaviest set as the representative effort for the session.
            if (weight > prev.topWeight || (weight === prev.topWeight && reps > prev.topReps)) {
                prev.topWeight = weight;
                prev.topReps = reps;
            }
        }
    }

    return Array.from(buckets.values())
        .sort((a, b) => String(b.completedAt ?? "").localeCompare(String(a.completedAt ?? "")))
        .map((b) => ({
            exerciseId: b.exerciseId,
            exerciseName: b.exerciseName,
            sets: b.sets,
            reps: b.topReps,
            weight: b.topWeight,
            completedAt: b.completedAt,
        }));
}
