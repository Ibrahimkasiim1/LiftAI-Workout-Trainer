// app/settings/index.tsx
/**
 * Settings Screen
 * 
 * Route: /settings
 * Function: User account and app settings management
 * 
 * Features:
 * - Subscription/Upgrade section
 * - Account management (Profile, Privacy, Subscription)
 * - General settings (Dark Mode, Notifications, Language, Units, Help, About)
 * - Theme switching (light/dark mode)
 * - Notification preferences
 * - Units preference
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Linking,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useSubscription } from '../../context/SubscriptionContext';
import { useTheme } from '../../context/ThemeContext';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { useUserQuota } from '../../hooks/useUserQuota';
import { presentPaywall } from '../../services/PaywallService';
import {
    getReminderHourOverride,
    setReminderHourOverride,
} from '../../utils/engagementNotifications';
import { checkNotificationPermissions } from '../../utils/notifications';
import { formatResetClock, formatResetCountdown } from '../../utils/quotaReset';
import { replaceWithSignedOutRoot } from '../../utils/authNavigation';
import { getSession, signOut, supabase } from '../../utils/supabase';
import { getWeightUnit } from '../../utils/weightConverter';
import { posthog } from '../../src/config/posthog';

export default function SettingsScreen() {
    const router = useRouter();
    const { isDark, toggleTheme } = useTheme();
    const { isPro, restorePurchases, customerInfo, checkSubscription } = useSubscription();
    const { quota, budgetPercent, nextResetAt, refetch: refetchQuota } = useUserQuota();

    useFocusEffect(
        useCallback(() => {
            void refetchQuota();
        }, [refetchQuota])
    );
    const colors = getThemeColors(isDark);

    const [loading, setLoading] = useState(true);
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('kg');
    const [restoringPurchases, setRestoringPurchases] = useState(false);
    const [reminderHour, setReminderHour] = useState<number | 'auto'>('auto');
    const [reminderPickerOpen, setReminderPickerOpen] = useState(false);

    useEffect(() => {
        loadSettings();
    }, []);

    /**
     * Load all settings
     */
    const loadSettings = async () => {
        try {
            setLoading(true);

            // Load notification status
            const hasNotifications = await checkNotificationPermissions();
            setNotificationsEnabled(hasNotifications);

            // Load weight unit
            const unit = await getWeightUnit();
            setWeightUnit(unit);

            // Load daily reminder time override ('auto' = learned hour)
            const overrideHour = await getReminderHourOverride();
            setReminderHour(overrideHour ?? 'auto');

        } catch (error) {
            console.error('Error loading settings:', error);
        } finally {
            setLoading(false);
        }
    };

    /**
     * Handle notification toggle
     */
    const handleNotificationToggle = async (value: boolean) => {
        try {
            setNotificationsEnabled(value);

            const session = await getSession();
            if (session) {
                await supabase
                    .from('user_profiles')
                    .update({ notifications_enabled: value })
                    .eq('id', session.user.id);
            }

            if (value) {
                // Request notification permissions if enabling
                const { requestNotificationPermissions } = await import('../../utils/notifications');
                const granted = await requestNotificationPermissions();
                posthog.capture('notification_permission_result', { granted, source: 'settings' });
                if (granted) {
                    const { syncPushToken } = await import('../../utils/pushTokens');
                    void syncPushToken(session?.user?.id);
                }
            }

            // Re-run the scheduler now (force bypasses its 6h throttle): it
            // honors notifications_enabled, so turning the switch off actually
            // cancels everything instead of waiting for the next refresh.
            if (session) {
                const { refreshEngagementNotifications } = await import(
                    '../../utils/engagementNotifications'
                );
                void refreshEngagementNotifications(session.user.id, { force: true });
            }
        } catch (error) {
            console.error('Error toggling notifications:', error);
            toast.error('Failed to update notification settings');
            setNotificationsEnabled(!value); // Revert on error
        }
    };

    /**
     * Handle picking a daily reminder time. 'auto' means the scheduler uses
     * the hour the user usually trains (learned from completions), falling
     * back to 9 am. A number pins the reminder to that hour.
     */
    const handleReminderHourSelect = async (value: number | 'auto') => {
        try {
            setReminderHour(value);
            setReminderPickerOpen(false);
            await setReminderHourOverride(value);
            posthog.capture('reminder_time_changed', {
                hour: value === 'auto' ? null : value,
                auto: value === 'auto',
            });
            const session = await getSession();
            if (session) {
                const { refreshEngagementNotifications } = await import(
                    '../../utils/engagementNotifications'
                );
                void refreshEngagementNotifications(session.user.id, { force: true });
            }
        } catch (error) {
            console.error('Error setting reminder time:', error);
            toast.error('Failed to update reminder time');
        }
    };

    const formatReminderHour = (value: number | 'auto'): string => {
        if (value === 'auto') return 'Auto';
        const suffix = value >= 12 ? 'PM' : 'AM';
        const hour12 = value % 12 === 0 ? 12 : value % 12;
        return `${hour12} ${suffix}`;
    };

    /**
     * Handle restore purchases
     */
    const handleRestorePurchases = async () => {
        try {
            setRestoringPurchases(true);
            const result = await restorePurchases();

            if (result.success && result.isSubscribed) {
                posthog.capture('purchases_restored');
                toast.success('Purchases restored', 'Your subscription has been restored successfully.');
            } else if (result.success && !result.isSubscribed) {
                toast.info('No active subscription', 'No active subscription was found for your account.');
            } else {
                toast.error(result.error || 'Failed to restore purchases.');
            }
        } catch (error) {
            console.error('Error restoring purchases:', error);
            toast.error('Failed to restore purchases', 'Please try again.');
        } finally {
            setRestoringPurchases(false);
        }
    };



    /**
     * Get subscription plan term (Monthly/Yearly)
     */
    const getPlanTerm = () => {
        const proEntitlement = customerInfo?.entitlements.active['Pro Access'];
        if (proEntitlement) {
            const productId = proEntitlement.productIdentifier || '';
            if (productId.includes('yearly') || productId.includes('annual')) {
                return 'Yearly';
            } else if (productId.includes('monthly')) {
                return 'Monthly';
            }
        }
        return 'Monthly';
    };

    /**
     * Get subscription renewal date text
     */
    const getSubscriptionRenewalText = () => {
        const proEntitlement = customerInfo?.entitlements.active['Pro Access'];
        if (proEntitlement) {
            const expirationDate = proEntitlement.expirationDate;
            if (expirationDate) {
                const date = new Date(expirationDate);
                const formattedDate = date.toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                });
                return proEntitlement.willRenew
                    ? `Renews ${formattedDate}`
                    : `Expires ${formattedDate}`;
            }
            return 'Lifetime Access';
        }
        return 'Active';
    };

    /**
     * Handle sign out
     */
    const handleSignOut = async () => {
        const ok = await confirmSheet({
            title: 'Sign Out',
            message: 'Are you sure you want to sign out?',
            confirmLabel: 'Sign Out',
            destructive: true,
        });
        if (!ok) return;
        const { error } = await signOut();
        if (error) {
            toast.error('Failed to sign out', 'Please try again.');
            return;
        }
        posthog.capture('user_signed_out');
        posthog.reset();
        replaceWithSignedOutRoot();
    };

    /**
     * Navigate to profile information
     */
    const handleProfileInformation = () => {
        router.push('/settings/profile-information');
    };



    /**
     * Navigate to units preference
     */
    const handleUnits = () => {
        router.push('/settings/units');
    };

    /**
     * Open help center
     */
    const handleHelpCenter = async () => {
        try {
            const url = 'https://liftaiapp.com/help';
            const canOpen = await Linking.canOpenURL(url);
            if (canOpen) {
                await Linking.openURL(url);
            } else {
                toast.error('Unable to open Help Center');
            }
        } catch (error) {
            console.error('Error opening Help Center:', error);
            toast.error('Unable to open Help Center');
        }
    };

    /**
     * Open about screen
     */
    const handleAbout = () => {
toast.info('LiftAI v1.0.0', 'Your AI-powered fitness assistant');
    };

    if (loading) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.text }]}>Loading settings...</Text>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                    >
                        <Ionicons name="chevron-back" size={26} color={colors.text} />
                    </TouchableOpacity>
                    <Text style={[styles.title, { color: colors.text }]}>Account</Text>
                    <View style={styles.placeholder} />
                </View>

                {/* Subscription Section — driven by the single `isPro` source of
                    truth (server-verified tier + optimistic SDK unlock), so it
                    always agrees with feature gating and the backend. */}
                {isPro ? (
                    /* ── Pro: existing active-subscription card ── */
                    <View style={[styles.subscriptionCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border
                    }]}>
                        <View style={styles.subscriptionHeader}>
                            <View style={{ flex: 1 }}>
                                <Text style={[styles.appName, { color: colors.text }]}>LiftAI Pro</Text>
                                <Text style={[styles.planTerm, { color: colors.textMuted }]}>
                                    {getPlanTerm()} Subscription
                                </Text>
                            </View>
                            <View style={[styles.proBadge, { backgroundColor: colors.success + '20' }]}>
                                <View style={[styles.activeDot, { backgroundColor: colors.success }]} />
                                <Text style={[styles.proBadgeText, { color: colors.success }]}>Active</Text>
                            </View>
                        </View>
                        <Text style={[styles.subscriptionSubtext, { color: colors.textMuted }]}>
                            {getSubscriptionRenewalText()}
                        </Text>
                        <TouchableOpacity
                            style={[styles.viewDetailsButton, { borderColor: colors.text }]}
                            onPress={() => router.push('/settings/subscription')}
                        >
                            <Text style={[styles.viewDetailsButtonText, { color: colors.text }]}>
                                View Details
                            </Text>
                            <Ionicons name="chevron-forward" size={16} color={colors.text} />
                        </TouchableOpacity>
                    </View>
                ) : (
                    /* ── Free tier: minimal upgrade row ── */
                    <View style={[styles.subscriptionCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border,
                    }]}>
                        <View style={styles.subscriptionHeader}>
                            <View style={{ flex: 1 }}>
                                <Text style={[styles.appName, { color: colors.text }]}>Free Plan</Text>
                                <Text style={[styles.planTerm, { color: colors.textMuted }]}>
                                    {quota && budgetPercent != null
                                        ? `AI usage: ${budgetPercent}%`
                                        : 'Limited AI usage'}
                                </Text>
                                <Text style={[styles.planTerm, { color: colors.textMuted }]}>
                                    Resets at {formatResetClock(nextResetAt)} · in {formatResetCountdown(nextResetAt)}
                                </Text>
                            </View>
                        </View>
                        <TouchableOpacity
                            style={[styles.upgradeNowButton, { backgroundColor: colors.primary }]}
                            onPress={() =>
                                presentPaywall('soft', 'settings_upgrade', async () => {
                                    return await checkSubscription(true);
                                })
                            }
                            activeOpacity={0.85}
                        >
                            <Text style={styles.upgradeNowButtonText}>Upgrade now</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Account Management Section */}
                <View style={styles.section}>
                    <View style={[styles.settingsCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border
                    }]}>
                        <TouchableOpacity
                            style={styles.settingItem}
                            onPress={handleProfileInformation}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="person-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Profile Information</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.settingItem}
                            onPress={() => router.push('/settings/training-setup' as any)}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="barbell-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Training Setup</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.settingItem}
                            onPress={() => router.push('/settings/coach-memory' as any)}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="sparkles-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Coach Memory</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.settingItem, styles.settingItemLast]}
                            onPress={() => router.push('/settings/subscription')}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="card-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Subscription & Billing</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* General Settings Section */}
                <View style={styles.section}>
                    <View style={[styles.settingsCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border
                    }]}>
                        {/* Dark Mode Toggle */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingLeft}>
                                <Ionicons
                                    name={isDark ? "moon" : "sunny-outline"}
                                    size={20}
                                    color={colors.text}
                                />
                                <Text style={[styles.settingText, { color: colors.text }]}>Dark Mode</Text>
                            </View>
                            <Switch
                                value={isDark}
                                onValueChange={toggleTheme}
                                trackColor={{ false: colors.border, true: colors.primary }}
                                thumbColor={colors.text}
                            />
                        </View>

                        {/* Notifications Toggle */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingLeft}>
                                <Ionicons name="notifications-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Notifications</Text>
                            </View>
                            <Switch
                                value={notificationsEnabled}
                                onValueChange={handleNotificationToggle}
                                trackColor={{ false: colors.border, true: colors.primary }}
                                thumbColor={colors.text}
                            />
                        </View>

                        {/* Daily reminder time (only meaningful with notifications on) */}
                        {notificationsEnabled && (
                            <>
                                <TouchableOpacity
                                    style={styles.settingItem}
                                    onPress={() => setReminderPickerOpen((open) => !open)}
                                >
                                    <View style={styles.settingLeft}>
                                        <Ionicons name="alarm-outline" size={20} color={colors.text} />
                                        <Text style={[styles.settingText, { color: colors.text }]} numberOfLines={1}>Reminder Time</Text>
                                    </View>
                                    <View style={styles.settingRight}>
                                        <Text
                                            style={[styles.settingValue, { color: colors.textMuted }]}
                                            numberOfLines={1}
                                        >
                                            {reminderHour === 'auto'
                                                ? 'Auto (your usual time)'
                                                : formatReminderHour(reminderHour)}
                                        </Text>
                                        <Ionicons
                                            name={reminderPickerOpen ? 'chevron-up' : 'chevron-forward'}
                                            size={20}
                                            color={colors.textMuted}
                                        />
                                    </View>
                                </TouchableOpacity>
                                {reminderPickerOpen && (
                                    <View style={styles.reminderChipWrap}>
                                        {(['auto', 6, 7, 8, 9, 12, 17, 18, 19] as const).map((value) => {
                                            const selected = reminderHour === value;
                                            return (
                                                <TouchableOpacity
                                                    key={String(value)}
                                                    style={[
                                                        styles.reminderChip,
                                                        { borderColor: selected ? colors.primary : colors.border },
                                                        selected && { backgroundColor: `${colors.primary}1A` },
                                                    ]}
                                                    onPress={() => handleReminderHourSelect(value)}
                                                >
                                                    <Text
                                                        style={[
                                                            styles.reminderChipText,
                                                            { color: selected ? colors.primary : colors.text },
                                                        ]}
                                                    >
                                                        {value === 'auto' ? 'Auto' : formatReminderHour(value)}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                )}
                            </>
                        )}

                        {/* Units */}
                        <TouchableOpacity
                            style={styles.settingItem}
                            onPress={handleUnits}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="resize-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Units</Text>
                            </View>
                            <View style={styles.settingRight}>
                                <Text style={[styles.settingValue, { color: colors.textMuted }]}>
                                    {weightUnit === 'kg' ? 'Metric (kg, cm)' : 'Imperial (lbs, ft)'}
                                </Text>
                                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                            </View>
                        </TouchableOpacity>

                        {/* Help Center */}
                        <TouchableOpacity
                            style={styles.settingItem}
                            onPress={handleHelpCenter}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="help-circle-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>Help Center</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>

                        {/* About */}
                        <TouchableOpacity
                            style={[styles.settingItem, styles.settingItemLast]}
                            onPress={handleAbout}
                        >
                            <View style={styles.settingLeft}>
                                <Ionicons name="information-circle-outline" size={20} color={colors.text} />
                                <Text style={[styles.settingText, { color: colors.text }]}>About</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Restore Purchases */}
                {!isPro && (
                    <TouchableOpacity
                        style={styles.restoreButton}
                        onPress={handleRestorePurchases}
                        disabled={restoringPurchases}
                    >
                        {restoringPurchases ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                            <Text style={[styles.restoreButtonText, { color: colors.primary }]}>
                                Restore Purchases
                            </Text>
                        )}
                    </TouchableOpacity>
                )}

                {/* Sign Out */}
                <TouchableOpacity
                    style={[styles.signOutButton, { borderColor: colors.error }]}
                    onPress={handleSignOut}
                >
                    <Ionicons name="log-out-outline" size={20} color={colors.error} />
                    <Text style={[styles.signOutButtonText, { color: colors.error }]}>Sign Out</Text>
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        fontSize: 16,
        marginTop: 12,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
        paddingBottom: 40,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 24,
    },
    backButton: {
        padding: 4,
    },
    title: {
        fontSize: 28,
        fontWeight: 'bold',
    },
    placeholder: {
        width: 32,
    },
    section: {
        marginBottom: 24,
    },
    subscriptionCard: {
        borderRadius: 16,
        padding: 20,
        marginBottom: 24,
        borderWidth: 1,
    },
    subscriptionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    appName: {
        fontSize: 24,
        fontWeight: 'bold',
        marginRight: 12,
    },
    planTerm: {
        fontSize: 14,
        marginTop: 2,
    },
    proBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 8,
    },
    activeDot: {
        width: 6,
        height: 6,
        borderRadius: 4,
    },
    proBadgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
    subscriptionSubtext: {
        fontSize: 14,
        marginBottom: 16,
    },
    viewDetailsButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 12,
        borderWidth: 1.5,
        gap: 8,
    },
    viewDetailsButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    settingsCard: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 20,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(128, 128, 128, 0.2)',
    },
    settingItemLast: {
        borderBottomWidth: 0,
    },
    settingLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        flex: 1,
    },
    settingText: {
        fontSize: 16,
        fontWeight: '500',
    },
    settingRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        // Long values ("Auto (your usual time)") must shrink and truncate
        // instead of colliding with the row label on narrow screens.
        flexShrink: 1,
        marginLeft: 12,
    },
    settingValue: {
        fontSize: 14,
        flexShrink: 1,
        textAlign: 'right',
    },
    reminderChipWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(128, 128, 128, 0.2)',
    },
    reminderChip: {
        borderWidth: 1,
        borderRadius: 999,
        paddingVertical: 7,
        paddingHorizontal: 14,
    },
    reminderChipText: {
        fontSize: 13,
        fontWeight: '600',
    },
    restoreButton: {
        alignItems: 'center',
        paddingVertical: 16,
        marginBottom: 16,
    },
    restoreButtonText: {
        fontSize: 14,
        fontWeight: '500',
    },
    signOutButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        borderRadius: 12,
        borderWidth: 1,
        gap: 8,
    },
    signOutButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    upgradeNowButton: {
        marginTop: 16,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    upgradeNowButtonText: {
        color: '#FFF',
        fontSize: 15,
        fontWeight: '600',
    },
});
