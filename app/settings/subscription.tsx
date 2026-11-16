// app/settings/subscription.tsx
/**
 * Subscription Screen
 *
 * Shows different views depending on tier:
 *   premium  → existing plan details + manage subscription
 *   ad_supported → upgrade CTA with RevenueCat packages + usage summary
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Linking,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useSubscription } from '../../context/SubscriptionContext';
import { useTheme } from '../../context/ThemeContext';
import { toast } from '../../components/ui/Toast';
import { presentPaywall } from '../../services/PaywallService';

export default function SubscriptionScreen() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const {
        isPro,
        isLoading,
        customerInfo,
        restorePurchases,
        checkSubscription,
    } = useSubscription();

    const [restoringPurchases, setRestoringPurchases] = useState(false);
    const [presentingPaywall, setPresentingPaywall] = useState(false);

    // Open the 3rd-party RevenueCat paywall on demand (button tap). We don't
    // auto-present on mount — this is a deliberate settings sub-page, not a
    // redirect — so the user sees an explicit upgrade screen first.
    const openPaywall = useCallback(async () => {
        setPresentingPaywall(true);
        try {
            await presentPaywall('soft', 'settings_upgrade', async () => {
                return await checkSubscription(true);
            });
        } finally {
            setPresentingPaywall(false);
        }
    }, [checkSubscription]);

    // ── helpers ──────────────────────────────────────────────────────────────

    const getPlanName = () => {
        const ent = customerInfo?.entitlements.active['Pro Access'];
        if (!ent) return 'LiftAI Pro';
        const id = ent.productIdentifier ?? '';
        if (id.includes('yearly') || id.includes('annual')) return 'LiftAI Pro (Yearly)';
        if (id.includes('monthly')) return 'LiftAI Pro (Monthly)';
        return 'LiftAI Pro';
    };

    const getRenewalDateText = () => {
        const ent = customerInfo?.entitlements.active['Pro Access'];
        if (!ent?.expirationDate) return null;
        return new Date(ent.expirationDate).toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric',
        });
    };

    const getStatusDetails = () => {
        const ent = customerInfo?.entitlements.active['Pro Access'];
        if (ent?.willRenew) {
            return { status: 'Active', description: 'Your subscription will auto-renew', color: colors.success };
        }
        if (ent) {
            return { status: 'Active (Non-Renewing)', description: 'Your subscription will not auto-renew', color: colors.warning };
        }
        return { status: 'Active', description: 'You have full access to all features', color: colors.success };
    };

    const handleManageSubscription = async () => {
        try {
            const url = Platform.OS === 'ios'
                ? 'https://apps.apple.com/account/subscriptions'
                : 'https://play.google.com/store/account/subscriptions';
            await Linking.openURL(url);
        } catch {
            toast.error('Unable to open subscription management');
        }
    };

    const handleRestorePurchases = async () => {
        try {
            setRestoringPurchases(true);
            const result = await restorePurchases();
            if (result.success && result.isSubscribed) {
                toast.success('Purchases restored', 'Your subscription has been restored successfully.');
            } else if (result.success && !result.isSubscribed) {
                toast.info('No purchase found', 'No active subscription was found for your account.');
            } else {
                toast.error('Restore failed', result.error ?? 'Please try again.');
            }
        } finally {
            setRestoringPurchases(false);
        }
    };

    // ── loading ───────────────────────────────────────────────────────────────

    if (isLoading) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.centered}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.text }]}>Loading subscription...</Text>
                </View>
            </SafeAreaView>
        );
    }

    // ── pro view ─────────────────────────────────────────────────────────────

    // `isPro` is the single source of truth (server-verified DB tier, with the
    // live SDK entitlement OR-ed in as an optimistic post-purchase unlock), so
    // this card always agrees with feature gating and the backend.
    if (isPro) {
        const statusDetails = getStatusDetails();
        const renewalDate = getRenewalDateText();

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                    {/* Header is the native stack header (see settings/_layout.tsx) */}
                    <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                        <View style={styles.cardHeader}>
                            <View style={{ flex: 1, gap: 8 }}>
                                <Text style={[styles.planName, { color: colors.text }]}>{getPlanName()}</Text>
                                <View style={[styles.badge, { backgroundColor: statusDetails.color + '20' }]}>
                                    <View style={[styles.dot, { backgroundColor: statusDetails.color }]} />
                                    <Text style={[styles.badgeText, { color: statusDetails.color }]}>{statusDetails.status}</Text>
                                </View>
                            </View>
                            <Ionicons name="diamond" size={32} color={colors.primary} />
                        </View>
                        <Text style={[styles.cardSub, { color: colors.textSecondary }]}>{statusDetails.description}</Text>
                    </View>

                    <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                        <Text style={[styles.cardTitle, { color: colors.text }]}>Your Benefits</Text>
                        {[
                            'Unlimited AI chat messages',
                            'Unlimited AI meal logging',
                            'Unlimited smart exercise swaps',
                            'Personalized training recommendations',
                            'Advanced progress analytics',
                        ].map((f, i) => (
                            <View key={i} style={styles.featureRow}>
                                <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                                <Text style={[styles.featureText, { color: colors.text }]}>{f}</Text>
                            </View>
                        ))}
                    </View>

                    {renewalDate && (
                        <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                            <View style={styles.renewalRow}>
                                <Ionicons name="calendar-outline" size={20} color={colors.info} />
                                <Text style={[styles.renewalLabel, { color: colors.textSecondary }]}>Renewal Date</Text>
                            </View>
                            <Text style={[styles.renewalDate, { color: colors.text }]}>{renewalDate}</Text>
                        </View>
                    )}

                    <TouchableOpacity
                        style={[styles.outlineBtn, { borderColor: colors.text }]}
                        onPress={handleManageSubscription}
                    >
                        <Ionicons name="settings-outline" size={20} color={colors.text} />
                        <Text style={[styles.outlineBtnText, { color: colors.text }]}>Manage Subscription</Text>
                    </TouchableOpacity>

                    <Text style={[styles.legalText, { color: colors.textMuted }]}>
                        {Platform.OS === 'ios'
                            ? 'Subscriptions are managed through the App Store.'
                            : 'Subscriptions are managed through Google Play.'}
                    </Text>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ── free / upgrade view ───────────────────────────────────────────────────

    // Free / non-subscribed users: the RevenueCat paywall auto-presents via the
    // effect above. While it's presenting we show a spinner; if it gets dismissed
    // or fails to present, we fall back to an explicit upgrade screen with a back
    // button so the user is never stranded on an endless spinner.
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            {/* Native stack header shows "Subscription"; override for the free view */}
            <Stack.Screen options={{ title: 'Upgrade' }} />

            {presentingPaywall ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : (
                <View style={[styles.centered, { paddingHorizontal: 24, gap: 16 }]}>
                    <Ionicons name="diamond" size={40} color={colors.primary} />
                    <Text style={[styles.title, { color: colors.text, textAlign: 'center' }]}>
                        Upgrade to LiftAI Pro
                    </Text>
                    <Text style={[styles.cardSub, { color: colors.textSecondary, textAlign: 'center' }]}>
                        Unlock unlimited AI chat, meal logging, smart swaps, and advanced analytics.
                    </Text>

                    <TouchableOpacity
                        style={[styles.upgradeBtn, { backgroundColor: colors.primary, alignSelf: 'stretch' }]}
                        onPress={openPaywall}
                        activeOpacity={0.85}
                    >
                        <Text style={styles.upgradeBtnText}>See plans</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.restoreBtn}
                        onPress={handleRestorePurchases}
                        disabled={restoringPurchases}
                    >
                        <Text style={[styles.restoreBtnText, { color: colors.textSecondary }]}>
                            {restoringPurchases ? 'Restoring…' : 'Restore purchases'}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loadingText: { fontSize: 16, marginTop: 12 },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 48 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 28,
    },
    backButton: { padding: 4 },
    title: { fontSize: 24, fontWeight: 'bold' },
    placeholder: { width: 32 },
    card: {
        borderRadius: 16,
        padding: 20,
        borderWidth: 1,
        marginBottom: 20,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 12,
    },
    cardTitle: { fontSize: 17, fontWeight: '600', marginBottom: 16 },
    cardSub: { fontSize: 14 },
    planName: { fontSize: 22, fontWeight: '700' },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 4,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    badgeText: { fontSize: 12, fontWeight: '600' },
    featureRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
    },
    featureText: { fontSize: 15, flex: 1 },
    proBadgeSmall: {
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    proBadgeSmallText: { fontSize: 10, fontWeight: '700' },
    renewalRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
    },
    renewalLabel: { fontSize: 14, fontWeight: '600' },
    renewalDate: { fontSize: 18, fontWeight: '700' },
    outlineBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1.5,
        gap: 8,
        marginBottom: 16,
    },
    outlineBtnText: { fontSize: 16, fontWeight: '600' },
    usageGrid: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 16,
    },
    usageTile: {
        flex: 1,
        borderRadius: 12,
        borderWidth: 1,
        padding: 12,
        gap: 4,
        alignItems: 'center',
    },
    usageTileLabel: { fontSize: 11 },
    usageTileCount: { fontSize: 14, fontWeight: '700' },
    usageBar: {
        width: '100%',
        height: 3,
        borderRadius: 4,
        marginTop: 4,
        overflow: 'hidden',
    },
    usageBarFill: {
        height: '100%',
        borderRadius: 4,
    },
    pkgCard: {
        borderRadius: 16,
        borderWidth: 2,
        paddingHorizontal: 16,
        paddingVertical: 16,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    pkgLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    pkgRadio: { width: 20, height: 20, borderRadius: 12, borderWidth: 2 },
    pkgLabel: { fontSize: 16, fontWeight: '600' },
    saveBadge: {
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 2,
        marginTop: 4,
        alignSelf: 'flex-start',
    },
    saveBadgeText: { fontSize: 11, fontWeight: '700' },
    pkgPrice: { fontSize: 18, fontWeight: '700' },
    pkgPriceSuffix: { fontSize: 13, fontWeight: '400' },
    upgradeBtn: {
        borderRadius: 16,
        paddingVertical: 16,
        alignItems: 'center',
        marginBottom: 8,
    },
    upgradeBtnText: { color: '#FFF', fontSize: 17, fontWeight: '700' },
    restoreBtn: { alignItems: 'center', paddingVertical: 16, marginBottom: 8 },
    restoreBtnText: { fontSize: 14, fontWeight: '500' },
    legalText: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
});
