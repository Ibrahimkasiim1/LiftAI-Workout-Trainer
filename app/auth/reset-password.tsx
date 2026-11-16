// app/reset-password.tsx
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Image,
    KeyboardAvoidingView,
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

import { getThemeColors, theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { toast } from '../../components/ui/Toast';
import { replaceWithSignedOutRoot } from '../../utils/authNavigation';
import { supabase, syncSessionFromAuthRedirectUrl } from '../../utils/supabase';

export default function ResetPasswordScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    const handleBack = () => {
        if (router.canGoBack()) {
            router.back();
        } else {
            replaceWithSignedOutRoot();
        }
    };

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);

    // Supabase recovery emails open liftaiapp://auth/reset-password#access_token=... — with
    // detectSessionInUrl: false we must apply tokens from the URL before updateUser can run.
    useEffect(() => {
        let active = true;
        const consume = async (url: string | null) => {
            if (!url || !active) return;
            if (!/reset-password/i.test(url)) return;
            const { error } = await syncSessionFromAuthRedirectUrl(url);
            if (!active || !error) return;
            console.warn('Recovery link session sync:', error);
        };
        Linking.getInitialURL().then(consume);
        const sub = Linking.addEventListener('url', (e) => consume(e.url));
        return () => {
            active = false;
            sub.remove();
        };
    }, []);

    const handleUpdatePassword = async () => {
        if (!password || !confirmPassword) {
            toast.error('Please fill in all fields');
            return;
        }

        if (password !== confirmPassword) {
            toast.error('Passwords do not match');
            return;
        }

        if (password.length < 6) {
            toast.error('Password must be at least 6 characters');
            return;
        }

        setLoading(true);
        try {
            const { error } = await supabase.auth.updateUser({ password });

            if (error) {
                toast.error(error.message);
            } else {
                toast.success('Password updated', 'You can now sign in with your new password.');
                // Ensure we are signed out before going back to auth
                supabase.auth.signOut().then(() => {
                    replaceWithSignedOutRoot();
                });
            }
        } catch (error: any) {
            console.error('Update password error:', error);
            toast.error(error?.message || 'Something went wrong');
        } finally {
            setLoading(false);
        }
    };

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <StatusBar barStyle={isDark ? "light-content" : "dark-content"} translucent backgroundColor="transparent" />

            <View style={[styles.header, { marginTop: insets.top, borderBottomColor: colors.border }]}>
                <TouchableOpacity
                    onPress={handleBack}
                    style={styles.backIconButton}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                >
                    <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
            </View>

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
                            Set New Password
                        </Text>
                        <Text style={[styles.subtitleText, { color: colors.textMuted }]}>
                            Enter your new password below.
                        </Text>
                    </View>

                    <View style={styles.form}>
                        <TextInput
                            style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                            value={password}
                            onChangeText={setPassword}
                            placeholder="New Password"
                            placeholderTextColor={colors.textMuted}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <TextInput
                            style={[styles.input, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                            value={confirmPassword}
                            onChangeText={setConfirmPassword}
                            placeholder="Confirm New Password"
                            placeholderTextColor={colors.textMuted}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <TouchableOpacity
                            style={[styles.mainButton, { backgroundColor: colors.text }, loading && styles.buttonDisabled]}
                            onPress={handleUpdatePassword}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color={isDark ? '#000000' : colors.textInverse} />
                            ) : (
                                <Text style={[styles.mainButtonText, { color: colors.textInverse }]}>
                                    Update Password
                                </Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </KeyboardAvoidingView>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        zIndex: 10,
    },
    backIconButton: { padding: 8 },
    scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },
    keyboardView: { flex: 1, justifyContent: 'center' },
    logoContainer: { alignItems: 'center', marginBottom: 32 },
    logo: { width: 100, height: 50, marginBottom: 12 },
    welcomeText: { fontSize: 32, fontFamily: theme.typography.fontFamily.bold, marginBottom: 8, textAlign: 'center' },
    subtitleText: { fontSize: 16, fontFamily: theme.typography.fontFamily.regular, textAlign: 'center' },
    form: { width: '100%' },
    input: { borderRadius: 16, padding: 20, fontSize: 16, fontFamily: theme.typography.fontFamily.regular, borderWidth: 1, marginBottom: 16 },
    mainButton: { borderRadius: 999, paddingVertical: 20, alignItems: 'center', marginBottom: 24 },
    buttonDisabled: { opacity: 0.7 },
    mainButtonText: { fontSize: 16, fontFamily: theme.typography.fontFamily.bold },
});
