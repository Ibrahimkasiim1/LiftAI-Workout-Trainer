/**
 * useUserQuota — live read of the caller's `user_quotas` row.
 *
 * Free tier is LEGIBLE COUNTS (what the UI shows) with a cost backstop:
 *   - ad_supported → 3 coach messages/day, 1 AI meal log/day, $0.10 backstop
 *   - premium      → unlimited (a hidden $0.80-per-12h abuse cap lives
 *                    server-side; the UI never surfaces it as a limit)
 *
 * The hook exposes the raw counts plus per-feature remaining values for the
 * "2 of 3 left today" pills, and keeps the legacy budgetPercent for any
 * surface still on the meter. Dollar amounts are never shown in the UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { supabase } from '../utils/supabase';
import { getDeviceTimezone, getNextQuotaReset, isQuotaStale } from '../utils/quotaReset';

export type TierType = 'premium' | 'ad_supported';

export interface UserQuotaRow {
    user_id: string;
    tier_type: TierType;
    daily_ai_cost: number;
    ai_chats_today: number;
    meals_logged_today: number;
    last_reset_date: string;
    timezone: string;
}

/**
 * Finite daily AI compute budgets in USD (cost BACKSTOP behind the counts).
 * Premium is intentionally absent — unlimited in the UI; its $0.80/12h abuse
 * cap is server-side only. Must mirror the per-tier caps in the
 * `check_ai_quota_or_fail` / `record_ai_cost` Supabase RPCs (see migration
 * 20260707010000_legible_quota_counts_and_premium_window.sql).
 */
export const TIER_BUDGET_USD: Partial<Record<TierType, number>> = {
    ad_supported: 0.10,
};

/**
 * Countable daily allowances shown in the UI ("2 of 3 left today"). Must
 * mirror the limits in check_ai_quota_or_fail. Premium = no entry = unlimited.
 */
export const FREE_TIER_LIMITS = {
    chats: 3,
    meals: 1,
} as const;

export interface UseUserQuotaResult {
    quota: UserQuotaRow | null;
    tier: TierType | null;
    isLoading: boolean;
    error: string | null;
    /** Current accrued cost today in USD. Null until loaded. */
    dailyAiCost: number | null;
    /** The tier's daily compute cap in USD. Null until tier is known. */
    maxDailyBudget: number | null;
    /** Integer 0–100 representing how much of the daily budget is consumed. */
    budgetPercent: number | null;
    /** Coach messages left today. Null = unlimited (premium) or not loaded. */
    chatsRemaining: number | null;
    /** AI meal logs left today. Null = unlimited (premium) or not loaded. */
    mealsRemaining: number | null;
    /** The instant the daily quota next resets (the device's local midnight). */
    nextResetAt: Date;
    refetch: () => Promise<void>;
}

function computePercent(cost: number | null, cap: number | null): number | null {
    if (cost == null || cap == null || cap <= 0) return null;
    const pct = Math.round((cost / cap) * 100);
    return Math.max(0, Math.min(100, pct));
}

export function useUserQuota(): UseUserQuotaResult {
    const [quota, setQuota] = useState<UserQuotaRow | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const mounted = useRef(true);

    const load = useCallback(async () => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const userId = session?.user?.id;
            if (!userId) {
                if (mounted.current) {
                    setQuota(null);
                    setIsLoading(false);
                    setError(null);
                }
                return;
            }

            const { data, error: rowErr } = await (supabase as any)
                .from('user_quotas')
                .select('user_id, tier_type, daily_ai_cost, ai_chats_today, meals_logged_today, last_reset_date, timezone')
                .eq('user_id', userId)
                .maybeSingle();

            if (!mounted.current) return;

            if (rowErr) {
                setError(rowErr.message);
                setIsLoading(false);
                return;
            }

            const row = (data as UserQuotaRow | null) ?? null;
            setQuota(row);
            setError(null);
            setIsLoading(false);

            // Keep the backend's reset boundary in sync with this device's
            // timezone so the quota resets at the user's local midnight. Fire
            // and forget — idempotent, and a failure just leaves the prior value.
            const deviceTz = getDeviceTimezone();
            if (row && row.timezone !== deviceTz) {
                void (supabase as any)
                    .rpc('set_user_timezone', { p_timezone: deviceTz })
                    .then(({ error: tzErr }: { error: { message: string } | null }) => {
                        if (tzErr && __DEV__) {
                            console.warn('[useUserQuota] set_user_timezone failed:', tzErr.message);
                        }
                    });
            }
        } catch (e: any) {
            if (!mounted.current) return;
            setError(e?.message ?? String(e));
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void load();

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, _session) => {
            void load();
        });

        // Re-read on foreground: a user who backgrounds the app overnight
        // would otherwise keep yesterday's counts in the pill until they act.
        const appState = AppState.addEventListener('change', (state) => {
            if (state === 'active') void load();
        });

        return () => {
            mounted.current = false;
            subscription.unsubscribe();
            appState.remove();
        };
    }, [load]);

    const tier = quota?.tier_type ?? null;
    // If the stored row is from before today, the budget has logically reset even
    // though the backend hasn't lazily applied it yet (no AI request since
    // midnight) — show it as fully available rather than yesterday's usage.
    const stale = quota ? isQuotaStale(quota.last_reset_date) : false;
    const dailyAiCost = quota
        ? (stale ? 0 : Number(quota.daily_ai_cost ?? 0))
        : null;
    // Premium has no entry in TIER_BUDGET_USD → null cap → unlimited.
    const maxDailyBudget = tier ? (TIER_BUDGET_USD[tier] ?? null) : null;

    // Legible counters (free tier only; premium reads as unlimited → null).
    const chatsUsed = quota ? (stale ? 0 : Number(quota.ai_chats_today ?? 0)) : null;
    const mealsUsed = quota ? (stale ? 0 : Number(quota.meals_logged_today ?? 0)) : null;
    const chatsRemaining =
        tier === 'ad_supported' && chatsUsed != null
            ? Math.max(0, FREE_TIER_LIMITS.chats - chatsUsed)
            : null;
    const mealsRemaining =
        tier === 'ad_supported' && mealsUsed != null
            ? Math.max(0, FREE_TIER_LIMITS.meals - mealsUsed)
            : null;

    return {
        quota,
        tier,
        isLoading,
        error,
        dailyAiCost,
        maxDailyBudget,
        budgetPercent: computePercent(dailyAiCost, maxDailyBudget),
        chatsRemaining,
        mealsRemaining,
        nextResetAt: getNextQuotaReset(),
        refetch: load,
    };
}
