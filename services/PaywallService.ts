// /services/PaywallService.ts
/**
 * PaywallService - Singleton Paywall Presentation Manager
 *
 * Presents the native ConversionPaywall (components/paywall) — a custom
 * carousel paywall whose purchases go through the RevenueCat SDK. The
 * RevenueCat template UI (`RevenueCatUI.presentPaywallIfNeeded`) is no longer
 * used; entitlements, webhooks, and restore flows are unchanged.
 *
 * This service ensures:
 * 1. Only ONE paywall can be presented at a time (no stacking)
 * 2. Entitlement is always re-checked before presenting (subscribers never
 *    see a paywall)
 * 3. Provides soft (dismissible) and hard (close-delayed) paywall modes
 *
 * The `context` string decides which feature slide leads the carousel — pass
 * a GatedFeature (e.g. 'nutrition_ai') or a PaywallSource (e.g.
 * 'settings_upgrade'). See components/paywall/paywallSlides.ts.
 */

import { presentConversionPaywall } from '../components/paywall/PaywallHost';

// Paywall presentation modes
export type PaywallMode = 'soft' | 'hard';

// Paywall source tracking (for analytics). GatedFeature values are also
// accepted anywhere a context string is taken.
export type PaywallSource =
    | 'onboarding_pre_generation'      // Paywall at end of onboarding ("plan ready")
    | 'onboarding_confirm_plan'        // Legacy: second onboarding paywall (removed)
    | 'settings_upgrade'               // Manual upgrade from settings
    | 'plan_expired'                   // Subscription lapsed, user returned to app
    | 'quota_chat'                     // Daily AI limit hit in chat
    | 'quota_nutrition'                // Daily AI limit hit in nutrition logging
    | 'feature_gate';                  // Generic Pro feature gating fallback

export interface PaywallResult {
    purchased: boolean;
    restored: boolean;
    cancelled: boolean;
    error?: string;
}

// Singleton state - prevents multiple paywall presentations
let isPaywallPresenting = false;

/**
 * Present the conversion paywall.
 *
 * @param mode - 'soft' (close button immediately) or 'hard' (close appears after a beat)
 * @param context - GatedFeature or PaywallSource; picks the lead carousel slide and tags analytics
 * @param onEntitlementChanged - Callback to refresh subscription state; also used as the pre-check
 * @returns PaywallResult with purchase/cancel status
 */
export async function presentPaywall(
    mode: PaywallMode,
    context: string,
    onEntitlementChanged: () => Promise<boolean>
): Promise<PaywallResult> {
    // Prevent multiple simultaneous paywall presentations
    if (isPaywallPresenting) {
        if (__DEV__) {
            console.log('[PaywallService] Paywall already presenting, skipping');
        }
        return { purchased: false, restored: false, cancelled: false };
    }

    try {
        isPaywallPresenting = true;

        // Always check entitlement before presenting the paywall
        const alreadyEntitled = await onEntitlementChanged();
        if (alreadyEntitled) {
            if (__DEV__) {
                console.log('[PaywallService] User already has entitlement, skipping paywall');
            }
            // restored:true signals "user has access" to callers gating on the result
            return { purchased: false, restored: true, cancelled: false };
        }

        if (__DEV__) {
            console.log(`[PaywallService] Presenting ${mode} paywall (context: ${context})`);
        }

        const result = await presentConversionPaywall({ contextKey: context, mode });

        if (result.purchased || result.restored) {
            // Refresh subscription state so gating updates immediately
            await onEntitlementChanged();
        }

        return { ...result };
    } catch (error) {
        console.error('[PaywallService] Error presenting paywall:', error);
        return {
            purchased: false,
            restored: false,
            cancelled: false,
            error: error instanceof Error ? error.message : 'Failed to present paywall',
        };
    } finally {
        isPaywallPresenting = false;
    }
}

/**
 * Helper function for soft paywall (dismissible)
 */
export async function presentSoftPaywall(
    source: string,
    onEntitlementChanged: () => Promise<boolean>
): Promise<PaywallResult> {
    return presentPaywall('soft', source, onEntitlementChanged);
}

/**
 * Gate an action behind entitlement: presents the hard paywall when the user
 * is not entitled. Returns true if the user can proceed.
 */
export async function requireEntitlement(
    source: string,
    onEntitlementChanged: () => Promise<boolean>
): Promise<boolean> {
    // First check current entitlement
    try {
        const isEntitled = await onEntitlementChanged();
        if (isEntitled) {
            return true;
        }
    } catch {
        // Continue to show paywall
    }

    const result = await presentPaywall('hard', source, onEntitlementChanged);
    if (result.purchased || result.restored) {
        return true;
    }

    // Final safety check: re-verify subscription status. Catches edge cases
    // where the SDK knows the user is subscribed but the result didn't say so.
    try {
        return await onEntitlementChanged();
    } catch {
        return false;
    }
}

/**
 * Check if paywall is currently being presented
 * Useful for preventing navigation issues
 */
export function isPaywallVisible(): boolean {
    return isPaywallPresenting;
}

/**
 * Reset paywall state (for testing/debugging only)
 */
export function resetPaywallState(): void {
    isPaywallPresenting = false;
}
