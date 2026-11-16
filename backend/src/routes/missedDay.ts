/**
 * Missed Day Route
 * 
 * Endpoint for handling missed workout days.
 * Provides recommendations for rescheduling or merging workouts.
 */

import { Request, Response, Router } from "express";
import { z } from "zod";
import { makeUsageTracker } from "../agents/usageTracking";
import type { AuthedRequest } from "../middleware/auth";
import { getLatestPlan } from "../services/db";

const router = Router();

const bodySchema = z.object({
  missedDate: z.string().min(1, "missedDate is required"),
  preference: z.enum(["shift", "merge", "skip"]).optional(),
});

interface MissedDayRecommendation {
  action: "shift" | "merge" | "skip";
  message: string;
  affectedDays?: string[];
}

/**
 * POST /missed-day
 * 
 * Handle a missed workout day and get recommendations.
 * Now routes through LangGraph for personalized AI responses.
 * 
 * Body:
 * - userId: string (required)
 * - missedDate: string (required) - ISO date string
 * - preference: "shift" | "merge" | "skip" (optional)
 */
router.post("/missed-day", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;
    const { missedDate, preference } = bodySchema.parse(req.body);

    // Get user's current plan for context
    const plan = await getLatestPlan(userId);

    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "No active workout plan found",
        message: "You don't have an active workout plan. Would you like to create one?",
      });
    }

    // Parse missed date
    const missed = new Date(missedDate);
    const dayOfWeek = missed.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

    // Deterministic fast-paths: "shift" and "skip" are fully specified by the
    // request — running the multi-agent graph for them paid 2-3 LLM calls to
    // reach a foregone conclusion. Only "merge" and the open "what should I
    // do?" question need actual intelligence.
    if (preference === "shift") {
      const { toolByName } = await import("../agents/tools");
      // Registry values are a union of tool types whose invoke signatures
      // don't unify; the runtime shape is uniform.
      const shiftTool = toolByName.shift_workout_schedule as { invoke: (args: object) => Promise<unknown> };
      const result = (await shiftTool.invoke({
        user_id: userId,
        days_to_shift: 1,
      })) as { success?: boolean; message?: string };
      const recommendation: MissedDayRecommendation = {
        action: "shift",
        message: result?.success
          ? `No problem — I shifted your upcoming workouts forward a day, so you won't miss ${dayOfWeek}'s session. ${result.message ?? ""}`.trim()
          : `I couldn't shift your schedule automatically — ${result?.message ?? "please try again"}.`,
        affectedDays: [dayOfWeek],
      };
      return res.status(200).json({
        success: result?.success !== false,
        recommendation,
        missedDate,
        dayOfWeek,
      });
    }

    if (preference === "skip") {
      const recommendation: MissedDayRecommendation = {
        action: "skip",
        message: `All good — one missed ${dayOfWeek} won't dent your progress. Your plan continues as scheduled; just bring normal intensity to your next session.`,
        affectedDays: [dayOfWeek],
      };
      return res.status(200).json({
        success: true,
        recommendation,
        missedDate,
        dayOfWeek,
      });
    }

    // Build natural language message for LangGraph (merge / no preference)
    const message = preference === "merge"
      ? `I missed my workout on ${dayOfWeek} (${missedDate}). I want to merge it with my next workout.`
      : `I missed my workout on ${dayOfWeek} (${missedDate}). What should I do?`;

    console.log(`Missed day request: ${message}`);

    // Import graph here to avoid circular dependency. One-shot supervisor
    // graph (no checkpointer): this endpoint is stateless by design.
    const { getOneShotChatGraph } = await import("../agents/langgraphRuntime");
    const { GRAPH_RECURSION_LIMIT } = await import("../agents/supervisorGraph");
    const { getUserProfile } = await import("../services/db");
    const { HumanMessage } = await import("@langchain/core/messages");

    // Route through LangGraph
    const profile = await getUserProfile(userId);
    const result = await getOneShotChatGraph().invoke({
      userId,
      userProfile: profile,
      currentPlan: plan,
      messages: [new HumanMessage(message)],
      shouldCallTool: false,
      toolCalls: [],
      responseToUser: null,
      workout: null,
      planUpdate: null,
      completed: false,
      retryCount: 0,
      error: null,
    }, { recursionLimit: GRAPH_RECURSION_LIMIT, callbacks: [makeUsageTracker(userId)] });

    console.log(`Graph result: ${result.responseToUser}`);

    // Extract recommendation from AI response
    // Map AI response to expected format for backward compatibility
    const recommendation: MissedDayRecommendation = {
      action: preference || "skip",
      message: result.responseToUser || "I've processed your missed workout request.",
      affectedDays: [dayOfWeek],
    };

    res.status(200).json({
      success: result.completed && !result.error,
      recommendation,
      missedDate: missedDate,
      dayOfWeek,
    });
  } catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({
      success: false,
      error: err?.message ?? "Failed to handle missed day"
    });
  }
});

export default router;
