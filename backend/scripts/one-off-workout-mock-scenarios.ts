/**
 * Mock-driven checks for create_one_off_workout exercise resolution (no DB / no OpenAI).
 * Run: npm run test:one-off-mock --prefix backend
 *
 * Scenarios mirror product E2E: complex full-body + equipment, fast abs, impossible equipment.
 */

import type { ExerciseDetail } from "../src/types";
import {
    expandEquipmentFilters,
    type SearchExercisesParams,
    type SearchExercisesResult,
} from "../src/tools/supabaseExerciseSearch";
import {
    isFullBodyIntent,
    resolveExercisesForOneOffWorkout,
} from "../src/tools/oneOffWorkoutSearch";

function mk(
    id: string,
    name: string,
    bodyPart: string,
    equipment: string | null
): ExerciseDetail {
    return {
        id,
        name,
        gif_path: `/gifs/${id}.gif`,
        target_muscle: bodyPart,
        body_part: bodyPart,
        equipment,
        difficulty: "intermediate",
        instructions: null,
        sets: 3,
        reps: "8-12",
        rest_seconds: 90,
    };
}

const DUMMY_LIBRARY: ExerciseDetail[] = [
    mk("d1", "Dumbbell Bench Press", "chest", "dumbbell"),
    mk("d2", "Dumbbell Row", "back", "dumbbell"),
    mk("d3", "Dumbbell Goblet Squat", "legs", "dumbbell"),
    mk("d4", "Dumbbell Russian Twist", "abs", "dumbbell"),
    mk("bw1", "Crunch", "abs", "body weight"),
    mk("bw2", "Plank", "abs", "body weight"),
    mk("bw3", "Leg Raise", "abs", "body weight"),
];

function matchesQuery(e: ExerciseDetail, q: string): boolean {
    const low = q.toLowerCase();
    const bp = (e.body_part || "").toLowerCase();
    const nm = e.name.toLowerCase();
    if (low.includes("chest") || low.includes("press") || low.includes("shoulder")) {
        return bp === "chest" || nm.includes("press");
    }
    if (low.includes("back") || low.includes("row") || low.includes("lat")) {
        return bp === "back";
    }
    if (low.includes("leg") || low.includes("squat") || low.includes("glute") || low.includes("hamstring")) {
        return bp === "legs";
    }
    if (low.includes("abs") || low.includes("core") || low.includes("oblique")) {
        return bp === "abs";
    }
    return true;
}

async function mockSearchLibrary(p: SearchExercisesParams): Promise<SearchExercisesResult> {
    const fe = expandEquipmentFilters(p.filterEquipment);
    let pool = DUMMY_LIBRARY.filter((e) => {
        if (fe?.length && e.equipment && !fe.includes(e.equipment)) {
            return false;
        }
        return matchesQuery(e, p.query);
    });
    if (pool.length === 0) {
        pool = DUMMY_LIBRARY.filter((e) => !fe?.length || !e.equipment || fe.includes(e.equipment));
    }
    return {
        success: pool.length > 0,
        exercises: pool.slice(0, p.matchCount),
    };
}

/** Always empty — simulates no RPC rows for absurd equipment. */
async function mockSearchEmpty(_p: SearchExercisesParams): Promise<SearchExercisesResult> {
    return { success: true, exercises: [] };
}

async function test1ComplexFullBodySuccess() {
    const r = await resolveExercisesForOneOffWorkout(
        {
            targetMuscle: "full body",
            equipment: ["dumbbells"],
            exerciseCount: 5,
        },
        mockSearchLibrary
    );
    if (!r.ok) {
        throw new Error(`Test1 expected ok, got ${JSON.stringify(r)}`);
    }
    if (r.exercises.length < 3) {
        throw new Error(`Test1 expected at least 3 exercises, got ${r.exercises.length}`);
    }
    const regions = new Set(r.exercises.map((e) => e.body_part));
    if (regions.size < 2) {
        throw new Error(`Test1 expected mix of body regions, got ${[...regions].join(",")}`);
    }
    console.log("Test1 (complex full-body + dumbbells):", r.exercises.map((e) => e.name).join(", "));
}

async function test2FastAbsSuccess() {
    const r = await resolveExercisesForOneOffWorkout(
        {
            targetMuscle: "abs",
            equipment: ["body weight"],
            exerciseCount: 3,
        },
        mockSearchLibrary
    );
    if (!r.ok || r.exercises.length < 1) {
        throw new Error(`Test2 expected abs exercises, got ${JSON.stringify(r)}`);
    }
    console.log("Test2 (10 min abs style / fast path data):", r.exercises.map((e) => e.name).join(", "));
}

async function test3ImpossibleConstraints() {
    const r = await resolveExercisesForOneOffWorkout(
        {
            targetMuscle: "trampoline unicycle circuit",
            equipment: ["trampoline", "unicycle"],
            exerciseCount: 5,
        },
        mockSearchEmpty
    );
    if (r.ok) {
        throw new Error("Test3 expected failure");
    }
    console.log("Test3 (impossible equipment): resolver returns controlled failure —", r.error);
}

async function testThinkingStreamContract() {
    /** Emits instantly so wall-clock timing is dominated by frontend MIN_WORKOUT_BUILD_DISPLAY_MS (app). */
    let toolStartTime = 0;
    const fastAbsSearch: typeof mockSearchLibrary = async (p) => {
        toolStartTime = Date.now();
        return mockSearchLibrary(p);
    };
    const t0 = Date.now();
    const r = await resolveExercisesForOneOffWorkout(
        { targetMuscle: "abs", equipment: ["body weight"], exerciseCount: 3 },
        fastAbsSearch
    );
    const dt = Date.now() - t0;
    if (!r.ok) {
        throw new Error("thinking stream contract test failed resolution");
    }
    console.log(
        `Test4 (fast success / timing hook): resolver finished in ${dt}ms (UI should still enforce min build animation in chat.tsx)`
    );
}

async function main() {
    if (!isFullBodyIntent("I want a full-body session")) {
        throw new Error("isFullBodyIntent should detect full-body phrasing");
    }
    await test1ComplexFullBodySuccess();
    await test2FastAbsSuccess();
    await test3ImpossibleConstraints();
    await testThinkingStreamContract();
    console.log("\nAll mock scenario checks passed.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
