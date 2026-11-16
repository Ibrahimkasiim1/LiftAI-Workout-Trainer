// app/index.tsx
/**
 * Root Index - Authentication & Onboarding Router
 * 
 * Route: /index
 * Function: Entry point that checks authentication, onboarding, and subscription status
 * 
 * Features:
 * - Checks if user is authenticated with Supabase
 * - Verifies if user has completed onboarding process
 * - Checks subscription status via RevenueCat
 * - Redirects to appropriate screen based on user state
 * - Handles app initialization and routing logic
 * - Displays splash screen during authentication checks
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useSubscription } from '../context/SubscriptionContext';
import { resolveGuardedRoute } from '../utils/funnelGuard';
import { isUpdateRequired } from '../utils/forceUpdate';
import { readPendingSignup } from '../utils/pendingSignup';
import { runStartupSessionCleanup } from '../utils/sessionCleanup';
import { getSession } from '../utils/supabase';

export default function Index() {
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { isInitialized, isLoading: subscriptionLoading, checkSubscription } = useSubscription();
  const subscriptionReady = isInitialized && !subscriptionLoading;

  useEffect(() => {
    if (!subscriptionReady) {
      return;
    }
    checkAuthAndOnboarding();
  }, [subscriptionReady]);

  /**
   * Check authentication and onboarding status
   */
  const checkAuthAndOnboarding = async () => {
    // Cleanup old sessions (non-blocking - runs in background)
    runStartupSessionCleanup().catch(err =>
      console.warn('Session cleanup failed:', err)
    );

    try {
      const updateRequired = await isUpdateRequired();
      if (updateRequired) {
        router.replace('/force-update');
        return;
      }

      const resolution = await resolveGuardedRoute({
        resolveSubscriptionStatus: () => checkSubscription(),
      });

      if (!resolution) {
        // No Supabase session. If the user is mid-signup (entered email/pw
        // but hasn't typed the OTP yet), drop them straight on the OTP
        // screen instead of the welcome page so they don't lose progress.
        const pending = await readPendingSignup();
        router.replace(pending ? '/auth/sign-up' : '/auth/welcome');
        return;
      }

      router.replace(resolution.route as any);

    } catch (error) {
      // Transient failure (network flake, cold backend). If a session exists,
      // fail OPEN into the app — the tabs/home guards re-verify once the
      // connection recovers. Only fall back to welcome when truly signed out.
      console.error('Error checking auth/onboarding:', error);
      try {
        const session = await getSession();
        router.replace(session ? '/(tabs)' : '/auth/welcome');
      } catch {
        router.replace('/auth/welcome');
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.splashContainer}>
        <Image
          source={require('../img/white-v-nobg.png')}
          style={styles.logo}
          resizeMode="contain"
        />
      </View>
    );
  }

  // This should never be reached due to redirects above.
  return null;
}

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  logo: {
    width: 200,
    height: 200,
  },
});