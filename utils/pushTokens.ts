// utils/pushTokens.ts
/**
 * Expo push-token registration.
 *
 * The backend's proactive coach drafts personalized check-ins into
 * `coach_checkins`; its push-delivery pass reads `user_push_tokens` to reach
 * users whose app is closed. This module keeps that table in sync: whenever
 * notification permission is granted, we fetch the device's Expo push token
 * and upsert it for the signed-in user.
 *
 * Call sites: app foreground (root layout), and immediately after any
 * permission grant (onboarding screen, in-context rest-timer ask, settings
 * toggle). Cheap to call repeatedly — the (user, token) pair is fingerprinted
 * in AsyncStorage and re-upserted at most once a day.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getSession, supabase } from './supabase';

const SYNC_KEY = '@push_token_synced_v1';
const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Register this device's Expo push token for the signed-in user. No-ops
 * without a session, without notification permission, or when the same
 * (user, token) pair was synced within the last day. Never throws.
 */
export async function syncPushToken(userId?: string): Promise<void> {
  try {
    let uid = userId;
    if (!uid) {
      const session = await getSession();
      uid = session?.user?.id;
    }
    if (!uid) return;

    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId) return; // Expo Go / misconfigured build — push unsupported.

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;

    const fingerprint = `${uid}:${token}`;
    const prevRaw = await AsyncStorage.getItem(SYNC_KEY);
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw) as { fp: string; at: number };
        if (prev.fp === fingerprint && Date.now() - prev.at < RESYNC_INTERVAL_MS) return;
      } catch {
        // Corrupt cache — fall through and re-sync.
      }
    }

    // user_push_tokens is newer than the generated types in types/supabase.ts;
    // cast until they're regenerated.
    const client = supabase as unknown as {
      from: (table: string) => {
        upsert: (
          row: Record<string, unknown>,
          opts: { onConflict: string },
        ) => PromiseLike<{ error: unknown }>;
      };
    };
    const { error } = await client.from('user_push_tokens').upsert(
      {
        token,
        user_id: uid,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (!error) {
      await AsyncStorage.setItem(SYNC_KEY, JSON.stringify({ fp: fingerprint, at: Date.now() }));
    }
  } catch (error) {
    console.warn('syncPushToken failed:', error);
  }
}
