import { Platform } from 'react-native';
import { TestIds } from 'react-native-google-mobile-ads';

const IOS_BANNER = 'ca-app-pub-6673101910022526/2682092556';
const IOS_INTERSTITIAL = 'ca-app-pub-6673101910022526/1040873675';

const ANDROID_BANNER = process.env.EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID;
const ANDROID_INTERSTITIAL = process.env.EXPO_PUBLIC_ADMOB_ANDROID_INTERSTITIAL_ID;

// In development we always use Google's official test IDs. In production we use
// the real placement IDs. iOS IDs are hardcoded above; Android IDs come from env
// vars that must be set before any Android release. If an Android env var is
// unset we return `null` (serve no ad) rather than falling back to a test ID —
// serving test ads to real users violates AdMob policy. Consumers must guard on
// a null unit ID and render nothing / skip the ad request.
export const BANNER_AD_UNIT_ID: string | null = __DEV__
  ? TestIds.BANNER
  : Platform.select({
      ios: IOS_BANNER,
      android: ANDROID_BANNER ?? null,
      default: null,
    }) ?? null;

export const INTERSTITIAL_AD_UNIT_ID: string | null = __DEV__
  ? TestIds.INTERSTITIAL
  : Platform.select({
      ios: IOS_INTERSTITIAL,
      android: ANDROID_INTERSTITIAL ?? null,
      default: null,
    }) ?? null;
