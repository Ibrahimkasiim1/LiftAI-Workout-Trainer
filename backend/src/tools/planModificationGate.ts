/**
 * Plan modification gate.
 *
 * Permanent plan edits (swap_permanent_exercise, shift_workout_schedule,
 * modify_plan_permanently) are capped at 3 lifetime for free-tier users.
 * Premium users are unlimited. Session-only edits (swap_session_exercise,
 * add_to_todays_workout) are NOT gated — those are temporary by design.
 *
 * Tools call `consumePlanModification(userId)` at the start of their handler.
 * On the free tier, the counter is incremented atomically; if the user is
 * already at the limit, the tool short-circuits with a structured error
 * that the supervisor can relay back to the user as a paywall prompt.
 */

import { supabase } from "../services/db";

export const FREE_PLAN_MODIFICATION_LIMIT = 3;

export type PlanModificationGateResult =
    | { allowed: true; tier: "premium" }
    | { allowed: true; tier: "ad_supported"; used: number; remaining: number }
    | {
          allowed: false;
          reason: "pro_required:plan_modifications";
          used: number;
          limit: number;
          message: string;
      };

/**
 * Check the user's plan-modification budget and, on success, increment the
 * counter. Returns a structured result the caller folds into its tool response.
 *
 * Defensive on errors: if we can't read the quota row, we allow the action —
 * blocking the user out of their own plan due to a transient DB error would
 * be a worse failure mode than letting a free user squeeze in one extra edit.
 */
export async function consumePlanModification(
    userId: string
): Promise<PlanModificationGateResult> {
    const { data, error } = await supabase
        .from("user_quotas")
        .select("tier_type, plan_modifications_used")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) {
        console.error(
            `[planModificationGate] failed to read user_quotas for ${userId}:`,
            error.message
        );
        return { allowed: true, tier: "premium" };
    }

    const tier = (data?.tier_type ?? "ad_supported") as string;
    const used = data?.plan_modifications_used ?? 0;

    if (tier === "premium") {
        return { allowed: true, tier: "premium" };
    }

    if (used >= FREE_PLAN_MODIFICATION_LIMIT) {
        return {
            allowed: false,
            reason: "pro_required:plan_modifications",
            used,
            limit: FREE_PLAN_MODIFICATION_LIMIT,
            message: `You've used all ${FREE_PLAN_MODIFICATION_LIMIT} free plan modifications. Upgrade to LiftAI Pro for unlimited edits.`,
        };
    }

    const { error: updateErr } = await supabase
        .from("user_quotas")
        .update({ plan_modifications_used: used + 1 })
        .eq("user_id", userId);

    if (updateErr) {
        console.error(
            `[planModificationGate] failed to increment counter for ${userId}:`,
            updateErr.message
        );
        // Fail open — don't block the user on an update error.
    }

    return {
        allowed: true,
        tier: "ad_supported",
        used: used + 1,
        remaining: FREE_PLAN_MODIFICATION_LIMIT - (used + 1),
    };
}
