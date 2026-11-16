/**
 * Onboarding Paywall Screen — the ONE conversion moment in onboarding.
 *
 * Shown right after the personalization questions, at peak investment, framed
 * around the user's own outcome ("your plan to hit 175 lbs by Aug 14 is
 * ready"). Renders the native ConversionPaywall inline: feature carousel,
 * anchored pricing, trial-aware CTA, restore/terms footer.
 *
 * WORKFLOW:
 * - User completes onboarding questions → lands here
 * - Already subscribed (or RevenueCat unusable) → straight to plan generation
 * - Purchase or dismiss → continue to plan generation either way (free tier
 *   with ads exists; the hard gate was removed — see plan-review.tsx, which
 *   no longer re-presents a second paywall 60 seconds later)
 *
 * All paywall analytics (paywall_viewed, slide views, purchase funnel) are
 * captured inside ConversionPaywall with context 'onboarding_pre_generation'.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import ConversionPaywall from '../../components/paywall/ConversionPaywall';
import { getApiUrl } from '../../config/api';
import { useSubscription } from '../../context/SubscriptionContext';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { posthog } from '../../src/config/posthog';
import { writeFunnelSnapshot } from '../../utils/funnelState';

export default function PaywallScreen() {
    const router = useRouter();
    // Outcome params from onboarding — used to sell the result, not the app.
    const params = useLocalSearchParams<{
        goal?: string;
        goalKg?: string;
        unit?: string;
        name?: string;
        targetDate?: string;
    }>();
    const { session, loading: authLoading } = useRequireAuth();
    const {
        checkSubscription,
        isLoading: subscriptionLoading,
        isInitialized,
        revenueCatUsable,
    } = useSubscription();

    const [showPaywall, setShowPaywall] = useState(false);
    // One confident beat of acknowledgment after a purchase — purchasers used
    // to get pixel-identical treatment to dismissers (no confirmation of a
    // $60 commitment), a confirmed factor in early trial cancellations.
    const [proWelcome, setProWelcome] = useState(false);
    const checkedRef = useRef(false);
    const navigatedRef = useRef(false);
    const generationKickedRef = useRef(false);

    // Overlap plan generation with the paywall: the 30–90 s a user spends
    // reading/deciding here used to be dead time, after which they stared at
    // a 45–90 s progress bar. Fire /api/generate-plan the moment this screen
    // has a session; by the time they reach plan-generation the backend's
    // running-state machine + the screen's existing "plan found on boot" /
    // GENERATION_IN_PROGRESS polling paths resolve in seconds. Fire-and-forget:
    // duplicates 409 harmlessly, failures fall back to the normal flow, and the
    // dangling fetch is irrelevant once the server has started the work.
    useEffect(() => {
        if (authLoading || !session || generationKickedRef.current) return;
        generationKickedRef.current = true;
        posthog.capture('plan_generation_prefetch_started', { source: 'paywall_mount' });
        void fetch(`${getApiUrl()}/api/generate-plan`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({}),
        }).catch(() => {
            // plan-generation retries with full UX; nothing to surface here.
        });
    }, [authLoading, session]);

    const subscriptionBootstrapDone = isInitialized && !subscriptionLoading;

    useEffect(() => {
        if (!authLoading && session) {
            writeFunnelSnapshot('soft_paywall', {
                route: '/onboarding/paywall',
                reason: 'soft_paywall_screen',
            });
        }
    }, [authLoading, session]);

    useEffect(() => {
        if (authLoading || !session || !subscriptionBootstrapDone || checkedRef.current) return;
        checkedRef.current = true;

        (async () => {
            try {
                // Fresh read before routing (purchase on another device, stale context…)
                const subscribed = await checkSubscription();
                if (subscribed || !revenueCatUsable) {
                    navigateToNextStep();
                    return;
                }
                setShowPaywall(true);
            } catch {
                // Never block onboarding on a paywall failure
                navigateToNextStep();
            }
        })();
        // One-shot bootstrap for this screen
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authLoading, session, subscriptionBootstrapDone]);

    const navigateToNextStep = React.useCallback(async () => {
        if (navigatedRef.current) return;
        navigatedRef.current = true;
        await writeFunnelSnapshot('plan_generation', {
            route: '/onboarding/plan-generation',
            reason: 'soft_paywall_finished',
        });
        router.replace('/onboarding/plan-generation');
    }, [router]);

    // The Pro-welcome beat holds for one breath, then continues the funnel.
    // Driven by an effect (not a bare setTimeout in the result callback) so
    // unmounting mid-beat cancels the timer — an orphaned timer would still
    // write the funnel snapshot and yank whatever screen replaced this one.
    useEffect(() => {
        if (!proWelcome) return;
        const timer = setTimeout(() => { void navigateToNextStep(); }, 2200);
        return () => clearTimeout(timer);
    }, [proWelcome, navigateToNextStep]);

    // Outcome headline: "hit 175 lbs by Aug 14" — falls back to a generic line
    // when params are missing (funnel resume) or the goal is maintain.
    const outcomeHeadline = useMemo(() => {
        const goal = params.goal;
        const goalKg = Number(params.goalKg);
        const targetDate = params.targetDate;
        const unit = params.unit === 'kg' ? 'kg' : 'lbs';
        const namePrefix = params.name ? `${params.name}, ` : '';
        if ((goal === 'lose' || goal === 'gain') && goalKg > 0 && targetDate) {
            const display = unit === 'kg' ? Math.round(goalKg) : Math.round(goalKg * 2.20462);
            const verb = goal === 'gain' ? 'reach' : 'hit';
            return `${namePrefix}your plan to ${verb} ${display} ${unit} by ${targetDate} is ready`;
        }
        return `${namePrefix}your personalized training plan is ready`;
    }, [params.goal, params.goalKg, params.targetDate, params.unit, params.name]);

    if (proWelcome) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <View style={styles.proCheckCircle}>
                        <Ionicons name="checkmark" size={40} color="#FFFFFF" />
                    </View>
                    <Text style={styles.proTitle}>
                        You&apos;re in{params.name ? `, ${params.name}` : ''}
                    </Text>
                    <Text style={styles.proSubtext}>Pro unlocked — building your personalized plan…</Text>
                </View>
            </SafeAreaView>
        );
    }

    if (!showPaywall) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#2E90FA" />
                    <Text style={styles.loadingText}>Preparing your plan…</Text>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <View style={styles.container}>
            <ConversionPaywall
                contextKey="onboarding_pre_generation"
                mode="hard"
                outcomeHeadline={outcomeHeadline}
                onResult={(result) => {
                    // Entitlement state is already refreshed by the paywall
                    // itself; onboarding continues either way. A purchase or
                    // restore gets a one-beat "you're in" acknowledgment
                    // first — a dismissal navigates straight on.
                    if (result.purchased || result.restored) {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        posthog.capture('pro_welcome_shown', { restored: result.restored });
                        setProWelcome(true); // navigation continues via the proWelcome effect
                    } else {
                        void navigateToNextStep();
                    }
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 40,
    },
    loadingText: {
        fontSize: 16,
        color: '#f1f5f9',
        marginTop: 20,
        textAlign: 'center',
        fontFamily: 'Montserrat_500Medium',
    },
    // Pro welcome beat — stage aesthetic: single blue-glow mark on black.
    proCheckCircle: {
        width: 84,
        height: 84,
        borderRadius: 42,
        backgroundColor: '#2E90FA',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
        shadowColor: '#2E90FA',
        shadowOpacity: 0.55,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 0 },
    },
    proTitle: {
        fontSize: 28,
        color: '#FFFFFF',
        textAlign: 'center',
        fontFamily: 'Montserrat_700Bold',
    },
    proSubtext: {
        fontSize: 15,
        color: '#94A3B8',
        marginTop: 10,
        textAlign: 'center',
        fontFamily: 'Montserrat_500Medium',
    },
});
