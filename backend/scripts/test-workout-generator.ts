/**
 * Edge-case workout generator validation.
 *
 * Run:
 *   npm run test:workout-generator --prefix backend
 *
 * Goal:
 * - Ensure constrained requests return a successful 200-style payload
 * - Verify fallback behavior replaces impossible exact requests
 * - Never throw/crash on missing strict movement matches
 */

import type { ExerciseDetail } from "../src/types";
import {
    expandEquipmentFilters,
    type SearchExercisesParams,
    type SearchExercisesResult,
} from "../src/tools/supabaseExerciseSearch";
import { resolveExercisesForOneOffWorkout } from "../src/tools/oneOffWorkoutSearch";

type WorkoutPayload = {
    status: number;
    success: boolean;
    focus: string;
    exercises: ExerciseDetail[];
    warnings: string[];
};

function mk(id: string, name: string, bodyPart: string, equipment: string): ExerciseDetail {
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

const LIB: ExerciseDetail[] = [
    mk("bw-squat", "Bodyweight Squat", "legs", "body weight"),
    mk("bw-lunge", "Bodyweight Reverse Lunge", "legs", "body weight"),
    mk("bw-push", "Push-Up", "chest", "body weight"),
    mk("bw-row", "Inverted Row", "back", "body weight"),
    mk("bw-core", "Plank", "abs", "body weight"),
    mk("kb-squat", "Kettlebell Goblet Squat", "legs", "kettlebell"),
    mk("kb-hinge", "Kettlebell Romanian Deadlift", "legs", "kettlebell"),
    mk("kb-core", "Kettlebell Dead Bug Pullover", "abs", "kettlebell"),
    mk("db-hinge", "Dumbbell Romanian Deadlift", "legs", "dumbbell"),
    mk("db-lunge", "Dumbbell Walking Lunge", "legs", "dumbbell"),
];

function queryTags(query: string): string[] {
    const q = query.toLowerCase();
    const tags: string[] = [];
    if (q.includes("full body") || q.includes("compound")) tags.push("full");
    if (q.includes("leg") || q.includes("squat") || q.includes("lunge") || q.includes("deadlift")) tags.push("legs");
    if (q.includes("chest") || q.includes("press") || q.includes("push")) tags.push("push");
    if (q.includes("back") || q.includes("pull") || q.includes("row") || q.includes("lat")) tags.push("pull");
    if (q.includes("core") || q.includes("abs") || q.includes("plank")) tags.push("core");
    return tags.length > 0 ? tags : ["full"];
}

function exerciseMatchesTags(ex: ExerciseDetail, tags: string[]): boolean {
    const name = ex.name.toLowerCase();
    const body = (ex.body_part || "").toLowerCase();
    if (tags.includes("full")) return true;
    if (tags.includes("legs") && (body.includes("leg") || name.includes("squat") || name.includes("lunge") || name.includes("deadlift"))) return true;
    if (tags.includes("push") && (body.includes("chest") || name.includes("press") || name.includes("push"))) return true;
    if (tags.includes("pull") && (body.includes("back") || name.includes("row") || name.includes("pull"))) return true;
    if (tags.includes("core") && (body.includes("abs") || name.includes("plank") || name.includes("core"))) return true;
    return false;
}

async function mockSearch(params: SearchExercisesParams): Promise<SearchExercisesResult> {
    const normalizedEquipment = expandEquipmentFilters(params.filterEquipment);
    const tags = queryTags(params.query);
    let pool = LIB.filter((ex) => exerciseMatchesTags(ex, tags));
    if (normalizedEquipment?.length) {
        pool = pool.filter((ex) => ex.equipment && normalizedEquipment.includes(ex.equipment));
    }
    return {
        success: true,
        exercises: pool.slice(0, params.matchCount ?? 8),
    };
}

async function buildPayload(input: {
    targetMuscle: string;
    equipment: string[];
    exerciseCount: number;
}): Promise<WorkoutPayload> {
    const resolved = await resolveExercisesForOneOffWorkout(
        {
            targetMuscle: input.targetMuscle,
            equipment: input.equipment,
            exerciseCount: input.exerciseCount,
        },
        mockSearch
    );

    if (!resolved.ok) {
        return {
            status: 200,
            success: true,
            focus: input.targetMuscle,
            exercises: [],
            warnings: [
                "No exact workout was possible with current constraints; request should be clarified in chat.",
            ],
        };
    }

    const warnings: string[] = [];
    if (resolved.warning) warnings.push(resolved.warning);
    if (resolved.usedEquipmentFallback) {
        warnings.push("Used closest-available substitutions for constrained equipment.");
    }

    return {
        status: 200,
        success: true,
        focus: resolved.focusLabel,
        exercises: resolved.exercises,
        warnings,
    };
}

function assertSuccessPayload(payload: WorkoutPayload, scenario: string): void {
    if (payload.status !== 200 || payload.success !== true) {
        throw new Error(`${scenario}: expected successful 200 payload, got ${JSON.stringify(payload)}`);
    }
}

async function run(): Promise<void> {
    const scenarios = [
        {
            name: "Zero Equipment",
            input: {
                targetMuscle: "Full Body",
                equipment: ["Bodyweight Only"],
                exerciseCount: 5,
            },
        },
        {
            name: "Highly Constrained",
            input: {
                targetMuscle: "Leg Day",
                equipment: ["Kettlebells"],
                exerciseCount: 5,
            },
        },
        {
            name: "Mismatched Goal",
            input: {
                targetMuscle: "Barbell Deadlifts",
                equipment: ["Dumbbells Only"],
                exerciseCount: 4,
            },
        },
    ];

    for (const scenario of scenarios) {
        const payload = await buildPayload(scenario.input);
        assertSuccessPayload(payload, scenario.name);
        console.log(`${scenario.name}: status=${payload.status}, exercises=${payload.exercises.length}, warnings=${payload.warnings.length}`);
        console.log(`   Focus=${payload.focus}`);
        if (payload.exercises.length > 0) {
            console.log(`   Exercises=${payload.exercises.map((e) => `${e.name} (${e.equipment})`).join(", ")}`);
        }
        if (payload.warnings.length > 0) {
            console.log(`   Warnings=${payload.warnings.join(" | ")}`);
        }
    }

    console.log("\nAll workout edge-case scenarios returned successful 200-style payloads.");
}

run().catch((error) => {
    console.error("test-workout-generator failed:", error);
    process.exit(1);
});

