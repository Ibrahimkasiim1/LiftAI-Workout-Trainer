/**
 * Quota gate middleware.
 *
 * Free tier (ad_supported) is enforced as LEGIBLE COUNTS with a cost backstop:
 *   - 'chat' routes → 3 coach messages/day  (reason 'chat_limit')
 *   - 'meal' routes → 1 AI meal log/day     (reason 'meal_limit')
 *   - everything    → $0.10/day cost backstop (reason 'quota_exceeded')
 * Counts reset at the user's local midnight (lazy, inside the RPC). The RPC
 * consumes the count pre-flight, so one user action = exactly one count.
 *
 * Premium is "unlimited" in marketing but carries a $0.80-per-12h soft abuse
 * cap (reason 'premium_cooldown' + retry_at). The client shows a friendly
 * "the coach needs a breather" note instead of an upgrade pitch.
 *
 * Cost is still accrued post-flight via `record_ai_cost` (per LLM call), so a
 * single request may push slightly over the backstop — the next one blocks.
 */

import { NextFunction, Request, Response } from "express";
import { supabase } from "../services/db";
import { AuthedRequest } from "./auth";

/** Countable features. Anything else rides the cost backstop only. */
export type AiQuotaFeature = "chat" | "meal";

export interface QuotaResult {
    allowed: boolean;
    reason?: "chat_limit" | "meal_limit" | "quota_exceeded" | "premium_cooldown" | string;
    tier_type?: string;
    daily_ai_cost?: number;
    max_daily_budget?: number;
    chats_used?: number;
    chats_limit?: number | null;
    meals_used?: number;
    meals_limit?: number | null;
    /** Premium cooldown only: ISO timestamp when the 12h window reopens. */
    retry_at?: string;
}

/**
 * Hand back one consumed chat allowance after a turn FAILED server-side.
 * check_ai_quota_or_fail counts pre-flight, so a graph error/timeout would
 * otherwise burn one of the free tier's 3 daily messages for nothing.
 * Best-effort and never throws: skips gracefully until migration
 * 20260712010000 (refund_chat_count) is applied.
 */
export async function refundChatAllowance(userId: string): Promise<void> {
    try {
        const { error } = await supabase.rpc("refund_chat_count", { p_user_id: userId });
        if (error) {
            if (error.code === "PGRST202") {
                console.log("[quotaGate] refund_chat_count not deployed yet — skipping refund");
            } else {
                console.warn(`[quotaGate] chat refund failed for ${userId}: ${error.message}`);
            }
            return;
        }
        console.log(`[quotaGate] refunded 1 chat allowance to ${userId} (failed turn)`);
    } catch (err) {
        console.warn("[quotaGate] chat refund threw (non-fatal):", err);
    }
}

/**
 * Hand back the consumed AI-meal-log allowance after /nutrition/log FAILED
 * server-side. The free tier gets exactly one AI meal log per day, so a
 * burned count on a 4xx/5xx is a whole day of the feature lost. Best-effort
 * and never throws: skips gracefully until migration 20260717010000
 * (refund_meal_count) is applied.
 */
export async function refundMealAllowance(userId: string): Promise<void> {
    try {
        const { error } = await supabase.rpc("refund_meal_count", { p_user_id: userId });
        if (error) {
            if (error.code === "PGRST202") {
                console.log("[quotaGate] refund_meal_count not deployed yet — skipping refund");
            } else {
                console.warn(`[quotaGate] meal refund failed for ${userId}: ${error.message}`);
            }
            return;
        }
        console.log(`[quotaGate] refunded 1 meal allowance to ${userId} (failed log)`);
    } catch (err) {
        console.warn("[quotaGate] meal refund threw (non-fatal):", err);
    }
}

/**
 * Express middleware factory: blocks the request when the user is over their
 * allowance for `feature` (or the cost backstop / premium window when no
 * feature applies). Must run AFTER `requireAuth`.
 */
export function requireAiBudget(feature?: AiQuotaFeature) {
    return async function aiQuotaGate(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const userId = (req as AuthedRequest).user?.id;
            if (!userId) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }

            const { data, error } = await supabase.rpc("check_ai_quota_or_fail", {
                p_user_id: userId,
                p_feature: feature ?? null,
            });

            if (error) {
                console.error(
                    `[quotaGate] check_ai_quota_or_fail failed for ${userId}: ${error.message}`
                );
                res.status(500).json({ error: "quota check failed" });
                return;
            }

            const result = (data ?? {}) as QuotaResult;

            if (!result.allowed) {
                res.status(429).json({
                    error: result.reason ?? "quota_exceeded",
                    ...result,
                });
                return;
            }

            (req as Request & { quota?: QuotaResult }).quota = result;
            next();
        } catch (err) {
            console.error("[quotaGate] unexpected error:", err);
            res.status(500).json({ error: "quota check failed" });
        }
    };
}
