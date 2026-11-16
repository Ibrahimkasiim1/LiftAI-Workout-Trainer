// app/plan-expired.tsx
/**
 * Plan Expired screen.
 *
 * Shown once when a user's subscription lapses and they return to the app.
 * Delegates the upgrade UI entirely to the RevenueCat paywall — no native
 * paywall is built in-app. If the user dismisses the paywall, they continue
 * on the free tier (this screen does not hard-gate the app).
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../constants/theme';
import { useSubscription } from '../context/SubscriptionContext';
import { useTheme } from '../context/ThemeContext';
import { presentPaywall } from '../services/PaywallService';

export default function PlanExpiredScreen() {
    const router = useRouter();
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const { checkSubscription, isLoading, isInitialized, revenueCatUsable } = useSubscription();

    const triggered = useRef(false);

    useEffect(() => {
        if (triggered.current) return;
        if (!isInitialized || isLoading) return;

        triggered.current = true;

        (async () => {
            try {
                if (revenueCatUsable) {
                    await presentPaywall('soft', 'plan_expired', async () => {
                        return await checkSubscription(true);
                    });
                }
            } finally {
                router.replace('/(tabs)');
            }
        })();
    }, [isInitialized, isLoading, revenueCatUsable, checkSubscription, router]);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
