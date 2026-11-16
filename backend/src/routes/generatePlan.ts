/**
 * Plan Generation Route - ONBOARDING ONLY
 * 
 * This endpoint is ONLY called during onboarding to create the initial workout plan.
 * It uses the plannerGraph to generate a complete plan with exercises.
 */

import { Request, Response, Router } from "express";
import { LangChainCallbackHandler } from "@posthog/ai";
import { plannerGraph } from "../graph/plannerGraph";
import type { AuthedRequest } from "../middleware/auth";
import {
    getInitialPlanGenerationState,
    getLatestPlan,
    getUserProfile,
    setInitialPlanGenerationState,
} from "../services/db";
import { phClient } from "../services/posthog";
import { estimateWorkoutDurationMinutes } from "../services/workoutDuration";
import type { UserProfile } from "../types";

const router = Router();
const PLAN_GENERATION_RUNNING_TTL_MS = 45 * 60 * 1000;

function isSyntheticPlanUser(userId: string): boolean {
    return (
        userId.startsWith("test-") ||
        userId.startsWith("mock-") ||
        userId.startsWith("demo-")
    );
}

function countExercises(plan: any): number {
    return (plan?.days || []).reduce((sum: number, day: any) => {
        return sum + (day.exercises_structured?.length || 0);
    }, 0);
}

function isGenerationStillFresh(startedAt: string | null): boolean {
    if (!startedAt) return false;
    const startedMs = Date.parse(startedAt);
    if (Number.isNaN(startedMs)) return false;
    return Date.now() - startedMs < PLAN_GENERATION_RUNNING_TTL_MS;
}

/**
 * POST /api/generate-plan
 * 
 * Generates an initial workout plan for a user based on their profile.
 * This is called during onboarding after the user completes their profile.
 * 
 * IMPORTANT: This uses the LangGraph planner to generate exercises.
 */
router.post("/api/generate-plan", async (req: Request, res: Response) => {
    let userId = "";
    let syntheticUser = false;
    try {
        userId = (req as AuthedRequest).user.id;
        syntheticUser = isSyntheticPlanUser(userId);

        console.log(`[ONBOARDING] Generating workout plan for user: ${userId}`);

        let profile: UserProfile | null = null;

        if (syntheticUser) {
            console.log(`Synthetic user — profile is supplied by planner graph (no DB row)`);
        } else {
            profile = await getUserProfile(userId);

            if (!profile) {
                return res.status(404).json({
                    success: false,
                    error: "User profile not found. Please complete onboarding first."
                });
            }

            if (!profile.workout_split_type || !profile.workout_days_per_week) {
                return res.status(400).json({
                    success: false,
                    error: "Incomplete profile. Please complete all onboarding steps."
                });
            }

            console.log(`User profile: ${profile.fitness_level}, ${profile.workout_days_per_week} days/week, ${profile.workout_split_type} split`);
        }

        const existingPlan = await getLatestPlan(userId);
        const existingPlanExerciseCount = countExercises(existingPlan);
        if (existingPlan && existingPlanExerciseCount > 0) {
            if (!syntheticUser) {
                await setInitialPlanGenerationState(userId, "idle", null);
            }
            console.log(`[ONBOARDING] Returning existing active plan for user: ${userId}`);
            return res.status(200).json({
                success: true,
                plan: existingPlan,
                message: "Existing generated workout plan found.",
                warnings: [],
            });
        }

        if (!syntheticUser) {
            const generationState = await getInitialPlanGenerationState(userId);
            if (generationState?.status === "running") {
                if (isGenerationStillFresh(generationState.startedAt)) {
                    return res.status(409).json({
                        success: false,
                        code: "GENERATION_IN_PROGRESS",
                        error: "Workout generation is already in progress.",
                    });
                }

                await setInitialPlanGenerationState(userId, "failed", null);
            }

            await setInitialPlanGenerationState(userId, "running", new Date().toISOString());
        }

        const preferences = profile
            ? {
                splitType: profile.workout_split_type,
                trainingDays: profile.workout_days_per_week,
                focusAreas: profile.goal ? [profile.goal] : undefined,
            }
            : {};

        console.log(`Calling planner graph with preferences:`, preferences);

        // Invoke the planner graph.
        // NOTE: onboarding plan generation is intentionally exempt from the daily
        // AI quota — the route is not behind requireAiBudget and we deliberately
        // do NOT attach makeUsageTracker here. Do not add it without product approval.
        const planCallbackHandler = new LangChainCallbackHandler({
            client: phClient,
            distinctId: userId,
            properties: { flow: 'plan_generation' },
        });
        const result = await plannerGraph.invoke({
            userId,
            preferences,
            messages: [],
        }, { callbacks: [planCallbackHandler] });

        console.log(`Planner graph result:`, {
            success: result.success,
            planId: result.planId,
            dayPlansCount: result.dayPlans?.length || 0,
            error: result.error,
            warnings: result.warnings?.length || 0,
        });

        // Check if plan was successfully created
        if (result.error) {
            console.error('Planner graph error:', result.error);
            if (!syntheticUser) {
                await setInitialPlanGenerationState(userId, "failed", null);
            }
            return res.status(500).json({
                success: false,
                error: result.error
            });
        }

        if (!result.planId) {
            console.error('No plan ID returned from planner graph');
            if (!syntheticUser) {
                await setInitialPlanGenerationState(userId, "failed", null);
            }
            return res.status(500).json({
                success: false,
                error: "Plan generation completed but no plan ID was returned"
            });
        }

        const effectiveProfile = profile ?? (result as { userProfile?: UserProfile }).userProfile;
        if (!effectiveProfile?.workout_split_type) {
            return res.status(500).json({
                success: false,
                error: "Plan generation completed but user profile context is missing",
            });
        }

        // Demo / test users skip DB persistence — return the graph output directly
        let completePlan = await getLatestPlan(userId);
        if (!completePlan && result.planId.startsWith("demo-") && result.dayPlans?.length) {
            completePlan = {
                id: result.planId,
                user_id: userId,
                plan_name: `${effectiveProfile.workout_split_type} Plan`,
                is_active: true,
                created_at: new Date().toISOString(),
                split: effectiveProfile.workout_split_type,
                goal: effectiveProfile.goal,
                days: result.dayPlans.map((day: any) => ({
                    id: `local-${day.dayIndex}`,
                    plan_id: result.planId!,
                    day_of_week: day.dayOfWeek,
                    split_day_name: day.focus,
                    exercises: (day.exercises || []).map((e: any) =>
                        typeof e === "string" ? e : e.name
                    ),
                    exercises_structured: day.exercises || [],
                    estimated_time: estimateWorkoutDurationMinutes(day.exercises || []),
                })),
            } as any;
            console.log("[ONBOARDING] Returning in-memory plan for demo/test user (not persisted)");
        }

        if (!completePlan) {
            console.error('Could not retrieve generated plan');
            if (!syntheticUser) {
                await setInitialPlanGenerationState(userId, "failed", null);
            }
            return res.status(500).json({
                success: false,
                error: "Plan was created but could not be retrieved"
            });
        }

        // Validate that exercises were actually generated
        const totalExercises = countExercises(completePlan);

        if (totalExercises === 0) {
            console.error('Plan was created but has no exercises');
            if (!syntheticUser) {
                await setInitialPlanGenerationState(userId, "failed", null);
            }
            return res.status(500).json({
                success: false,
                error: "Plan was created but no exercises were generated. Please try again."
            });
        }

        console.log(`Plan created successfully with ${totalExercises} total exercises across ${completePlan.days?.length || 0} days`);
        if (!syntheticUser) {
            await setInitialPlanGenerationState(userId, "idle", null);
        }

        res.status(200).json({
            success: true,
            plan: completePlan,
            message: `Your personalized ${effectiveProfile.workout_split_type} workout plan has been created with ${totalExercises} exercises!`,
            warnings: result.warnings || [],
        });

    } catch (err: any) {
        console.error("Plan generation error:", err);
        if (!syntheticUser && userId) {
            try {
                await setInitialPlanGenerationState(userId, "failed", null);
            } catch (stateError) {
                console.error("Failed to mark generation as failed:", stateError);
            }
        }

        const errorMessage = err?.message || "Plan generation failed";

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? err?.stack : undefined
        });
    }
});

export default router;
