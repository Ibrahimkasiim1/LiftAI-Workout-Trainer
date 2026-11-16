/**
 * "Don't like ads?" upgrade nudge — fires occasionally when the user CLOSES a
 * full-screen ad. That dismissal is the one moment ad-annoyance is provably
 * top-of-mind, which makes it the honest place to mention that Pro removes
 * every ad.
 *
 * Deliberately infrequent so it never becomes a second annoyance:
 *   - only every Nth interstitial close (default 3rd),
 *   - at most once per 24h,
 *   - never for Pro users (callers gate on isPro; the paywall re-checks too).
 *
 * Call `maybeShowRemoveAdsNudge(refreshEntitlements)` from every interstitial
 * CLOSED handler. Fire-and-forget; failures never propagate.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { confirmSheet } from '../components/ui/ConfirmSheet';
import { presentPaywall } from '../services/PaywallService';
import { posthog } from '../src/config/posthog';

const CLOSE_COUNT_KEY = '@ad_close_count_v1';
const LAST_NUDGE_AT_KEY = '@remove_ads_nudge_at_v1';

/** Every Nth interstitial close triggers the nudge (subject to the cooldown). */
const NUDGE_EVERY_N_CLOSES = 3;
const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function maybeShowRemoveAdsNudge(
    refreshEntitlements: () => Promise<boolean>
): Promise<void> {
    try {
        const [countRaw, lastRaw] = await Promise.all([
            AsyncStorage.getItem(CLOSE_COUNT_KEY),
            AsyncStorage.getItem(LAST_NUDGE_AT_KEY),
        ]);
        const count = (Number(countRaw) || 0) + 1;
        await AsyncStorage.setItem(CLOSE_COUNT_KEY, String(count));

        if (count % NUDGE_EVERY_N_CLOSES !== 0) return;
        if (lastRaw && Date.now() - Number(lastRaw) < NUDGE_COOLDOWN_MS) return;

        await AsyncStorage.setItem(LAST_NUDGE_AT_KEY, String(Date.now()));
        posthog.capture('remove_ads_nudge_shown', { ad_closes: count });

        // Give the ad's dismissal animation a beat before presenting our sheet.
        await new Promise((r) => setTimeout(r, 600));

        const wantsPro = await confirmSheet({
            title: 'Not a fan of ads?',
            message:
                'With Pro, get an ad-free experience, extended AI limits, unlimited meal logging, and more.',
            confirmLabel: 'Upgrade now',
            cancelLabel: 'Don’t upgrade',
        });

        posthog.capture('remove_ads_nudge_answered', { accepted: wantsPro });
        if (wantsPro) {
            await presentPaywall('soft', 'feature_gate', refreshEntitlements);
        }
    } catch {
        // Never let a growth nudge break the ad flow.
    }
}
