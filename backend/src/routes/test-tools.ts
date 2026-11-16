/**
 * Tool Testing Route
 * 
 * Endpoint to verify all tools work correctly
 */

import { Router } from "express";
import {
    addToTodaysWorkoutTool,
    createTemporaryOverrideTool,
    getActiveUserContextTool,
    searchExercisesTool,
} from "../agents/tools";
import { supabase } from "../services/db";

const router = Router();

function parseSearchResult(raw: unknown): { exercises: Array<{ id: string }>; success: boolean } {
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return { success: parsed.length > 0, exercises: parsed as Array<{ id: string }> };
            }
        } catch {
            return { success: false, exercises: [] };
        }
        return { success: false, exercises: [] };
    }

    if (raw && typeof raw === "object") {
        const obj = raw as { success?: boolean; exercises?: Array<{ id: string }> };
        return {
            success: obj.success !== false,
            exercises: Array.isArray(obj.exercises) ? obj.exercises : [],
        };
    }

    return { success: false, exercises: [] };
}

router.post("/test-tools", async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "userId required" });
    }

    const results: any = {
        timestamp: new Date().toISOString(),
        tests: [],
    };

    console.log("Testing all tools...");

    // Test 1: Get User Context
    try {
        console.log("\n1️⃣ Testing get_active_user_context...");
        const context = await getActiveUserContextTool.invoke({ userId });
        results.tests.push({
            tool: "get_active_user_context",
            status: context.success !== false ? "PASS" : "FAIL",
            result: context,
        });
    } catch (error) {
        results.tests.push({
            tool: "get_active_user_context",
            status: "ERROR",
            error: String(error),
        });
    }

    // Test 2: Search Exercises (body weight)
    try {
        console.log("\n2️⃣ Testing search_exercises (body weight)...");
        const search = await searchExercisesTool.invoke({
            query: "abs exercises",
            equipment: ["body weight"],
            count: 3,
        });
        const parsed = parseSearchResult(search);
        results.tests.push({
            tool: "search_exercises (body weight)",
            status: parsed.success ? "PASS" : "FAIL",
            exercisesFound: parsed.exercises.length || 0,
            result: search,
        });
    } catch (error) {
        results.tests.push({
            tool: "search_exercises (body weight)",
            status: "ERROR",
            error: String(error),
        });
    }

    // Test 3: Search Exercises (dumbbell)
    try {
        console.log("\n3️⃣ Testing search_exercises (dumbbell)...");
        const search = await searchExercisesTool.invoke({
            query: "chest exercises",
            equipment: ["dumbbell"],
            count: 3,
        });
        const parsed = parseSearchResult(search);
        results.tests.push({
            tool: "search_exercises (dumbbell)",
            status: parsed.success ? "PASS" : "FAIL",
            exercisesFound: parsed.exercises.length || 0,
            result: search,
        });
    } catch (error) {
        results.tests.push({
            tool: "search_exercises (dumbbell)",
            status: "ERROR",
            error: String(error),
        });
    }

    // Test 4: Create Temporary Override
    try {
        console.log("\n4️⃣ Testing create_temporary_override...");
        const override = await createTemporaryOverrideTool.invoke({
            userId,
            reason: "test shoulder accommodation",
            durationWeeks: 1,
            overrideType: "injury_accommodation",
            modifications: {
                avoidBodyParts: ["shoulders"],
            },
        });
        results.tests.push({
            tool: "create_temporary_override",
            status: override.success ? "PASS" : "FAIL",
            result: override,
        });
    } catch (error) {
        results.tests.push({
            tool: "create_temporary_override",
            status: "ERROR",
            error: String(error),
        });
    }

    // Test 5: Add to Today's Workout
    try {
        console.log("\n5️⃣ Testing add_to_todays_workout...");
        const search = await searchExercisesTool.invoke({
            query: "crunches",
            count: 2,
        });
        const parsed = parseSearchResult(search);
        const exerciseIds = Array.isArray(parsed.exercises)
            ? parsed.exercises.slice(0, 2).map((ex: { id: string }) => ({
                  exercise_id: ex.id,
              }))
            : [];
        const addExercises = await addToTodaysWorkoutTool.invoke({
            userId,
            exercises: exerciseIds,
        });
        results.tests.push({
            tool: "add_to_todays_workout",
            status: addExercises.success ? "PASS" : "FAIL",
            addedCount: addExercises.addedExercises?.length || 0,
            result: addExercises,
        });
    } catch (error) {
        results.tests.push({
            tool: "add_to_todays_workout",
            status: "ERROR",
            error: String(error),
        });
    }

    // Summary
    const passed = results.tests.filter((t: any) => t.status.includes("PASS")).length;
    const failed = results.tests.filter((t: any) => !t.status.includes("PASS")).length;

    results.summary = {
        total: results.tests.length,
        passed,
        failed,
        passRate: `${((passed / results.tests.length) * 100).toFixed(1)}%`,
    };

    console.log("\nTest Summary:");
    console.log(`   Total: ${results.summary.total}`);
    console.log(`   Passed: ${passed}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Pass Rate: ${results.summary.passRate}`);

    res.json(results);
});

router.get("/debug-plan/:userId", async (req, res) => {
    const { userId } = req.params;

    console.log(`Debugging plan for user: ${userId}`);

    // Get active plan
    const { data: plan, error: planError } = await supabase
        .from("workout_plans")
        .select("*, daily_workouts(*)")
        .eq("user_id", userId)
        .eq("is_active", true)
        .single();

    if (planError) {
        return res.json({
            error: planError.message,
            hasPlan: false,
        });
    }

    if (!plan) {
        return res.json({
            hasPlan: false,
            message: "No active plan found",
        });
    }

    // Analyze the plan
    const analysis: any = {
        hasPlan: true,
        planId: plan.id,
        planName: plan.plan_name,
        daysCount: plan.daily_workouts?.length || 0,
        days: plan.daily_workouts?.map((day: any) => ({
            dayOfWeek: day.day_of_week,
            splitDayName: day.split_day_name,
            exercisesCount: day.exercises_structured?.length || 0,
            hasStructuredExercises: !!day.exercises_structured,
            exercises: day.exercises_structured?.map((ex: any) => ({
                name: ex.name,
                bodyPart: ex.body_part,
                targetMuscle: ex.target_muscle,
                equipment: ex.equipment,
            })) || [],
        })) || [],
    };

    // Check for shoulder exercises
    const shoulderExercises: any[] = [];
    plan.daily_workouts?.forEach((day: any) => {
        day.exercises_structured?.forEach((ex: any) => {
            if (
                ex.body_part?.toLowerCase().includes("shoulder") ||
                ex.target_muscle?.toLowerCase().includes("shoulder") ||
                ex.body_part?.toLowerCase() === "shoulders"
            ) {
                shoulderExercises.push({
                    day: day.day_of_week,
                    exercise: ex.name,
                    bodyPart: ex.body_part,
                    targetMuscle: ex.target_muscle,
                });
            }
        });
    });

    analysis.shoulderExercises = shoulderExercises;
    analysis.hasShoulderExercises = shoulderExercises.length > 0;

    res.json(analysis);
});

export default router;
