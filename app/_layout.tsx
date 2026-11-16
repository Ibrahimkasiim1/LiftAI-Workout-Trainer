// app/_layout.tsx
/**
 * Root Layout
 * 
 * Route: /_layout
 * Function: Main navigation structure and app configuration
 * 
 * Features:
 * - Stack navigator as root navigation container
 * - Font loading and splash screen management
 * - Global header styling and theme configuration
 * - Screen configuration for all app routes
 * - Authentication, onboarding, and main app screens
 * - Post–sign-out navigation is reset via utils/authNavigation (dismissAll + replace) so iOS cannot
 *   swipe back into tabs; app/(tabs)/_layout.tsx also redirects when session is null.
 * - Modal and card presentation styles
 * - Gesture handling and navigation options
 * - Subscription context provider for RevenueCat integration
 */

import { Montserrat_400Regular, Montserrat_500Medium, Montserrat_600SemiBold, Montserrat_700Bold, Montserrat_800ExtraBold, Montserrat_900Black, useFonts } from '@expo-google-fonts/montserrat';
import { Stack, router, usePathname, useGlobalSearchParams } from "expo-router";
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PostHogProvider } from 'posthog-react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import PeriodicInterstitial from '../components/PeriodicInterstitial';
import { ConfirmSheetHost } from '../components/ui/ConfirmSheet';
import { ToastHost } from '../components/ui/Toast';
import { ProGateProvider } from '../context/ProGateContext';
import { SubscriptionProvider } from '../context/SubscriptionContext';
import { ThemeProvider } from '../context/ThemeContext';
import { useColors } from '../hooks/useColors';
import { posthog } from '../src/config/posthog';
import { initSentry } from '../src/config/sentry';
import { queryClient } from '../src/queryClient';
import { initAds } from '../utils/initAds';
import { isPreAuthPathname } from '../utils/navigationGuards';

// Error tracking first, so init-time failures elsewhere are captured.
// No-op without EXPO_PUBLIC_SENTRY_DSN (see src/config/sentry.ts).
initSentry();

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({
  fade: false,
});

// Inner component that uses theme and tracks screen views
function RootLayoutContent() {
  const colors = useColors();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const previousPathname = useRef<string | undefined>(undefined);
  // Live pathname for the notification deep-link handler below (its effect
  // runs once, so reading `pathname` directly would be a stale closure).
  const currentPathname = useRef(pathname);
  currentPathname.current = pathname;

  // Present the ATT prompt and initialize AdMob once the UI is mounted.
  // Must run after the app is interactive (not during splash) so iOS allows
  // the tracking prompt to appear.
  useEffect(() => {
    initAds().catch((error) => {
      console.warn('Ads init failed:', error);
    });
  }, []);

  // Force-quit cleanup for the rest-timer Live Activity (Dynamic Island /
  // lock-screen widget). A Live Activity outlives a hard app kill because the
  // OS keeps it alive independently of our process, so when a user swipes the
  // app away mid-workout the island lingers (up to its stale window) with no
  // way for us to run code at the moment of the kill. This runs ONCE on a cold
  // launch — no workout screen is mounted yet, so any activity still showing is
  // an orphan from a previous run. End it. If the user then taps "Resume
  // Workout", the player starts a fresh activity. This is intentionally NOT tied
  // to the AppState "active" event: returning from a normal background mid-
  // workout must keep the island alive (that's the whole point of it).
  useEffect(() => {
    import('../utils/liveActivity')
      .then(({ liveActivity }) => liveActivity.end())
      .catch(() => {});
  }, []);

  // Refresh local engagement notifications (daily/learned-time reminders, weekly
  // summary, 3-day re-engagement) on launch and whenever the app is foregrounded.
  // Throttled internally to ~6h, and a no-op without notification permission.
  useEffect(() => {
    const refresh = async () => {
      try {
        // Resolve whether interstitials are allowed yet (first-workout
        // activation gate). Reads local flags, falls back to one DB row;
        // checks its own session, so safe to call signed-out.
        const { useAdGovernor } = await import('../stores/useAdGovernor');
        void useAdGovernor.getState().hydrateActivation();

        const { getSession } = await import('../utils/supabase');
        const { refreshEngagementNotifications } = await import(
          '../utils/engagementNotifications'
        );
        const session = await getSession();
        if (session?.user?.id) {
          await refreshEngagementNotifications(session.user.id);
          // Keep the backend's source-of-truth timezone (user_quotas.timezone)
          // in sync with this device, so the user's local "today" drives quota
          // resets, the workout planner, and chat food logging — not UTC.
          const { syncDeviceTimezone } = await import('../utils/quotaReset');
          await syncDeviceTimezone();
          // Register this device's Expo push token so the backend coach can
          // reach the user when the app is closed. No-op without permission,
          // throttled internally.
          const { syncPushToken } = await import('../utils/pushTokens');
          await syncPushToken(session.user.id);
        }
      } catch (error) {
        console.warn('Engagement refresh failed:', error);
      }
    };

    void refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, []);

  // Notification taps → deep links. Every local notification and coach push
  // carries data.route (and optionally data.cta for a prefilled chat message);
  // without this listener a tap just cold-opens the app on the default tab.
  // Also the one place notification_open is captured, so open rates per
  // notification type are measurable in PostHog.
  const handledNotificationIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse, coldStart: boolean) => {
      try {
        const request = response.notification.request;
        // The cold-start "last response" and the live listener can both fire
        // for the same tap — handle each notification exactly once.
        if (handledNotificationIds.current.has(request.identifier)) return;
        handledNotificationIds.current.add(request.identifier);

        const data = (request.content.data ?? {}) as Record<string, unknown>;
        const type = typeof data.type === 'string' ? data.type : 'unknown';
        const route = typeof data.route === 'string' ? data.route : null;
        const cta = typeof data.cta === 'string' ? data.cta : null;

        posthog.capture('notification_open', {
          type,
          route,
          has_cta: cta != null,
          cold_start: coldStart,
        });

        // A tapped coach check-in is read — clear the home card so the user
        // isn't shown the same message twice.
        if (type === 'coach_checkin' && typeof data.checkinId === 'string') {
          import('../src/api/backendClient')
            .then(({ backendClient }) => backendClient.setCheckinStatus(data.checkinId as string, 'read'))
            .catch(() => {});
        }

        if (!route) return;
        const navigate = () => {
          try {
            // Never deep-link over the auth/onboarding funnel: pushing a tabs
            // route there stacks (tabs) ON TOP of a pre-auth root entry (a
            // swipe-back away from a logged-out screen) and jumps a mid-funnel
            // user past the guard. The tapped content surfaces on Home anyway.
            // isPreAuthPathname also treats '/' (cold-start splash, funnel
            // not yet resolved) as pre-auth — the 500ms boot delay used to
            // slip pushes past this check.
            if (isPreAuthPathname(currentPathname.current)) {
              return;
            }
            if (cta) {
              router.push({ pathname: route as never, params: { initialMessage: cta } });
            } else {
              router.push(route as never);
            }
          } catch (error) {
            console.warn('Notification deep link failed:', error);
          }
        };
        // On a cold start the navigator needs a beat to mount before push().
        if (coldStart) setTimeout(navigate, 500);
        else navigate();
      } catch (error) {
        console.warn('Notification response handling failed:', error);
      }
    };

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response, true);
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((response) =>
      handleResponse(response, false),
    );
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      posthog.screen(pathname, {
        previous_screen: previousPathname.current ?? null,
        ...params,
      });
      previousPathname.current = pathname;
    }
  }, [pathname, params]);

  return (
    <PostHogProvider
      client={posthog}
      autocapture={{
        captureScreens: false,
        captureTouches: true,
        propsToCapture: ['testID'],
        maxElementsCaptured: 20,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <SubscriptionProvider>
          <ProGateProvider>
            <Stack
          screenOptions={{
            // Global header styling for consistency
            headerStyle: {
              backgroundColor: colors.background,
            },
            headerTintColor: colors.text,
            headerTitleStyle: {
              fontFamily: 'Montserrat_700Bold',
            },
          }}
        >
          {/* Splash screen - no header */}
          <Stack.Screen
            name="index"
            options={{
              headerShown: false
            }}
          />

          {/* Main tab navigator - this will be the primary navigation */}
          <Stack.Screen
            name="(tabs)"
            options={{
              headerShown: false, // Hide header since tabs have their own
              // Tabs is the app hub — there is never a legitimate swipe-back
              // FROM it. Anything beneath it on the root stack (e.g. a funnel
              // group left by a deep link) is stale, and the edge-swipe would
              // land a signed-in user there.
              gestureEnabled: false,
            }}
          />

          {/* Auth directory */}
          <Stack.Screen
            name="auth"
            options={{
              headerShown: false,
              presentation: 'card',
            }}
          />

          {/* Onboarding directory */}
          <Stack.Screen
            name="onboarding"
            options={{
              headerShown: false,
              presentation: 'card',
              gestureEnabled: false, // Prevent swipe back during onboarding
            }}
          />

          {/* Workout directory. The PLAYER screen disables the root
              edge-swipe while it is mounted (app/workout/index.tsx) so its
              exits always route through the navigation guard; detail screens
              opened without the player keep normal swipe-back. */}
          <Stack.Screen
            name="workout"
            options={{
              headerShown: false,
              presentation: 'card',
            }}
          />

          {/* Settings screens */}
          <Stack.Screen
            name="settings"
            options={{
              headerShown: false,
              presentation: 'card',
            }}
          />

          {/* Photo food logging — full-screen camera + Plate review card */}
          <Stack.Screen
            name="nutrition/photo-log"
            options={{
              headerShown: false,
              presentation: 'fullScreenModal',
            }}
          />

          {/* Quota limit — native form sheet with detents (system grabber,
              spring physics, dimming). Pushed by QuotaLimitSheet when the
              backend returns 429 for an AI action. */}
          <Stack.Screen
            name="quota-limit"
            options={{
              headerShown: false,
              presentation: 'formSheet',
              sheetAllowedDetents: [0.5],
              sheetGrabberVisible: true,
              sheetCornerRadius: 24,
            }}
          />

          {/* Plan expired — shown once when subscription lapses */}
          <Stack.Screen
            name="plan-expired"
            options={{
              headerShown: false,
              presentation: 'modal',
              gestureEnabled: false,
            }}
          />

          {/* Force update — blocks the app until user installs a newer build */}
          <Stack.Screen
            name="force-update"
            options={{
              headerShown: false,
              presentation: 'fullScreenModal',
              gestureEnabled: false,
            }}
          />
            </Stack>
            <PeriodicInterstitial />
            <ToastHost />
            <ConfirmSheetHost />
          </ProGateProvider>
        </SubscriptionProvider>
      </QueryClientProvider>
    </PostHogProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
    Montserrat_900Black,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch((error) => {
        console.warn('Failed to hide splash screen:', error);
      });
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <RootLayoutContent />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
