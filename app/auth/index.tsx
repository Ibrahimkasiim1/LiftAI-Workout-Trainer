// app/auth/index.tsx
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useColors } from '../../hooks/useColors';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import {
  getSession,
  resetPasswordForEmail,
  sendMagicLink,
  signIn,
  signInWithAppleNative,
  signInWithGoogle,
  supabase
} from '../../utils/supabase';
import { replaceWithPostAuthRoute } from '../../utils/authNavigation';
import { writePendingSignup } from '../../utils/pendingSignup';
import { identifyUserForAnalytics, posthog } from '../../src/config/posthog';

function getFirstName(fullName: string): string {
  const t = fullName.trim();
  if (!t) return '';
  return t.split(/\s+/)[0] ?? t;
}

export default function AuthScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isDark } = useTheme();
  const colors = useColors();

  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkLoading, setMagicLinkLoading] = useState(false);

  // Redirect to welcome page if trying to sign up
  useEffect(() => {
    if (params.mode === 'sign-up') {
      router.replace('/auth/welcome');
    }
  }, [params.mode]);

  // Prefill email when coming from the "confirm your email" screen
  useEffect(() => {
    const prefill = typeof params.email === 'string' ? params.email : Array.isArray(params.email) ? params.email[0] : null;
    if (prefill && !email) {
      setEmail(prefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.email]);

  const promptResendConfirmation = (targetEmail: string) => {
    void (async () => {
      const ok = await confirmSheet({
        title: 'Confirm your email',
        message: `Your account isn't confirmed yet. We'll send a new code to ${targetEmail}.`,
        confirmLabel: 'Send code',
      });
      if (!ok) return;
      try {
        const { error } = await supabase.auth.resend({ type: 'signup', email: targetEmail });
        if (error) {
          toast.error('Could not resend', error.message);
          return;
        }
        // Persist pending state and route to the OTP screen so the user
        // can finish without having to retype the email.
        await writePendingSignup(targetEmail);
        router.replace('/auth/sign-up');
      } catch (e) {
        console.warn('Resend confirmation failed:', e);
        toast.error('Could not resend confirmation email', 'Please try again.');
      }
    })();
  };

  const handleAuth = async () => {
    if (!email || !password) {
      toast.error('Please fill in all fields');
      return;
    }

    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    try {
      const result = await signIn(email, password);

      if (result.error) {
        const lower = result.error.toLowerCase();
        if (lower.includes('email not confirmed') || lower.includes('not confirmed') || lower.includes('confirm your email')) {
          promptResendConfirmation(email);
          return;
        }
        toast.error(result.error);
        return;
      }

      if (result.user) {
        console.log('Authentication successful');

        // Wait for session persistence
        await new Promise(resolve => setTimeout(resolve, 500));

        const session = await getSession();
        if (!session) {
          toast.error('Could not establish a session', 'Please try signing in again.');
          return;
        }

        identifyUserForAnalytics(result.user.id, { $set: { email } });
        posthog.capture('user_signed_in', { method: 'email' });

        // Check onboarding status
        // Resume the exact funnel stage (quiz / paywall / plan-review /
        // tabs) — a mid-funnel user signing back in must not restart the quiz.
        await replaceWithPostAuthRoute();
      }
    } catch (error) {
      console.error('Auth error:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      toast.error('Please enter your email address');
      return;
    }

    setLoading(true);
    try {
      const { error } = await resetPasswordForEmail(email);

      if (error) {
        toast.error(error);
      } else {
        toast.success('Check your email', 'We have sent password reset instructions to your email.');
        setIsForgotPassword(false);
      }
    } catch (error) {
      console.error('Forgot password error:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      const result = await signInWithGoogle();

      if (result.error) {
        toast.error(result.error);
        return;
      }

      if (result.user) {
        console.log('Google authentication successful');
        console.log('Google user metadata:', JSON.stringify((result.user as any)?.user_metadata, null, 2));

        const googleName = (result.user as any)?.user_metadata?.full_name ||
          (result.user as any)?.user_metadata?.name;
        console.log('Extracted Google name:', googleName);

        if (googleName) {
          const firstName = getFirstName(googleName);
          console.log('First name from Google:', firstName);
          await supabase.auth.updateUser({
            data: { full_name: firstName },
          });
          // Save name to AsyncStorage for onboarding
          console.log('Saving Google name to AsyncStorage:', firstName);
          await AsyncStorage.setItem('@user_name', firstName);
        } else {
          console.warn('No name found in Google auth metadata');
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        const session = await getSession();
        if (!session) {
          toast.error('Could not establish a session', 'Please try signing in again.');
          return;
        }

        identifyUserForAnalytics(result.user.id, {
          $set: { email: result.user.email, name: googleName },
        });
        posthog.capture('user_signed_in', { method: 'google' });

        // Resume the exact funnel stage (quiz / paywall / plan-review /
        // tabs) — a mid-funnel user signing back in must not restart the quiz.
        await replaceWithPostAuthRoute();
      }
    } catch (error) {
      console.error('Google auth error:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    setLoading(true);
    try {
      // Use native Apple Sign-In which properly captures user name
      const result = await signInWithAppleNative();

      if (result.error) {
        toast.error(result.error);
        return;
      }

      if (result.user) {
        console.log('Apple authentication successful');
        // Names are persisted inside signInWithAppleNative (Supabase + AsyncStorage) on first sign-in.
        // Do not call updateUser here — it previously overwrote full_name with only a first name.

        await new Promise(resolve => setTimeout(resolve, 500));

        const session = await getSession();
        if (!session) {
          toast.error('Could not establish a session', 'Please try signing in again.');
          return;
        }

        identifyUserForAnalytics(result.user.id, { $set: { email: result.user.email } });
        posthog.capture('user_signed_in', { method: 'apple' });

        // Resume the exact funnel stage (quiz / paywall / plan-review /
        // tabs) — a mid-funnel user signing back in must not restart the quiz.
        await replaceWithPostAuthRoute();
      }
    } catch (error) {
      console.error('Apple auth error:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUpRedirect = () => {
    router.push('/auth/welcome');
  };

  const handleMagicLink = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error('Email required', 'Enter your email above to receive a magic link.');
      return;
    }
    setMagicLinkLoading(true);
    try {
      const { error } = await sendMagicLink(trimmedEmail, { createUser: false });
      if (error) {
        toast.error('Could not send link', error);
        return;
      }
      posthog.capture('magic_link_sent', { context: 'sign_in' });
      toast.success('Check your inbox', `We sent a magic link to ${trimmedEmail}. Tap it to sign in — no password needed.`);
    } catch (e) {
      console.error('Magic link error:', e);
      toast.error('Could not send magic link', 'Please try again.');
    } finally {
      setMagicLinkLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} translucent backgroundColor="transparent" />

      {isForgotPassword && (
        <View style={[styles.forgotPasswordTopBar, { paddingTop: insets.top, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => setIsForgotPassword(false)}
            style={styles.forgotPasswordBackBtn}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <View style={styles.logoContainer}>
            <Image
              source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={[styles.welcomeText, { color: colors.text }]}>
              {isForgotPassword ? 'Reset Password' : 'Welcome back'}
            </Text>
            <Text style={[styles.subtitleText, { color: colors.textMuted }]}>
              {isForgotPassword
                ? 'Enter your email to receive password reset instructions'
                : "Let's get you in to Lift"}
            </Text>
          </View>

          <View style={styles.form}>
            <TextInput
              style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
              value={email}
              onChangeText={setEmail}
              placeholder="Your Email"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />

            {!isForgotPassword && (
              <TextInput
                style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                value={password}
                onChangeText={setPassword}
                placeholder="Your Password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}

            {!isForgotPassword && (
              <TouchableOpacity style={styles.forgotPassword} onPress={() => setIsForgotPassword(true)}>
                <Text style={[styles.forgotPasswordText, { color: colors.textMuted }]}>Forgot password?</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.mainButton, { backgroundColor: colors.text }, loading && styles.buttonDisabled]}
              onPress={isForgotPassword ? handleForgotPassword : handleAuth}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={isDark ? '#000000' : colors.textInverse} />
              ) : (
                <Text style={[styles.mainButtonText, { color: colors.textInverse }]}>
                  {isForgotPassword ? 'Send Instructions' : 'Sign in'}
                </Text>
              )}
            </TouchableOpacity>

            {!isForgotPassword && (
              <>
                <View style={styles.dividerContainer}>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.dividerText, { color: colors.textMuted }]}>or</Text>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                </View>

                {Platform.OS === 'ios' && (
                  <TouchableOpacity
                    style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}
                    onPress={handleAppleSignIn}
                    disabled={loading}
                  >
                    <Ionicons name="logo-apple" size={20} color={colors.text} style={styles.socialIcon} />
                    <Text style={[styles.socialButtonText, { color: colors.text }]}>
                      Sign In With Apple
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}
                  onPress={handleGoogleSignIn}
                  disabled={loading}
                >
                  <Ionicons name="logo-google" size={20} color={colors.text} style={styles.socialIcon} />
                  <Text style={[styles.socialButtonText, { color: colors.text }]}>
                    Sign In With Google
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.magicLinkRow}
                  onPress={handleMagicLink}
                  disabled={loading || magicLinkLoading}
                  hitSlop={8}
                >
                  {magicLinkLoading ? (
                    <ActivityIndicator color={colors.textSecondary} />
                  ) : (
                    <>
                      <Ionicons name="link-outline" size={18} color={colors.textSecondary} style={{ marginRight: 6 }} />
                      <Text style={[styles.magicLinkText, { color: colors.textSecondary }]}>
                        Email me a magic link instead
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}

            {!isForgotPassword && (
              <View style={styles.footer}>
                <Text style={[styles.footerText, { color: colors.textMuted }]}>
                  {"Don't have an account?"}
                </Text>
                <TouchableOpacity onPress={handleSignUpRedirect}>
                  <Text style={[styles.footerLink, { color: colors.text }]}>
                    {' Sign up'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={[styles.legalText, { color: colors.textMuted }]}>
              By continuing you agree to our{' '}
              <Text
                style={[styles.legalLink, { color: colors.textSecondary }]}
                onPress={() => Linking.openURL('https://liftaiapp.com/terms.html')}
              >
                Terms of Service
              </Text>
              {' '}and{' '}
              <Text
                style={[styles.legalLink, { color: colors.textSecondary }]}
                onPress={() => Linking.openURL('https://liftaiapp.com/privacy.html')}
              >
                Privacy Policy
              </Text>
              . You may also receive product updates and occasional marketing emails — you can unsubscribe anytime.
            </Text>
          </View>
        </KeyboardAvoidingView>
      </ScrollView>
    </View>
  );
}

// Keep all existing styles...
const styles = StyleSheet.create({
  container: { flex: 1 },
  forgotPasswordTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  forgotPasswordBackBtn: { padding: 8 },
  scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },
  keyboardView: { flex: 1, justifyContent: 'center' },
  logoContainer: { alignItems: 'center', marginBottom: 32, marginTop: 0 },
  logo: { width: 100, height: 50, marginBottom: 12 },
  welcomeText: { fontSize: 32, fontFamily: theme.typography.fontFamily.bold, marginBottom: 8, textAlign: 'center' },
  subtitleText: { fontSize: 16, fontFamily: theme.typography.fontFamily.regular, textAlign: 'center' },
  form: { width: '100%' },
  input: { borderRadius: 16, padding: 20, fontSize: 16, fontFamily: theme.typography.fontFamily.regular, borderWidth: 1, marginBottom: 16 },
  forgotPassword: { alignSelf: 'center', marginBottom: 24 },
  forgotPasswordText: { fontSize: 14, fontFamily: theme.typography.fontFamily.medium },
  mainButton: { borderRadius: 999, paddingVertical: 20, alignItems: 'center', marginBottom: 24 },
  buttonDisabled: { opacity: 0.7 },
  mainButtonText: { fontSize: 16, fontFamily: theme.typography.fontFamily.bold },
  dividerContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { paddingHorizontal: 16, fontSize: 14 },
  socialButton: { borderRadius: 999, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 16, borderWidth: 1 },
  socialIcon: { marginRight: 12 },
  socialButtonText: { fontSize: 16, fontFamily: theme.typography.fontFamily.medium },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  footerText: { fontSize: 14 },
  footerLink: { fontSize: 14, fontFamily: theme.typography.fontFamily.bold },
  legalText: {
    fontSize: 11,
    fontFamily: theme.typography.fontFamily.regular,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 24,
    paddingHorizontal: 8,
  },
  legalLink: { textDecorationLine: 'underline' },
  magicLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 8,
  },
  magicLinkText: {
    fontSize: 14,
    fontFamily: theme.typography.fontFamily.medium,
    textDecorationLine: 'underline',
  },
});
