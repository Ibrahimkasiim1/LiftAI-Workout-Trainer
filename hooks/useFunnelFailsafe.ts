/**
 * useFunnelFailsafe — single, cached funnel-guard re-check for main-app
 * screens. Replaces the copy-pasted useEffect + useFocusEffect blocks that
 * used to live in home (each running a full 3-query + RevenueCat resolution
 * on every focus).
 *
 * On focus (which includes the initial mount) it resolves the guarded route
 * through the 60 s guard cache and, if the user should NOT be in the main app
 * (no name / unfinished onboarding / no plan), replaces to the correct funnel
 * stage. Notification permission is deliberately NOT required to stay — the
 * first-workout "start now" path skips that prompt by design.
 *
 * Redirects at most once per mount (failsafe, not a router).
 */

import type { Session } from '@supabase/supabase-js';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

import { useSubscription } from '../context/SubscriptionContext';
import { canAccessMainApp, resolveGuardedRouteCached } from '../utils/funnelGuard';

interface Args {
    session: Session | null;
    authLoading: boolean;
}

export function useFunnelFailsafe({ session, authLoading }: Args): void {
    const router = useRouter();
    const { checkSubscription, isInitialized, isLoading: subscriptionLoading } = useSubscription();
    const subscriptionReady = isInitialized && !subscriptionLoading;
    const triggeredRef = useRef(false);

    useFocusEffect(
        useCallback(() => {
            if (triggeredRef.current) return;
            if (authLoading || !session || !subscriptionReady) return;

            let cancelled = false;

            void (async () => {
                try {
                    const resolution = await resolveGuardedRouteCached({
                        resolveSubscriptionStatus: () => checkSubscription(),
                    });
                    if (cancelled || !resolution) return;

                    if (!canAccessMainApp(resolution.prerequisites)) {
                        triggeredRef.current = true;
                        router.replace(resolution.route as any);
                    }
                } catch (error) {
                    // Transient failure is not evidence the user needs onboarding —
                    // stay put; the next focus re-checks.
                    console.error('Funnel failsafe check failed:', error);
                }
            })();

            return () => {
                cancelled = true;
            };
        }, [authLoading, session, subscriptionReady, checkSubscription, router])
    );
}
