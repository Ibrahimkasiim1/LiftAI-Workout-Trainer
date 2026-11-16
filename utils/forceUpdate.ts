import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Replace with your numeric App Store ID once the app is live.
// Find it at: App Store Connect → App Information → Apple ID.
const IOS_APP_STORE_URL = 'https://apps.apple.com/app/idYOUR_APP_STORE_ID';
const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.example.liftai';

export const STORE_URL =
  Platform.OS === 'ios' ? IOS_APP_STORE_URL : ANDROID_PLAY_STORE_URL;

function parseVersion(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function isBelow(current: string, minimum: string): boolean {
  const c = parseVersion(current);
  const m = parseVersion(minimum);
  for (let i = 0; i < Math.max(c.length, m.length); i++) {
    const cv = c[i] ?? 0;
    const mv = m[i] ?? 0;
    if (cv < mv) return true;
    if (cv > mv) return false;
  }
  return false;
}

/**
 * Returns true if the running app version is below the server-enforced minimum.
 * Falls through silently on network errors so users are never hard-blocked by
 * a connectivity issue — only by a deliberate version requirement.
 */
export async function isUpdateRequired(): Promise<boolean> {
  try {
    const currentVersion: string =
      Constants.expoConfig?.version ?? '0.0.0';

    const key =
      Platform.OS === 'ios'
        ? 'minimum_ios_version'
        : 'minimum_android_version';

    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', key)
      .single();

    if (error || !data?.value) return false;

    return isBelow(currentVersion, data.value);
  } catch {
    return false;
  }
}
