import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Keyboard } from 'react-native';
import { AdEventType, InterstitialAd } from 'react-native-google-mobile-ads';
import { useSubscription } from '../context/SubscriptionContext';
import { useAdGovernor } from '../stores/useAdGovernor';
import { useWorkoutStore } from '../stores/useWorkoutStore';
import { isPaywallVisible } from '../services/PaywallService';
import { isPeriodicInterstitialBlockedRoute } from '../utils/adRoutes';
import { INTERSTITIAL_AD_UNIT_ID as AD_UNIT_ID } from '../utils/adUnits';
import { maybeShowRemoveAdsNudge } from '../utils/removeAdsNudge';

// First interstitial fires after this delay (gives the user time to settle in).
const INITIAL_DELAY_MS = 3 * 60 * 1000;
// Then every PERIOD_MS thereafter (with random jitter).
const PERIOD_MS = 4 * 60 * 1000;
const JITTER_MS = 60 * 1000;

export default function PeriodicInterstitial() {
  const { isPro, checkSubscription } = useSubscription();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const adRef = useRef<InterstitialAd | null>(null);
  const loadedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // An open keyboard means the user is mid-typing (logging a meal, chatting) —
  // the worst possible moment for a full-screen ad.
  const keyboardVisibleRef = useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisibleRef.current = true;
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (isPro) return;
    // No real unit ID configured for this platform — don't request test ads.
    if (!AD_UNIT_ID) return;

    const ad = InterstitialAd.createForAdRequest(AD_UNIT_ID);
    adRef.current = ad;

    const unsubLoaded = ad.addAdEventListener(AdEventType.LOADED, () => {
      loadedRef.current = true;
    });
    const unsubClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      loadedRef.current = false;
      ad.load();
      scheduleNext(PERIOD_MS);
      // The moment they dismissed an ad is when "remove ads" lands honestly.
      void maybeShowRemoveAdsNudge(() => checkSubscription(true));
    });
    const unsubError = ad.addAdEventListener(AdEventType.ERROR, () => {
      loadedRef.current = false;
      setTimeout(() => ad.load(), 30_000);
      scheduleNext(PERIOD_MS);
    });

    ad.load();

    function scheduleNext(baseMs: number) {
      if (timerRef.current) clearTimeout(timerRef.current);
      const jitter = Math.floor(Math.random() * JITTER_MS);
      timerRef.current = setTimeout(tryShow, baseMs + jitter);
    }

    function tryShow() {
      // Don't show while the app is in the background.
      if (AppState.currentState !== 'active') {
        scheduleNext(60_000);
        return;
      }

      // Suppress on onboarding / force-update routes plus the workout player
      // (never interrupt a user mid-set — the player runs its own governed ad
      // surfaces) and the quota-limit sheet (a conversion moment).
      if (isPeriodicInterstitialBlockedRoute(pathnameRef.current)) {
        scheduleNext(60_000);
        return;
      }

      // The paywall is a MODAL, not a route — pathname doesn't change while
      // it's up, so check it explicitly. An interstitial on top of the paywall
      // is the single worst ad placement possible.
      if (isPaywallVisible()) {
        scheduleNext(60_000);
        return;
      }

      // Never interrupt active typing — retry shortly after they're done.
      if (keyboardVisibleRef.current) {
        scheduleNext(45_000);
        return;
      }

      // Don't interrupt a user who is currently resting between sets — the
      // GlobalRestTimer owns that surface.
      const restEndTime = useWorkoutStore.getState().restEndTime;
      const isResting = restEndTime != null && restEndTime - Date.now() > 0;
      if (isResting) {
        scheduleNext(45_000);
        return;
      }

      // Honor the shared cooldown so we don't stack on top of an
      // exercise-dwell or rest-window interstitial.
      if (!useAdGovernor.getState().canShowInterstitial()) {
        scheduleNext(60_000);
        return;
      }

      if (loadedRef.current && adRef.current) {
        useAdGovernor.getState().recordInterstitialShown();
        adRef.current.show().catch(() => {
          scheduleNext(PERIOD_MS);
        });
      } else {
        scheduleNext(60_000);
      }
    }

    scheduleNext(INITIAL_DELAY_MS);

    return () => {
      unsubLoaded();
      unsubClosed();
      unsubError();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [isPro]);

  return null;
}
