// app/(tabs)/_layout.tsx
/**
 * Tab Navigation Layout
 * 
 * Route: /(tabs)/_layout
 * Function: Bottom tab navigation configuration for main app screens
 * 
 * Features:
 * - Three main tabs: Home (workouts), Progress (analytics), Chat (AI assistant)
 * - Hidden Saved tab accessible programmatically
 * - Dark theme styling with custom accent colors
 * - Custom tab bar icons and styling
 * - Header configuration for all tab screens
 * 
 * IMPORTANT: Users only reach this screen after completing onboarding and passing
 * the hard paywall in plan-review.tsx. No automatic paywall presentation should
 * happen here - that was causing the paywall stacking bug.
 * 
 * If you need to gate features on this screen, use UI-based gating (locked states,
 * CTA buttons) instead of auto-presenting the paywall.
 */

import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, useRouter } from 'expo-router';
import {
  Icon,
  Label,
  NativeTabs,
  VectorIcon,
} from 'expo-router/unstable-native-tabs';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  StyleSheet,
  View
} from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useSubscription } from '../../context/SubscriptionContext';
import { useTheme } from '../../context/ThemeContext';
import { resolveGuardedRouteCached } from '../../utils/funnelGuard';
import { getSession, supabase } from '../../utils/supabase';

const PLAN_EXPIRED_SEEN_KEY = 'plan_expired_shown_v1';

export default function TabLayout() {
  const router = useRouter();
  // Keep subscription context for future feature gating (but DO NOT auto-present paywall)
  const { isLoading, isInitialized, checkSubscription: refreshSubscriptionStatus, isSubscribed, customerInfo } = useSubscription();
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const appState = useRef(AppState.currentState);

  /** `undefined` = still resolving storage; null = signed out */
  const [authSession, setAuthSession] = useState<Session | null | undefined>(undefined);
  const [guardRedirect, setGuardRedirect] = useState<string | null>(null);
  const [guardLoading, setGuardLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await getSession();
      if (!cancelled) setAuthSession(s);
    })();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthSession(session);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const evaluateGuard = async () => {
      if (!authSession || !isInitialized || isLoading) {
        return;
      }

      setGuardLoading(true);
      try {
        // Cache-first: app/index just ran the full resolution at launch, so
        // this layout-level re-check is usually a free cache hit.
        const resolution = await resolveGuardedRouteCached({
          resolveSubscriptionStatus: () => refreshSubscriptionStatus(),
        });

        if (cancelled) return;

        if (!resolution) {
          setGuardRedirect('/auth/welcome');
          return;
        }

        setGuardRedirect(resolution.route === '/(tabs)' ? null : resolution.route);
      } catch (error) {
        // A guard failure here is a transient error (network flake, cold
        // backend) — NOT evidence the user needs onboarding. Redirecting to
        // /onboarding on error sent fully-onboarded users back through the
        // funnel on refresh. Stay put; the next evaluation will re-check.
        console.error('Failed to evaluate root guard in tabs:', error);
        if (!cancelled) {
          setGuardRedirect(null);
        }
      } finally {
        if (!cancelled) {
          setGuardLoading(false);
        }
      }
    };

    evaluateGuard();

    return () => {
      cancelled = true;
    };
  }, [authSession, isInitialized, isLoading, refreshSubscriptionStatus]);

  /**
   * Show the plan-expired screen once when a subscription lapses.
   * Only triggers for users who previously had a paid plan (latestExpirationDate
   * non-null) and are now not subscribed. Uses AsyncStorage so it fires once
   * per install, not every session.
   */
  useEffect(() => {
    if (!isInitialized || isLoading || guardLoading) return;
    if (isSubscribed) return;

    const latestExp = customerInfo?.latestExpirationDate;
    if (!latestExp) return; // brand-new user who never had a plan

    const expMs = new Date(latestExp).getTime();
    if (Number.isNaN(expMs) || expMs > Date.now()) return; // still active or bad date

    void (async () => {
      try {
        const seen = await AsyncStorage.getItem(PLAN_EXPIRED_SEEN_KEY);
        if (!seen) {
          await AsyncStorage.setItem(PLAN_EXPIRED_SEEN_KEY, '1');
          router.push('/plan-expired');
        }
      } catch (err) {
        console.warn('[TabLayout] plan-expired check failed:', err);
      }
    })();
  }, [isInitialized, isLoading, guardLoading, isSubscribed, customerInfo, router]);

  /**
   * Refresh subscription status when app comes to foreground
   * This ensures the UI reflects the current subscription state,
   * but does NOT automatically present the paywall.
   * 
   * BUG FIX: Removed auto-paywall presentation that was causing:
   * 1. Paywall re-appearing after successful purchase
   * 2. Multiple paywalls stacking on top of each other
   * 3. Paywall shown to users who already completed onboarding paywall
   */
  useEffect(() => {
    // Silently refresh subscription status on mount (no paywall)
    refreshSubscriptionStatus();

    // Listen for app state changes to refresh subscription status silently
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // Only refresh status, do NOT present paywall
        if (__DEV__) {
          console.log('App foregrounded, refreshing subscription status silently...');
        }
        refreshSubscriptionStatus();
      }

      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [refreshSubscriptionStatus]);

  // Single branded gate for every startup wait (auth resolution, subscription
  // init, funnel guard) so launch shows one loading surface, then content.
  const isBooting = authSession === undefined || (authSession && (!isInitialized || isLoading || guardLoading));

  if (isBooting) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <Image
          source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
          style={styles.loadingLogo}
          resizeMode="contain"
        />
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  if (!authSession) {
    return <Redirect href="/auth/welcome" />;
  }

  if (guardRedirect) {
    return <Redirect href={guardRedirect as any} />;
  }

  // Users reach this screen only after completing onboarding and the hard paywall in plan-review.tsx
  // No additional paywall checks needed here

  // Native UITabBarController (iOS) / material bottom nav (Android) via
  // expo-router NativeTabs: on iOS 26 builds this is the system Liquid Glass
  // tab bar with scroll-edge effects and system animations. SF Symbols on
  // iOS, Ionicons (via VectorIcon) on Android. Icon-only (labels hidden) for
  // a compact pill; accessibility labels are preserved via <Label hidden>.
  return (
    <NativeTabs
      tintColor={colors.primary}
      minimizeBehavior="automatic"
      labelVisibilityMode="unlabeled"
    >
      {/* Home Tab - Displays workout exercises */}
      <NativeTabs.Trigger name="index">
        <Label hidden>Home</Label>
        {Platform.OS === 'ios' ? (
          <Icon sf={{ default: 'house', selected: 'house.fill' }} />
        ) : (
          <Icon src={<VectorIcon family={Ionicons} name="home-outline" />} />
        )}
      </NativeTabs.Trigger>

      {/* Progress Tab - Exercise history and statistics */}
      <NativeTabs.Trigger name="progress">
        <Label hidden>Progress</Label>
        {Platform.OS === 'ios' ? (
          <Icon sf="chart.line.uptrend.xyaxis" />
        ) : (
          <Icon src={<VectorIcon family={Ionicons} name="trending-up" />} />
        )}
      </NativeTabs.Trigger>

      {/* Nutrition Tab - Smart log and daily macro aggregation */}
      <NativeTabs.Trigger name="nutrition">
        <Label hidden>Nutrition</Label>
        {Platform.OS === 'ios' ? (
          <Icon sf="fork.knife" />
        ) : (
          <Icon src={<VectorIcon family={Ionicons} name="restaurant-outline" />} />
        )}
      </NativeTabs.Trigger>

      {/* Chat Tab - AI fitness assistant */}
      <NativeTabs.Trigger name="chat">
        <Label hidden>Coach</Label>
        {Platform.OS === 'ios' ? (
          <Icon sf={{ default: 'message', selected: 'message.fill' }} />
        ) : (
          <Icon src={<VectorIcon family={Ionicons} name="chatbubble-ellipses-outline" />} />
        )}
      </NativeTabs.Trigger>

      {/* Hide Saved Tab but keep it in the router */}
      <NativeTabs.Trigger name="saved" hidden />
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  loadingLogo: {
    width: 72,
    height: 72,
  },
});
