// app/auth/callback.tsx
/**
 * Deep-link landing for Supabase auth redirects (magic link, OAuth fallback).
 * Reads the inbound URL, exchanges it for a session, and routes the user to
 * onboarding or tabs depending on their profile state.
 */
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColors } from '../../hooks/useColors';
import { replaceWithPostAuthRoute } from '../../utils/authNavigation';
import { getSession, syncSessionFromAuthRedirectUrl } from '../../utils/supabase';
import { posthog } from '../../src/config/posthog';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const colors = useColors();
  const consumedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const route = async () => {
      const session = await getSession();
      if (!session) {
        setErrorMessage('We could not verify that link. Try requesting a new one.');
        setTimeout(() => router.replace('/auth'), 1800);
        return;
      }
      posthog.capture('magic_link_consumed');
      // Resume the exact funnel stage via the guard — never a hard-coded screen.
      await replaceWithPostAuthRoute();
    };

    const consume = async (url: string | null) => {
      if (!url || consumedRef.current) return;
      consumedRef.current = true;
      const { error } = await syncSessionFromAuthRedirectUrl(url);
      if (error) {
        setErrorMessage(error);
        setTimeout(() => router.replace('/auth'), 1800);
        return;
      }
      await route();
    };

    Linking.getInitialURL().then(consume);
    const sub = Linking.addEventListener('url', (e) => { void consume(e.url); });

    // Fallback: if the session was already persisted (cold-open via deep link),
    // route immediately so the screen doesn't hang.
    const fallbackTimer = setTimeout(() => {
      if (!consumedRef.current) {
        consumedRef.current = true;
        void route();
      }
    }, 1200);

    return () => {
      sub.remove();
      clearTimeout(fallbackTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.label, { color: colors.textMuted }]}>
            {errorMessage || 'Signing you in…'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 16 },
  label: { fontSize: 15, textAlign: 'center' },
});
