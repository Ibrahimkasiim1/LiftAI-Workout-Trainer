import { Platform } from 'react-native';
import {
  getTrackingPermissionsAsync,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';
import mobileAds, { MaxAdContentRating } from 'react-native-google-mobile-ads';

/**
 * One-time AdMob bootstrap.
 *
 * Order matters: on iOS we MUST present the App Tracking Transparency prompt
 * (and let the user respond) BEFORE the Google Mobile Ads SDK initializes, so
 * that the SDK knows whether it's allowed to read the IDFA. Skipping the prompt
 * means Apple rejects the build (Guideline 5.1.2) and AdMob falls back to
 * non-personalized ads on iOS.
 *
 * Idempotent — safe to call on every mount; the underlying init only runs once.
 */
let initPromise: Promise<void> | null = null;

async function requestTrackingPermission(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    // Only prompt while the status is still "undetermined". Once the user has
    // answered (granted/denied/restricted) iOS won't show it again anyway, but
    // checking first avoids an unnecessary async hop on every launch.
    const { status } = await getTrackingPermissionsAsync();
    if (status === 'undetermined') {
      await requestTrackingPermissionsAsync();
    }
  } catch {
    // If the prompt fails for any reason we still continue to init the SDK;
    // it will simply serve non-personalized ads.
  }
}

export function initAds(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await requestTrackingPermission();

    await mobileAds().setRequestConfiguration({
      maxAdContentRating: MaxAdContentRating.PG,
      tagForChildDirectedTreatment: false,
      tagForUnderAgeOfConsent: false,
    });

    await mobileAds().initialize();
  })();

  return initPromise;
}
