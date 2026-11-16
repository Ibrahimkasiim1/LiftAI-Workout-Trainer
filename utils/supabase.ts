

// utils/supabase.ts

import { Database } from '@/types/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import { clearFunnelSnapshot } from './funnelState';


// Complete OAuth session in web browser
WebBrowser.maybeCompleteAuthSession();

// Initialize Supabase client
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

/** Google Cloud "Web" OAuth client must authorize this URI (server exchanges the auth code here). */
const SUPABASE_GOOGLE_OAUTH_REDIRECT_URI = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/callback`;

// Pass <Database> here to inject the types
// PKCE: redirect is ?code=...&state=... (query). Implicit flow puts tokens in #hash, which
// iOS/WebBrowser often drops when returning the deep link — breaks Google OAuth on device.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

type ParsedOAuthRedirect = {
  access_token: string | null;
  refresh_token: string | null;
  code: string | null;
  error: string | null;
  error_description: string | null;
};

/**
 * Supabase mobile OAuth often returns tokens in the URL hash (#) or query (?).
 * Custom schemes (liftaiapp://...) can also confuse URL parsing — normalize manually.
 */
function parseOAuthRedirectUrl(raw: string): ParsedOAuthRedirect {
  let access_token: string | null = null;
  let refresh_token: string | null = null;
  let code: string | null = null;

  let oauthError: string | null = null;
  let oauthErrorDescription: string | null = null;

  const absorb = (params: URLSearchParams) => {
    if (!access_token) access_token = params.get('access_token');
    if (!refresh_token) refresh_token = params.get('refresh_token');
    if (!code) code = params.get('code');
    if (!oauthError) oauthError = params.get('error');
    if (!oauthErrorDescription) oauthErrorDescription = params.get('error_description');
  };

  const decodePart = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return v;
    }
  };

  try {
    const url = new URL(raw);
    absorb(url.searchParams);
    const hash = url.hash?.replace(/^#/, '') ?? '';
    if (hash) absorb(new URLSearchParams(hash));
  } catch {
    const hashIdx = raw.indexOf('#');
    const queryIdx = raw.indexOf('?');
    if (queryIdx >= 0) {
      const end = hashIdx >= 0 ? hashIdx : raw.length;
      absorb(new URLSearchParams(raw.slice(queryIdx + 1, end)));
    }
    if (hashIdx >= 0) {
      absorb(new URLSearchParams(raw.slice(hashIdx + 1)));
    }
  }

  const pick = (key: string) => {
    const re = new RegExp(`(?:^|[?&#])${key}=([^&#]+)`);
    const m = raw.match(re);
    return m ? decodePart(m[1]) : null;
  };
  if (!access_token) access_token = pick('access_token');
  if (!refresh_token) refresh_token = pick('refresh_token');
  if (!code) code = pick('code');
  if (!oauthError) {
    const em = pick('error');
    if (em) oauthError = em;
  }
  if (!oauthErrorDescription) {
    const ed = pick('error_description');
    if (ed) oauthErrorDescription = ed;
  }

  return {
    access_token,
    refresh_token,
    code,
    error: oauthError,
    error_description: oauthErrorDescription,
  };
}

function formatSupabaseOAuthRedirectError(
  oauthErr: string,
  oauthDesc: string | null
): string {
  let msg = oauthErr;
  if (oauthDesc) {
    try {
      msg += `: ${decodeURIComponent(oauthDesc.replace(/\+/g, ' '))}`;
    } catch {
      msg += `: ${oauthDesc}`;
    }
  }
  if (/Unable to exchange external code/i.test(msg)) {
    msg +=
      '\n\nGoogle + Supabase: Open Google Cloud Console → Credentials → your **Web application** OAuth client. Under Authorized redirect URIs add exactly:\n' +
      SUPABASE_GOOGLE_OAUTH_REDIRECT_URI +
      '\nIn Supabase → Authentication → Google: paste the **Client ID and Client Secret from that same Web client** (not only iOS/Android IDs). Regenerate the secret if unsure, then save.';
  }
  return msg;
}

async function createSessionFromOAuthRedirectUrl(rawUrl: string): Promise<{
  user: User | null;
  error: string | null;
}> {
  if (__DEV__) {
    const redacted = rawUrl
      .replace(/access_token=[^&#]*/gi, 'access_token=…')
      .replace(/refresh_token=[^&#]*/gi, 'refresh_token=…')
      .replace(/code=[^&#]*/gi, 'code=…');
    console.log('OAuth redirect (redacted):', redacted);
  }

  const { access_token, refresh_token, code, error: oauthErr, error_description: oauthDesc } =
    parseOAuthRedirectUrl(rawUrl);

  if (oauthErr) {
    const msg = formatSupabaseOAuthRedirectError(oauthErr, oauthDesc);
    console.error('OAuth provider returned error in redirect:', msg);
    return { user: null, error: msg };
  }

  if (access_token && refresh_token) {
    const { error: sessionError } = await supabase.auth.setSession({
      access_token,
      refresh_token,
    });
    if (sessionError) {
      console.error('setSession error:', sessionError.message);
      return { user: null, error: sessionError.message };
    }
    await new Promise((r) => setTimeout(r, 500));
    const {
      data: { session: verified },
      error: verifyError,
    } = await supabase.auth.getSession();
    if (verifyError || !verified?.user) {
      console.error('Session verification failed:', verifyError?.message);
      return { user: null, error: verifyError?.message ?? 'Failed to persist session' };
    }
    console.log('OAuth session established via setSession');
    return { user: verified.user, error: null };
  }

  if (code) {
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) {
      console.error('exchangeCodeForSession error:', exchangeError.message);
      return { user: null, error: exchangeError.message };
    }
    const user = data.session?.user ?? null;
    if (!user) {
      return { user: null, error: 'No session after code exchange' };
    }
    console.log('OAuth session established via PKCE code exchange');
    return { user, error: null };
  }

  await new Promise((r) => setTimeout(r, 500));
  const { data: { session }, error: sessionCheckError } = await supabase.auth.getSession();
  if (sessionCheckError) {
    return { user: null, error: sessionCheckError.message };
  }
  if (session?.user) {
    console.log('OAuth session already present (auto-set)');
    return { user: session.user, error: null };
  }

  console.error(
    'No tokens, code, or session from OAuth redirect. If the URL looks empty, add liftaiapp://auth/callback under Supabase → Authentication → URL Configuration → Redirect URLs.'
  );
  return {
    user: null,
    error:
      'Sign-in did not return a session. Check Supabase redirect URLs include liftaiapp://auth/callback.',
  };
}

/**
 * Apply tokens/code from a Supabase auth deep link (OAuth return, password recovery, magic link).
 * With `detectSessionInUrl: false`, the client does not auto-parse URLs — call this from the
 * matching screen (e.g. reset password) or root when the app opens via link.
 */
export async function syncSessionFromAuthRedirectUrl(
  url: string | null | undefined
): Promise<{ error: string | null }> {
  if (!url?.trim()) return { error: null };
  const r = await createSessionFromOAuthRedirectUrl(url);
  return { error: r.error };
}

// User interface for type safety
export interface User {
  id: string;
  email?: string;
}

// Session interface
export interface Session {
  user: User;
  access_token: string;
  refresh_token: string;
}

/**
 * Sign up a new user with email and password
 */
/** Translate Supabase auth errors into messages a real user can act on. */
function friendlySignUpError(message: string): string {
  const m = message.toLowerCase();
  if (
    m.includes('password should contain') ||
    m.includes('password must contain') ||
    m.includes('password is too weak') ||
    m.includes("password didn't meet") ||
    m.includes('weak password')
  ) {
    return 'Password must be at least 8 characters and include both letters and numbers.';
  }
  if (m.includes('password should be at least') || m.includes('password is too short')) {
    return 'Password must be at least 8 characters and include both letters and numbers.';
  }
  if (m.includes('user already registered') || m.includes('already registered')) {
    return 'An account with this email already exists. Try signing in instead.';
  }
  if (m.includes('invalid email') || m.includes('unable to validate email')) {
    return 'Please enter a valid email address.';
  }
  return message;
}

export const signUp = async (
  email: string,
  password: string
): Promise<{ user: User | null; error: string | null; needsEmailConfirmation: boolean }> => {
  try {
    console.log('Attempting to sign up user:', email);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      console.error('Sign up error:', error.message);
      return { user: null, error: friendlySignUpError(error.message), needsEmailConfirmation: false };
    }

    if (data.user) {
      // When email confirmation is required, Supabase returns a user but no session.
      const needsEmailConfirmation = !data.session;
      console.log(
        needsEmailConfirmation
          ? 'Sign-up successful — awaiting email confirmation'
          : 'User signed up successfully'
      );
      return { user: data.user, error: null, needsEmailConfirmation };
    }

    return { user: null, error: 'No user data returned', needsEmailConfirmation: false };
  } catch (error) {
    console.error('Unexpected sign up error:', error);
    return { user: null, error: 'An unexpected error occurred', needsEmailConfirmation: false };
  }
};

/**
 * Verify the 6-digit OTP that Supabase emails on signup. Establishes a session
 * on success so the caller can proceed straight into onboarding without a
 * separate sign-in step.
 *
 * Requires the Supabase "Confirm signup" email template to include {{ .Token }}
 * (it does by default for OTP-enabled projects).
 */
export const verifySignupOtp = async (
  email: string,
  token: string
): Promise<{ user: User | null; error: string | null }> => {
  try {
    const cleaned = token.replace(/\D/g, '');
    if (cleaned.length < 6 || cleaned.length > 10) {
      return { user: null, error: 'Enter the code from your email.' };
    }
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: cleaned,
      type: 'signup',
    });
    if (error) {
      const msg = error.message?.toLowerCase() || '';
      if (msg.includes('expired')) {
        return { user: null, error: 'That code has expired. Tap "Resend" to get a new one.' };
      }
      if (msg.includes('invalid') || msg.includes('token')) {
        return { user: null, error: 'That code is invalid. Double-check the email.' };
      }
      return { user: null, error: error.message };
    }
    return { user: data.user ?? null, error: null };
  } catch (e) {
    console.error('verifySignupOtp error:', e);
    return { user: null, error: 'Could not verify the code. Please try again.' };
  }
};

/** Transient RN/fetch failures App Review sometimes hits on busy networks. */
function isTransientSignInNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('network request failed') ||
    m.includes('failed to fetch') ||
    m.includes('network error') ||
    m === 'fetch failed'
  );
}

const SIGN_IN_NETWORK_USER_MESSAGE =
  "We couldn't reach the sign-in service. Check your connection and try again.";

/**
 * Sign in an existing user with email and password
 */
export const signIn = async (email: string, password: string): Promise<{ user: User | null; error: string | null }> => {
  const maxAttempts = 3;

  try {
    console.log('Attempting to sign in user:', email);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (!error) {
        if (data.user) {
          console.log('User signed in successfully');
          return { user: data.user, error: null };
        }
        return { user: null, error: 'No user data returned' };
      }
      console.error(`Sign in error (attempt ${attempt}/${maxAttempts}):`, error.message);

      const transient = isTransientSignInNetworkError(error.message);
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }

      if (transient) {
        return { user: null, error: SIGN_IN_NETWORK_USER_MESSAGE };
      }

      return { user: null, error: error.message };
    }
    return { user: null, error: 'An unexpected error occurred' };
  } catch (error) {
    console.error('Unexpected sign in error:', error);
    return { user: null, error: 'An unexpected error occurred' };
  }
};

function isNoSessionSignOutError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('auth session missing') || m.includes('session missing');
}

/**
 * Sign out the current user
 */
export const signOut = async (): Promise<{ error: string | null }> => {
  try {
    console.log('Signing out user');

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      await clearFunnelSnapshot();
      return { error: null };
    }

    const { error } = await supabase.auth.signOut();

    if (error) {
      if (isNoSessionSignOutError(error.message)) {
        return { error: null };
      }
      console.error('Sign out error:', error.message);
      return { error: error.message };
    }

    console.log('User signed out successfully');
    await clearFunnelSnapshot();
    return { error: null };
  } catch (error) {
    console.error('Unexpected sign out error:', error);
    return { error: 'An unexpected error occurred' };
  }
};

/** Stale AsyncStorage tokens after key rotation, revoke, or server-side sign-out. */
function isInvalidStoredRefreshError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('invalid refresh token') ||
    m.includes('refresh token not found') ||
    m.includes('refresh token') && m.includes('not found')
  );
}

async function clearLocalAuthSession(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* ignore */
  }
}

/**
 * Get the current session - Helper to get typed session
 */
export const getSession = async () => {
  try {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();
    if (error) {
      if (isInvalidStoredRefreshError(error.message)) {
        console.warn('Clearing invalid stored auth session');
        await clearLocalAuthSession();
        return null;
      }
      throw error;
    }
    return session;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isInvalidStoredRefreshError(msg)) {
      console.warn('Clearing invalid stored auth session');
      await clearLocalAuthSession();
      return null;
    }
    throw e;
  }
};

/**
 * Listen to auth state changes
 */
export const onAuthStateChange = (callback: (session: Session | null) => void) => {
  return supabase.auth.onAuthStateChange((event, session) => {
    console.log('Auth state changed:', event);
    callback(session as Session | null);
  });
};

/**
 * Sign in with Google via Supabase-hosted OAuth only.
 * Google sees redirect_uri = https://<project>.supabase.co/auth/v1/callback (Web client).
 * The app’s custom scheme is only used as Supabase `redirect_to` after auth completes.
 */
export const signInWithGoogle = async (): Promise<{ user: User | null; error: string | null }> => {
  try {
    console.log('Attempting Google sign in');

    const redirectUrl = makeRedirectUri({
      scheme: 'liftaiapp',
      path: 'auth/callback',
    });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
      },
    });

    if (error) {
      console.error('Google sign in error:', error.message);
      return { user: null, error: error.message };
    }

    if (!data?.url) {
      return { user: null, error: 'No OAuth URL received' };
    }

    // Web: GoTrue assigns window.location. Native: open Supabase /authorize URL in a session.
    if (Platform.OS === 'web') {
      return { user: null, error: null };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);

    if (result.type === 'success' && 'url' in result && result.url) {
      try {
        return await createSessionFromOAuthRedirectUrl(result.url);
      } catch (parseErr: any) {
        console.error('OAuth redirect handling error:', parseErr);
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          return { user: session.user, error: null };
        }
        return { user: null, error: parseErr?.message ?? 'Failed to parse OAuth redirect' };
      }
    }

    if (result.type === 'cancel') {
      return { user: null, error: 'Sign in cancelled' };
    }

    return { user: null, error: 'OAuth flow failed' };
  } catch (error: any) {
    console.error('Unexpected Google sign in error:', error);
    return { user: null, error: error?.message || 'An unexpected error occurred' };
  }
};

/**
 * Sign in with Apple OAuth
 */
export const signInWithApple = async (): Promise<{ user: User | null; error: string | null }> => {
  try {
    console.log('Attempting Apple sign in');

    const redirectUrl = `liftaiapp://auth/callback`;

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo: redirectUrl,
        skipBrowserRedirect: true, // Important for mobile
      },
    });

    if (error) {
      console.error('Apple sign in error:', error.message);
      return { user: null, error: error.message };
    }

    if (data?.url) {
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectUrl
      );

      if (result.type === 'success' && 'url' in result && result.url) {
        try {
          return await createSessionFromOAuthRedirectUrl(result.url);
        } catch (urlError: any) {
          console.error('OAuth redirect handling error:', urlError);
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.user) {
            return { user: session.user, error: null };
          }
          return { user: null, error: urlError?.message ?? 'Failed to parse OAuth redirect' };
        }
      }

      if (result.type === 'cancel') {
        return { user: null, error: 'Sign in cancelled' };
      }

      return { user: null, error: 'OAuth flow failed' };
    }

    return { user: null, error: 'No OAuth URL received' };
  } catch (error: any) {
    console.error('Unexpected Apple sign in error:', error);
    return { user: null, error: error?.message || 'An unexpected error occurred' };
  }
};

/**
 * Native Apple Sign-In for iOS
 */
export const signInWithAppleNative = async (): Promise<{
  user: User | null;
  error: string | null;
  fullName?: { givenName?: string | null; familyName?: string | null };
}> => {
  if (Platform.OS !== 'ios') {
    const result = await signInWithApple();
    return { ...result, fullName: undefined };
  }

  try {
    // Skip native Apple Sign-In when running in Expo Go (native modules not available)
    const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
      Constants.executionEnvironment === ('storeClient' as any) ||
      !Constants.executionEnvironment;

    if (isExpoGo) {
      console.log('Running in Expo Go — falling back to web-based Apple Sign-In');
      const result = await signInWithApple();
      return { ...result, fullName: undefined };
    }

    let AppleAuthentication: typeof import('expo-apple-authentication');
    let ExpoCrypto: typeof import('expo-crypto');

    try {
      AppleAuthentication = await import('expo-apple-authentication');
      ExpoCrypto = await import('expo-crypto');
    } catch (importError) {
      console.log('Native modules not available, falling back to web-based Apple Sign-In');
      const result = await signInWithApple();
      return { ...result, fullName: undefined };
    }

    const isAvailable = await AppleAuthentication.isAvailableAsync();
    if (!isAvailable) {
      const result = await signInWithApple();
      return { ...result, fullName: undefined };
    }

    // Generate nonce
    const rawNonce = Array.from(
      await ExpoCrypto.getRandomBytesAsync(32),
      (byte: number) => byte.toString(16).padStart(2, '0')
    ).join('');

    const hashedNonce = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      rawNonce
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      return { user: null, error: 'No identity token received' };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });

    if (error) {
      console.error('Supabase signInWithIdToken error:', error.message);
      return { user: null, error: error.message, fullName: credential.fullName ?? undefined };
    }

    // CRITICAL FIX: Wait for session to persist
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify session was saved
    const { data: { session: verifiedSession }, error: verifyError } = await supabase.auth.getSession();

    if (verifyError || !verifiedSession) {
      console.error('Session verification failed after native Apple sign-in');
      return { user: null, error: 'Failed to persist session', fullName: credential.fullName ?? undefined };
    }

    // Apple only returns full name on the first successful sign-in — persist immediately.
    const givenName = credential.fullName?.givenName?.trim();
    const familyName = credential.fullName?.familyName?.trim();

    if (givenName || familyName) {
      const fullName = [givenName, familyName].filter(Boolean).join(' ');
      const greetingFirst = givenName || fullName.split(/\s+/)[0] || fullName;

      const data: Record<string, string> = {
        full_name: fullName,
        name: fullName,
      };
      if (givenName) data.given_name = givenName;
      if (familyName) data.family_name = familyName;

      await supabase.auth.updateUser({ data });

      try {
        await AsyncStorage.multiSet([
          ['@user_given_name', givenName ?? ''],
          ['@user_family_name', familyName ?? ''],
          ['@user_full_name', fullName],
          ['@user_name', greetingFirst],
        ]);
      } catch (storageErr) {
        console.warn('Could not cache Apple name in AsyncStorage:', storageErr);
      }
    }

    console.log('Native Apple Sign-In successful - session verified');
    return {
      user: verifiedSession.user,
      error: null,
      fullName: credential.fullName ?? undefined,
    };
  } catch (error: any) {
    if (error.code === 'ERR_REQUEST_CANCELED') {
      return { user: null, error: 'Sign in cancelled' };
    }
    console.error('Native Apple sign-in error:', error);
    const result = await signInWithApple();
    return { ...result, fullName: undefined };
  }
};

/**
 * Send password reset email
 */
export const resetPasswordForEmail = async (email: string): Promise<{ data: any; error: string | null }> => {
  try {
    console.log('Sending password reset email to:', email);

    // Ensure the redirect URL matches what is set in Supabase dashboard
    // This deep link will open the app and can be handled to show a "set new password" screen
    // Must match Expo Router path app/auth/reset-password.tsx → /auth/reset-password
    const redirectUrl = `liftaiapp://auth/reset-password`;

    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl,
    });

    if (error) {
      console.error('Reset password error:', error.message);
      return { data: null, error: error.message };
    }

    console.log('Password reset email sent');
    return { data, error: null };
  } catch (error: any) {
    console.error('Unexpected reset password error:', error);
    return { data: null, error: error?.message || 'An unexpected error occurred' };
  }
};

/**
 * Passwordless sign-in: emails a magic link the user taps to land back in the
 * app authenticated. Works for both new and returning users.
 */
export const sendMagicLink = async (
  email: string,
  { createUser = true }: { createUser?: boolean } = {}
): Promise<{ error: string | null }> => {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/^\S+@\S+\.\S+$/.test(trimmed)) {
    return { error: 'Please enter a valid email address.' };
  }
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        shouldCreateUser: createUser,
        emailRedirectTo: 'liftaiapp://auth/callback',
      },
    });
    if (error) {
      console.error('Magic link error:', error.message);
      return { error: error.message };
    }
    return { error: null };
  } catch (e: any) {
    console.error('Unexpected magic link error:', e);
    return { error: e?.message || 'Could not send magic link.' };
  }
};
