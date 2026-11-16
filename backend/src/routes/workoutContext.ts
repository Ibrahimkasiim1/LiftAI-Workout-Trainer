/**
 * Workout Context Route
 * 
 * Provides the frontend with effective user context (merged profile + overrides)
 * and today's workout with any override notes.
 */

import { Request, Response, Router } from "express";
import { getActiveUserContextTool } from "../agents/tools";
import type { AuthedRequest } from "../middleware/auth";
import { getLatestPlan, supabase } from "../services/db";

const router = Router();

router.get("/workout-context", async (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).user.id;

    try {
        // Get effective context (merges profile + overrides)
        const context = await getActiveUserContextTool.invoke({ userId });

        if (!context || context.error) {
            return res.status(404).json({ error: context?.error || "User not found" });
        }

        // Get active plan
        const plan = await getLatestPlan(userId);

        // Get active overrides with details
        const { data: overrides } = await supabase
            .from("plan_overrides")
            .select("*")
            .eq("user_id", userId)
            .eq("is_active", true)
            .gte("end_date", new Date().toISOString())
            .order("created_at", { ascending: false });

        // Get today's workout
        const today = new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
        let todaysWorkout = plan?.days?.find((d: any) => d.day_of_week === today);

        // Add override metadata if active
        if (todaysWorkout && overrides && overrides.length > 0) {
            const activeOverride = overrides[0];

            // Check if any exercises were replaced
            const hasReplacements = todaysWorkout.exercises_structured?.some(
                (ex: any) => ex.isReplacement
            );

            todaysWorkout = {
                ...todaysWorkout,
                overrideNote: activeOverride.reason,
                overrideExpiresAt: activeOverride.end_date,
                overrideType: activeOverride.override_type,
                hasReplacements,
                replacementCount: todaysWorkout.exercises_structured?.filter(
                    (ex: any) => ex.isReplacement
                ).length || 0,
            };
        }

        res.json({
            success: true,
            baseProfile: {
                equipment: context.baseEquipment,
                injuries: context.injuries,
            },
            effectiveProfile: {
                equipment: context.effectiveEquipment,
                injuries: context.effectiveInjuries,
                temporaryLocation: context.temporaryLocation,
            },
            activeContexts: context.activeContexts || [],
            activeOverrides: overrides || [],
            weekPlan: plan?.days || [],
            todaysWorkout,
        });
    } catch (error: any) {
        console.error("Failed to get workout context:", error);
        res.status(500).json({
            success: false,
            error: "Failed to load context",
            message: error?.message
        });
    }
});

export default router;
