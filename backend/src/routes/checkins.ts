/**
 * Coach check-ins API.
 *
 * GET  /checkins            → unread (and recent read) coach check-ins for the caller
 * POST /checkins/:id/status → mark a check-in read or dismissed
 *
 * Rows are drafted by the proactive-coach cron (services/proactiveCheckins.ts)
 * and by plan-mutating chat tools (kind = 'plan_change'). The app renders
 * unread rows as a coach card; the `cta` field is a prefilled chat message so
 * one tap drops the user into a conversation the agent can act on.
 */

import { Request, Response, Router } from "express";
import { z } from "zod";
import type { AuthedRequest } from "../middleware/auth";
import { supabase } from "../services/db";
import { upsertCoachMemory } from "../services/longTermMemory";
import { getUserTimezone, localTodayInTimezone } from "../services/userTimezone";

const router = Router();

router.get("/checkins", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const nowIso = new Date().toISOString();

        const { data, error } = await supabase
            .from("coach_checkins")
            .select("id, kind, title, message, cta, payload, status, created_at, expires_at")
            .eq("user_id", userId)
            .neq("status", "dismissed")
            .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
            .order("created_at", { ascending: false })
            .limit(10);

        if (error) {
            return res.status(500).json({ success: false, error: error.message });
        }

        return res.json({
            success: true,
            checkins: data ?? [],
            unreadCount: (data ?? []).filter((c) => c.status === "unread").length,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: message });
    }
});

const statusSchema = z.object({ status: z.enum(["read", "dismissed"]) });

router.post("/checkins/:id/status", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const { status } = statusSchema.parse(req.body);
        const id = String(req.params.id);

        const { error, count } = await supabase
            .from("coach_checkins")
            .update({ status }, { count: "exact" })
            .eq("id", id)
            .eq("user_id", userId);

        if (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
        if (!count) {
            return res.status(404).json({ success: false, error: "Check-in not found" });
        }
        return res.json({ success: true });
    } catch (err: any) {
        return res.status(err?.name === "ZodError" ? 400 : 500).json({
            success: false,
            error: err?.message ?? "Failed to update check-in",
        });
    }
});

// ============================================================================
// In-workout coach questions → progressive memory
// ============================================================================
//
// The workout player asks lightweight questions ("How are you feeling today?",
// "How's this workout?"). Answers land in `coach_memories` (service-role
// writes only, hence this endpoint) so BOTH the chat agent and future workout
// generation can take them into account. Feelings expire quickly — they're a
// session signal, not a permanent fact; difficulty feedback lingers longer so
// the coach can adjust programming.

const sessionFeedbackSchema = z.object({
    kind: z.enum(["feeling", "difficulty"]),
    value: z.enum([
        // feeling
        "fresh", "good", "tired", "sore",
        // difficulty
        "too_easy", "just_right", "too_hard",
    ]),
    /** Optional workout label for context, e.g. "Push Day". */
    workout: z.string().max(80).optional(),
});

router.post("/checkins/session-feedback", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const { kind, value, workout } = sessionFeedbackSchema.parse(req.body);

        const today = localTodayInTimezone(await getUserTimezone(userId));
        const expires = new Date();

        let fact: string;
        if (kind === "feeling") {
            fact = `${today}: felt ${value} before training${workout ? ` (${workout})` : ""}`;
            expires.setDate(expires.getDate() + 3);
        } else {
            const label =
                value === "too_easy" ? "too easy" : value === "too_hard" ? "too hard" : "about right";
            fact = `${today}: rated ${workout ? `the ${workout} session` : "their session"} ${label}`;
            expires.setDate(expires.getDate() + 14);
        }

        await upsertCoachMemory(userId, {
            category: "training_phase",
            fact,
            confidence: 0.9,
            expiresAt: expires.toISOString(),
            source: "workout_question",
        });

        return res.json({ success: true });
    } catch (err: any) {
        return res.status(err?.name === "ZodError" ? 400 : 500).json({
            success: false,
            error: err?.message ?? "Failed to record session feedback",
        });
    }
});

export default router;
