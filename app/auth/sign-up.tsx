// app/auth/sign-up.tsx
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
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
import { getFirstName } from '../../utils/nameUtils';
import {
    getSession,
    sendMagicLink,
    signInWithAppleNative,
    signInWithGoogle,
    signUp,
    supabase,
    verifySignupOtp,
} from '../../utils/supabase';
import { replaceWithPostAuthRoute } from '../../utils/authNavigation';
import {
    clearPendingSignup,
    readPendingSignup,
    writePendingSignup,
} from '../../utils/pendingSignup';
import { identifyUserForAnalytics, posthog } from '../../src/config/posthog';

const OTP_LENGTH = 8;

export default function SignUpScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { isDark } = useTheme();
    const colors = useColors();

    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);
    const [resending, setResending] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const [verifyingOtp, setVerifyingOtp] = useState(false);
    const [magicLinkLoading, setMagicLinkLoading] = useState(false);
    const [magicLinkSent, setMagicLinkSent] = useState<string | null>(null);

    // Restore the OTP screen if the user closed the app mid-confirmation.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const pending = await readPendingSignup();
            if (cancelled || !pending) return;
            setPendingConfirmationEmail(pending.email);
            if (pending.name && !name) setName(pending.name);
            if (!email) setEmail(pending.email);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleVerifyOtp = async () => {
        if (!pendingConfirmationEmail) return;
        const cleaned = otpCode.replace(/\D/g, '');
        if (cleaned.length !== OTP_LENGTH) {
            toast.error('Invalid code', `Enter the ${OTP_LENGTH}-digit code from your email.`);
            return;
        }
        setVerifyingOtp(true);
        try {
            const { user, error } = await verifySignupOtp(pendingConfirmationEmail, cleaned);
            if (error || !user) {
                toast.error('Could not verify', error || 'Try again.');
                return;
            }
            // verifyOtp establishes the session — no second sign-in needed.
            await persistName(name);
            identifyUserForAnalytics(user.id, {
                $set: { email: pendingConfirmationEmail, name },
                $set_once: { first_sign_up_date: new Date().toISOString() },
            });
            posthog.capture('user_email_confirmed', { method: 'otp' });
            await clearPendingSignup();
            setPendingConfirmationEmail(null);
            router.replace('/onboarding');
        } catch (e) {
            console.error('OTP verify error:', e);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setVerifyingOtp(false);
        }
    };

    const handleResendConfirmation = async () => {
        if (!pendingConfirmationEmail) return;
        setResending(true);
        try {
            const { error } = await supabase.auth.resend({
                type: 'signup',
                email: pendingConfirmationEmail,
            });
            if (error) {
                toast.error('Could not resend', error.message);
            } else {
                toast.success('Email sent', 'We sent another confirmation email. Please check your inbox.');
            }
        } catch (e) {
            console.warn('Resend confirmation failed:', e);
            toast.error('Could not resend confirmation email', 'Please try again.');
        } finally {
            setResending(false);
        }
    };

    // =========================================================================
    // Helper: Check if error is a user cancellation (NOT a real error)
    // Apple Sign-In THROWS when user dismisses the dialog — this is expected
    // behavior, not a bug. We must catch it and silently return.
    // =========================================================================
    const isUserCancellation = (error: any): boolean => {
        if (!error) return false;
        const message = String(error?.message || error || '');
        const code = String(error?.code || '');
        return (
            code === 'ERR_REQUEST_CANCELED' ||
            code === 'ERR_CANCELED' ||
            code === '1001' ||
            message.includes('canceled') ||
            message.includes('cancelled') ||
            message.includes('user denied') ||
            message.includes("The operation couldn") ||
            message.includes('AuthorizationError error 1001')
        );
    };

    // =========================================================================
    // Helper: Safely persist name to AsyncStorage AND Supabase user_metadata.
    // Saving to user_metadata means the name survives app reinstalls —
    // critical because Apple only provides the name on FIRST sign-in.
    // =========================================================================
    const persistName = async (nameValue: string) => {
        try {
            if (nameValue && nameValue.trim()) {
                const firstName = getFirstName(nameValue);
                await AsyncStorage.setItem('@user_name', firstName);
                // Save to Supabase metadata so it persists across installs
                await supabase.auth.updateUser({
                    data: { full_name: firstName }
                });
            }
        } catch (e) {
            console.warn('Failed to persist name, continuing:', e);
            // Non-fatal: onboarding will ask for name if missing
        }
    };

    // =========================================================================
    // Helper: Navigate after auth — resume the exact funnel stage via the
    // guard (a returning mid-funnel user must not restart the quiz).
    // =========================================================================
    const navigateAfterAuth = async (_userId: string) => {
        await replaceWithPostAuthRoute();
    };

    const handleSignUp = async () => {
        if (!name || !email || !password) {
            toast.error('Please fill in all fields');
            return;
        }
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
            toast.error('Password must be at least 8 characters and include both letters and numbers.');
            return;
        }

        setLoading(true);
        try {
            const result = await signUp(email, password);
            if (result.error) {
                const lower = result.error.toLowerCase();
                const alreadyExists = lower.includes('already exists') || lower.includes('already registered');
                if (alreadyExists) {
                    // Could be (a) an unconfirmed prior signup we should resume,
                    // or (b) an already-confirmed account → push them to sign-in.
                    const { error: resendErr } = await supabase.auth.resend({ type: 'signup', email });
                    const resendLower = (resendErr?.message || '').toLowerCase();
                    const alreadyConfirmed =
                        resendLower.includes('already confirmed') ||
                        resendLower.includes('already been confirmed') ||
                        resendLower.includes('user is already confirmed');

                    if (!resendErr) {
                        // Unconfirmed account exists — drop them back on the OTP screen.
                        await writePendingSignup(email, name);
                        await AsyncStorage.setItem('@user_name', name);
                        await AsyncStorage.setItem('@auth_provider', 'email');
                        setPendingConfirmationEmail(email);
                        return;
                    }

                    if (alreadyConfirmed) {
                        const goToSignIn = await confirmSheet({
                            title: 'Account already exists',
                            message: 'This email is already registered. Please sign in instead.',
                            confirmLabel: 'Go to sign in',
                        });
                        if (goToSignIn) {
                            router.replace({ pathname: '/auth', params: { email } });
                        }
                        return;
                    }
                    // Fall through: surface the resend error
                    toast.error(resendErr?.message || result.error);
                    return;
                }
                toast.error(result.error);
                return;
            }
            if (result.user) {
                await AsyncStorage.setItem('@user_name', name);
                await AsyncStorage.setItem('@auth_provider', 'email');

                if (result.needsEmailConfirmation) {
                    posthog.capture('user_signed_up', {
                        method: 'email',
                        pending_email_confirmation: true,
                    });
                    await writePendingSignup(email, name);
                    setPendingConfirmationEmail(email);
                    return;
                }

                const session = await getSession();
                if (!session) {
                    // No session and no confirmation flag — treat as confirmation flow
                    // so the user is told to check their email rather than seeing an error.
                    await writePendingSignup(email, name);
                    setPendingConfirmationEmail(email);
                    return;
                }
                identifyUserForAnalytics(result.user.id, {
                    $set: { email, name },
                    $set_once: { first_sign_up_date: new Date().toISOString() },
                });
                posthog.capture('user_signed_up', { method: 'email' });
                await clearPendingSignup();
                router.replace('/onboarding');
            }
        } catch (error) {
            console.error('Sign up error:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleSignUp = async () => {
        setLoading(true);
        try {
            const result = await signInWithGoogle();
            if (result.error) {
                toast.error(result.error);
                return;
            }
            if (result.user) {
                const googleName = (result.user as any)?.user_metadata?.full_name ||
                    (result.user as any)?.user_metadata?.name;
                if (googleName) await persistName(googleName);
                await AsyncStorage.setItem('@auth_provider', 'google');

                const session = await getSession();
                if (!session) {
                    toast.error('Could not establish a session', 'Please try signing in again.');
                    return;
                }
                identifyUserForAnalytics(result.user.id, {
                    $set: { email: result.user.email, name: googleName },
                    $set_once: { first_sign_up_date: new Date().toISOString() },
                });
                posthog.capture('user_signed_up', { method: 'google' });
                await clearPendingSignup();
                await navigateAfterAuth(result.user.id);
            }
        } catch (error: any) {
            if (isUserCancellation(error)) return; // User cancelled — not an error
            console.error('Google auth error:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // =========================================================================
    // CRASH FIX: Apple Sign-In — triple-wrapped error handling
    //
    // Root causes of crashes:
    // 1. signInWithAppleNative() THROWS (not returns error) when user cancels
    // 2. Accessing fullName properties on nil/undefined on 2nd+ sign-in
    // 3. Native ASAuthorizationError propagates as unhandled exception
    //
    // Fix: Inner try/catch specifically for the native call, cancellation
    // detection, and safe property access with optional chaining throughout.
    // =========================================================================
    const handleAppleSignUp = async () => {
        setLoading(true);
        try {
            // INNER try/catch: signInWithAppleNative can THROW on cancellation
            let result: any;
            try {
                result = await signInWithAppleNative();
            } catch (nativeError: any) {
                if (isUserCancellation(nativeError)) {
                    console.log('Apple sign-in cancelled by user');
                    setLoading(false);
                    return;
                }
                throw nativeError; // Re-throw real errors to outer catch
            }

            // Handle returned errors (vs thrown errors)
            if (result?.error) {
                if (isUserCancellation(result.error)) return;
                const msg = typeof result.error === 'string'
                    ? result.error
                    : 'Apple sign-in failed. Please try again.';
                toast.error(msg);
                return;
            }

            if (!result?.user) {
                console.warn('Apple auth returned no user and no error');
                return; // Silently bail — likely cancelled
            }

            console.log('Apple authentication successful');

            // Extract name — wrapped in try/catch because fullName can be
            // undefined, null, or throw on certain iOS versions
            let appleName: string | undefined;
            try {
                const given = result.fullName?.givenName;
                const family = result.fullName?.familyName;
                if (given || family) {
                    appleName = [given, family].filter(Boolean).join(' ');
                }
            } catch (nameError) {
                console.warn('Error reading Apple fullName:', nameError);
            }

            // Fallback: check Supabase user_metadata (set on previous sign-in)
            if (!appleName) {
                appleName = (result.user as any)?.user_metadata?.full_name ||
                    (result.user as any)?.user_metadata?.name;
            }

            // given_name / family_name / full_name + AsyncStorage are written inside signInWithAppleNative on first sign-in.
            if (!appleName?.trim()) {
                console.log('No name from Apple — onboarding will prompt for name');
            }

            await AsyncStorage.setItem('@auth_provider', 'apple');

            const session = await getSession();
            if (!session) {
                toast.error('Could not establish a session', 'Please try signing in again.');
                return;
            }

            identifyUserForAnalytics(result.user.id, {
                $set: { email: result.user.email, name: appleName },
                $set_once: { first_sign_up_date: new Date().toISOString() },
            });
            posthog.capture('user_signed_up', { method: 'apple' });
            await clearPendingSignup();
            await navigateAfterAuth(result.user.id);

        } catch (error: any) {
            // OUTER catch: final safety net
            if (isUserCancellation(error)) return;
            console.error('Apple auth error:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleSignInRedirect = () => {
        router.push('/auth?mode=sign-in');
    };

    const handleMagicLink = async () => {
        const trimmedEmail = email.trim();
        if (!trimmedEmail) {
            toast.error('Email required', 'Enter your email above to receive a magic link.');
            return;
        }
        setMagicLinkLoading(true);
        try {
            if (name?.trim()) {
                await AsyncStorage.setItem('@user_name', getFirstName(name));
                await AsyncStorage.setItem('@user_full_name', name.trim());
            }
            await AsyncStorage.setItem('@auth_provider', 'magic_link');
            const { error } = await sendMagicLink(trimmedEmail, { createUser: true });
            if (error) {
                toast.error('Could not send link', error);
                return;
            }
            posthog.capture('magic_link_sent', { context: 'sign_up' });
            setMagicLinkSent(trimmedEmail);
        } catch (e) {
            console.error('Magic link error:', e);
            toast.error('Could not send magic link', 'Please try again.');
        } finally {
            setMagicLinkLoading(false);
        }
    };

    if (magicLinkSent) {
        return (
            <View style={[styles.container, { backgroundColor: colors.background }]}>
                <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.keyboardView}>
                        <View style={styles.logoContainer}>
                            <View style={[styles.confirmIconCircle, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                                <Ionicons name="paper-plane-outline" size={42} color={colors.text} />
                            </View>
                            <Text style={[styles.welcomeText, { color: colors.text }]}>
                                Check your inbox
                            </Text>
                            <Text style={[styles.subtitleText, { color: colors.textMuted }]}>
                                {`We sent a magic link to\n`}
                                <Text style={{ color: colors.text, fontFamily: theme.typography.fontFamily.bold }}>
                                    {magicLinkSent}
                                </Text>
                            </Text>
                            <Text style={[styles.subtitleText, { color: colors.textMuted, marginTop: 16 }]}>
                                Tap the link in the email to finish signing in.
                            </Text>
                        </View>

                        <View style={styles.form}>
                            <TouchableOpacity
                                style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, magicLinkLoading && styles.buttonDisabled]}
                                onPress={handleMagicLink}
                                disabled={magicLinkLoading}
                            >
                                {magicLinkLoading ? (
                                    <ActivityIndicator color={colors.text} />
                                ) : (
                                    <Text style={[styles.socialButtonText, { color: colors.text }]}>
                                        Resend link
                                    </Text>
                                )}
                            </TouchableOpacity>

                            <View style={styles.footer}>
                                <Text style={[styles.footerText, { color: colors.textMuted }]}>
                                    Wrong email?
                                </Text>
                                <TouchableOpacity onPress={() => setMagicLinkSent(null)}>
                                    <Text style={[styles.footerLink, { color: colors.text }]}>
                                        {' Use a different one'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </ScrollView>
            </View>
        );
    }

    if (pendingConfirmationEmail) {
        return (
            <View style={[styles.container, { backgroundColor: colors.background }]}>
                <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.keyboardView}>
                        <View style={styles.logoContainer}>
                            <View style={[styles.confirmIconCircle, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                                <Ionicons name="mail-outline" size={42} color={colors.text} />
                            </View>
                            <Text style={[styles.welcomeText, { color: colors.text }]}>
                                Confirm your email
                            </Text>
                            <Text style={[styles.subtitleText, { color: colors.textMuted }]}>
                                {`We sent a ${OTP_LENGTH}-digit code to\n`}
                                <Text style={{ color: colors.text, fontFamily: theme.typography.fontFamily.bold }}>
                                    {pendingConfirmationEmail}
                                </Text>
                            </Text>
                            <Text style={[styles.subtitleText, { color: colors.textMuted, marginTop: 16 }]}>
                                Enter the code below to finish creating your account.
                            </Text>
                        </View>

                        <View style={styles.form}>
                            <TextInput
                                style={[
                                    styles.input,
                                    styles.otpInput,
                                    { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border },
                                ]}
                                value={otpCode}
                                onChangeText={(t) => setOtpCode(t.replace(/\D/g, '').slice(0, OTP_LENGTH))}
                                placeholder={'•'.repeat(OTP_LENGTH)}
                                placeholderTextColor={colors.textMuted}
                                keyboardType="number-pad"
                                inputMode="numeric"
                                autoFocus
                                maxLength={OTP_LENGTH}
                                textContentType="oneTimeCode"
                                autoComplete="one-time-code"
                                returnKeyType="done"
                                onSubmitEditing={handleVerifyOtp}
                            />

                            <TouchableOpacity
                                style={[
                                    styles.mainButton,
                                    { backgroundColor: colors.text },
                                    (verifyingOtp || otpCode.length !== OTP_LENGTH) && styles.buttonDisabled,
                                ]}
                                onPress={handleVerifyOtp}
                                disabled={verifyingOtp || otpCode.length !== OTP_LENGTH}
                            >
                                {verifyingOtp ? (
                                    <ActivityIndicator color={isDark ? '#000000' : colors.textInverse} />
                                ) : (
                                    <Text style={[styles.mainButtonText, { color: colors.textInverse }]}>
                                        Verify & Continue
                                    </Text>
                                )}
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, resending && styles.buttonDisabled]}
                                onPress={handleResendConfirmation}
                                disabled={resending}
                            >
                                {resending ? (
                                    <ActivityIndicator color={colors.text} />
                                ) : (
                                    <Text style={[styles.socialButtonText, { color: colors.text }]}>
                                        Resend code
                                    </Text>
                                )}
                            </TouchableOpacity>

                            <View style={styles.footer}>
                                <Text style={[styles.footerText, { color: colors.textMuted }]}>
                                    Wrong email?
                                </Text>
                                <TouchableOpacity
                                    onPress={async () => {
                                        await clearPendingSignup();
                                        setOtpCode('');
                                        setPendingConfirmationEmail(null);
                                    }}
                                >
                                    <Text style={[styles.footerLink, { color: colors.text }]}>
                                        {' Use a different one'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </ScrollView>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <StatusBar barStyle={isDark ? "light-content" : "dark-content"} translucent backgroundColor="transparent" />
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
                            Create your account
                        </Text>
                        <Text style={[styles.subtitleText, { color: colors.textMuted }]}>
                            Sign up to start your fitness journey
                        </Text>
                    </View>

                    <View style={styles.form}>
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                            value={name}
                            onChangeText={(text) => {
                                const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
                                setName(capitalized);
                            }}
                            placeholder="Your Name"
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="words"
                            autoCorrect={false}
                        />
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
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                            value={password}
                            onChangeText={setPassword}
                            placeholder="Create Password"
                            placeholderTextColor={colors.textMuted}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <TouchableOpacity
                            style={[styles.mainButton, { backgroundColor: colors.text }, loading && styles.buttonDisabled]}
                            onPress={handleSignUp}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color={isDark ? '#000000' : colors.textInverse} />
                            ) : (
                                <Text style={[styles.mainButtonText, { color: colors.textInverse }]}>
                                    Sign up
                                </Text>
                            )}
                        </TouchableOpacity>

                        <View style={styles.dividerContainer}>
                            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                            <Text style={[styles.dividerText, { color: colors.textMuted }]}>or</Text>
                            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                        </View>

                        <TouchableOpacity
                            style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}
                            onPress={handleAppleSignUp}
                            disabled={loading}
                        >
                            <Ionicons name="logo-apple" size={20} color={colors.text} style={styles.socialIcon} />
                            <Text style={[styles.socialButtonText, { color: colors.text }]}>
                                Sign Up With Apple
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.socialButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}
                            onPress={handleGoogleSignUp}
                            disabled={loading}
                        >
                            <Ionicons name="logo-google" size={20} color={colors.text} style={styles.socialIcon} />
                            <Text style={[styles.socialButtonText, { color: colors.text }]}>
                                Sign Up With Google
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

                        <View style={styles.footer}>
                            <Text style={[styles.footerText, { color: colors.textMuted }]}>
                                Already have an account?
                            </Text>
                            <TouchableOpacity onPress={handleSignInRedirect}>
                                <Text style={[styles.footerLink, { color: colors.text }]}>
                                    {' Sign in'}
                                </Text>
                            </TouchableOpacity>
                        </View>

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

const styles = StyleSheet.create({
    container: { flex: 1 },
    scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },
    keyboardView: { flex: 1, justifyContent: 'center' },
    logoContainer: { alignItems: 'center', marginBottom: 32, marginTop: 0 },
    logo: { width: 100, height: 50, marginBottom: 12 },
    welcomeText: { fontSize: 32, fontFamily: theme.typography.fontFamily.bold, marginBottom: 8, textAlign: 'center' },
    subtitleText: { fontSize: 16, fontFamily: theme.typography.fontFamily.regular, textAlign: 'center' },
    form: { width: '100%' },
    input: { borderRadius: 16, padding: 20, fontSize: 16, fontFamily: theme.typography.fontFamily.regular, borderWidth: 1, marginBottom: 16 },
    otpInput: {
        textAlign: 'center',
        fontSize: 26,
        letterSpacing: 6,
        fontFamily: theme.typography.fontFamily.bold,
        paddingVertical: 20,
    },
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
    confirmIconCircle: {
        width: 88,
        height: 88,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
        borderWidth: 1,
    },
});
