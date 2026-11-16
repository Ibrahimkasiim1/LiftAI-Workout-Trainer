// app/notification-setup.tsx
/**
 * Notification Setup Screen
 * 
 * Route: /notification-setup
 * Function: Request notification permissions for workout reminders
 * 
 * Features:
 * - Request notification permissions from user
 * - Animated UI with bell icon and checkmark
 * - Permission status checking and handling
 * - Redirect to app settings if permissions denied
 * - Integration with notification system
 * - Motivational messaging and workout reminders
 * - Permission state management and validation
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../constants/theme';
import { useColors } from '../../hooks/useColors';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import {
  checkNotificationPermissions,
  openAppSettings,
  requestNotificationPermissions
} from '../../utils/notifications';
import { scheduleFirstWorkoutReminder } from '../../utils/engagementNotifications';
import { writeFunnelSnapshot } from '../../utils/funnelState';
import { posthog } from '../../src/config/posthog';
import { supabase } from '../../utils/supabase';

export default function NotificationSetupScreen() {
  const router = useRouter();
  const colors = useColors();
  const { session, loading: authLoading } = useRequireAuth();
  // Set when the user tapped "remind me later" on the first-workout screen —
  // a grant here should immediately schedule that reminder.
  const params = useLocalSearchParams<{ firstWorkoutReminder?: string; estimatedMinutes?: string }>();

  const [loading, setLoading] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<'undetermined' | 'granted' | 'denied'>('undetermined');

  // Animation values
  const bellScale = useSharedValue(1);
  const bellRotation = useSharedValue(0);
  const checkmarkOpacity = useSharedValue(0);

  useEffect(() => {
    if (!authLoading && session) {
      checkInitialPermissionStatus();
      startBellAnimation();
    }
  }, [authLoading, session]);

  useEffect(() => {
    if (!authLoading && session) {
      writeFunnelSnapshot('notification_setup', {
        route: '/onboarding/notification-setup',
        reason: 'notification_setup_screen',
      });
    }
  }, [authLoading, session]);

  const navigateToMainApp = async () => {
    await writeFunnelSnapshot('main_app', {
      route: '/(tabs)',
      reason: 'notification_flow_finished',
    });
    router.replace('/(tabs)');
  };

  /**
   * Check if notifications are already enabled
   */
  const checkInitialPermissionStatus = async () => {
    if (!session) return;

    try {
      const hasPermission = await checkNotificationPermissions();
      if (hasPermission) {
        setPermissionStatus('granted');

        // Mark permission as requested in database if not already marked
        await supabase
          .from('user_profiles')
          .update({
            notifications_enabled: true,
            notification_permission_requested: true
          })
          .eq('id', session.user.id);

        // Auto-navigate to main app after a short delay (permission already granted)
        setTimeout(() => {
          void navigateToMainApp();
        }, 1500);
      }
    } catch (error) {
      console.error('Error checking notification status:', error);
    }
  };

  /**
   * Start bell animation
   */
  const startBellAnimation = () => {
    bellScale.value = withRepeat(
      withSequence(
        withTiming(1.1, { duration: 1000 }),
        withTiming(1, { duration: 1000 })
      ),
      -1,
      true
    );

    bellRotation.value = withRepeat(
      withSequence(
        withTiming(-10, { duration: 500 }),
        withTiming(10, { duration: 500 }),
        withTiming(0, { duration: 500 })
      ),
      -1,
      true
    );
  };

  /**
   * Handle enable notifications button press
   */
  const handleEnableNotifications = async () => {
    if (!session) return;

    try {
      setLoading(true);

      const granted = await requestNotificationPermissions();
      posthog.capture('notification_permission_result', { granted, source: 'onboarding' });

      if (granted) {
        setPermissionStatus('granted');

        // Update user profile in Supabase
        await supabase
          .from('user_profiles')
          .update({
            notifications_enabled: true,
            notification_permission_requested: true
          })
          .eq('id', session.user.id);

        // Register this device for coach push notifications.
        void import('../../utils/pushTokens').then(({ syncPushToken }) =>
          syncPushToken(session.user.id)
        );

        // Deliver the first-workout reminder they asked for on the previous
        // screen — this grant exists because of that request.
        if (params.firstWorkoutReminder === '1') {
          const mins = Number(params.estimatedMinutes);
          void scheduleFirstWorkoutReminder(Number.isFinite(mins) && mins > 0 ? mins : null);
        }

        // Show success animation
        checkmarkOpacity.value = withTiming(1, { duration: 500 });

        // Navigate to main app after success animation
        setTimeout(() => {
          void navigateToMainApp();
        }, 1500);

      } else {
        setPermissionStatus('denied');
        showPermissionDeniedAlert();
      }

    } catch (error) {
      console.error('Error enabling notifications:', error);
      toast.error('Failed to enable notifications', 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle skip button press
   */
  const handleSkip = async () => {
    if (!session) return;
    posthog.capture('notification_permission_result', { granted: false, skipped: true, source: 'onboarding' });

    // Both the skip and the permission-denied paths land here. If the user
    // came from "Remind me later today" on the first-workout screen, that
    // reminder can't be delivered without permission — say so instead of
    // silently breaking the promise.
    if (params.firstWorkoutReminder === '1') {
      toast.info(
        'No reminder set',
        "Notifications are off, so we can't nudge you later — your first workout is waiting on the home screen."
      );
    }

    try {
      // Update user profile to mark permission as requested
      await supabase
        .from('user_profiles')
        .update({ notification_permission_requested: true })
        .eq('id', session.user.id);

      await navigateToMainApp();
    } catch (error) {
      console.error('Error updating user profile:', error);
      await navigateToMainApp();
    }
  };

  /**
   * Show alert when permission is denied
   */
  const showPermissionDeniedAlert = async () => {
    const openSettings = await confirmSheet({
      title: 'Notifications Disabled',
      message: 'To receive workout reminders, please enable notifications in your device settings.',
      confirmLabel: 'Open Settings',
      cancelLabel: 'Skip',
    });
    if (openSettings) {
      openAppSettings();
      // Still allow user to continue
      setTimeout(handleSkip, 2000);
    } else {
      void handleSkip();
    }
  };

  /**
   * Animated bell icon style
   */
  const bellAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: bellScale.value },
      { rotate: `${bellRotation.value}deg` }
    ],
  }));

  /**
   * Animated checkmark style
   */
  const checkmarkAnimatedStyle = useAnimatedStyle(() => ({
    opacity: checkmarkOpacity.value,
    transform: [{ scale: checkmarkOpacity.value }],
  }));

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        {/* Animated Bell Icon */}
        <Animated.View style={[styles.iconContainer, bellAnimatedStyle]}>
          <Ionicons
            name="notifications"
            size={80}
            color={permissionStatus === 'granted' ? colors.success : colors.primary}
          />
        </Animated.View>

        {/* Success Checkmark */}
        {permissionStatus === 'granted' && (
          <Animated.View style={[styles.checkmarkContainer, checkmarkAnimatedStyle]}>
            <Ionicons name="checkmark-circle" size={40} color={colors.success} />
          </Animated.View>
        )}

        {/* Title */}
        <Text style={[styles.title, { color: colors.text }]}>Stay on Track 🔔</Text>

        {/* Subtitle */}
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Enable notifications to receive workout reminders and stay motivated!
        </Text>

        {/* Benefits List */}
        <View style={styles.benefitsContainer}>
          <View style={styles.benefitItem}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={[styles.benefitText, { color: colors.text }]}>Daily workout reminders</Text>
          </View>

          <View style={styles.benefitItem}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={[styles.benefitText, { color: colors.text }]}>Motivational messages</Text>
          </View>

          <View style={styles.benefitItem}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={[styles.benefitText, { color: colors.text }]}>Progress updates</Text>
          </View>

          <View style={styles.benefitItem}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={[styles.benefitText, { color: colors.text }]}>Rest day reminders</Text>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={styles.buttonContainer}>
          {permissionStatus === 'granted' ? (
            <View style={styles.successContainer}>
              <Text style={[styles.successText, { color: colors.success }]}>Notifications enabled! 🎉</Text>
              <Text style={[styles.successSubtext, { color: colors.textMuted }]}>
                {"You'll receive workout reminders"}
              </Text>
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: colors.text }, loading && styles.buttonDisabled]}
                onPress={handleEnableNotifications}
                disabled={loading}
              >
                {loading ? (
                  <Text style={[styles.primaryButtonText, { color: colors.textInverse }]}>Enabling...</Text>
                ) : (
                  <>
                    <Ionicons name="notifications" size={20} color={colors.textInverse} />
                    <Text style={[styles.primaryButtonText, { color: colors.textInverse }]}>Enable Notifications</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: colors.border }]}
                onPress={handleSkip}
                disabled={loading}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.textMuted }]}>Maybe Later</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Info Text */}
        <Text style={[styles.infoText, { color: colors.textMuted }]}>
          You can change this setting anytime in your device settings.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  iconContainer: {
    marginBottom: 32,
    alignItems: 'center',
  },
  checkmarkContainer: {
    position: 'absolute',
    top: 20,
    right: 20,
  },
  title: {
    fontSize: theme.typography.fontSize['4xl'],
    fontFamily: theme.typography.fontFamily.bold,
    textAlign: 'center',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: theme.typography.fontSize.lg,
    fontFamily: theme.typography.fontFamily.regular,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 40,
  },
  benefitsContainer: {
    width: '100%',
    marginBottom: 48,
  },
  benefitItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  benefitText: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.medium,
    marginLeft: 12,
  },
  buttonContainer: {
    width: '100%',
    marginBottom: 24,
  },
  primaryButton: {
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    fontSize: theme.typography.fontSize.lg,
    fontFamily: theme.typography.fontFamily.bold,
    marginLeft: 8,
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing.xl,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  successContainer: {
    alignItems: 'center',
    padding: 20,
  },
  successText: {
    fontSize: theme.typography.fontSize.xl,
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 8,
  },
  successSubtext: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
    textAlign: 'center',
  },
  infoText: {
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.regular,
    textAlign: 'center',
    lineHeight: 20,
  },
});
