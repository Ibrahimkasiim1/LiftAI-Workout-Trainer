import { useRouter } from 'expo-router';
import React from 'react';
import {
  Image,
  Linking,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CirclePixelAnimation } from '../../components/CirclePixelAnimation';
import { theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useColors } from '../../hooks/useColors';

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isDark } = useTheme();
  const colors = useColors();

  const handleGetStarted = () => {
    // replace, NOT push: pushing left this pre-auth screen at the bottom of the
    // root stack for the entire funnel (quiz → sign-up → paywall → first
    // workout all use replace), so any goBack() from the workout player landed
    // a signed-in — even paying — user back on this logged-out screen. The
    // quiz intro's back button handles the return trip explicitly
    // (canGoBack() ? back() : replace('/auth/welcome')).
    router.replace('/onboarding');
  };

  const handleSignIn = () => {
    router.push('/auth?mode=sign-in');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} translucent backgroundColor="transparent" />

      {/* Top Image */}
      <Image
        source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
        style={styles.heroImage}
        resizeMode="contain"
      />

      {/* Circle Pixel Animation - Middle */}
      <View style={styles.animationContainer}>
        <CirclePixelAnimation />
      </View>

      {/* Bottom Content */}
      <View style={[styles.bottomContainer, { paddingBottom: Math.max(insets.bottom, 20), backgroundColor: colors.background }]}>

        {/* Text Content */}
        <View style={styles.textContainer}>
          <Text style={[styles.title, { color: colors.text }]}>Welcome</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>Your journey starts here</Text>
        </View>

        {/* Buttons */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.text }]}
            onPress={handleGetStarted}
            activeOpacity={0.8}
          >
            <Text style={[styles.primaryButtonText, { color: colors.textInverse }]}>Get Started Now</Text>
          </TouchableOpacity>

          {/* Sign in link */}
          <TouchableOpacity
            style={styles.signInLink}
            onPress={handleSignIn}
            activeOpacity={0.8}
          >
            <Text style={[styles.signInLinkText, { color: colors.textMuted }]}>
              Already have an account? <Text style={[styles.signInLinkBold, { color: colors.text }]}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </View>

        {/* Legal Text */}
        <Text style={[styles.legalText, { color: colors.textMuted }]}>
          By continuing you agree to our{'\n'}
          <Text style={[styles.legalLink, { color: colors.textSecondary }]} onPress={() => Linking.openURL('https://liftaiapp.com/terms.html')}>Terms of Service</Text> and <Text style={[styles.legalLink, { color: colors.textSecondary }]} onPress={() => Linking.openURL('https://liftaiapp.com/privacy.html')}>Privacy Policy</Text>. You may also receive product updates and occasional marketing emails — you can unsubscribe anytime.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  animationContainer: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 40,
    paddingTop: 52,
  },
  bottomContainer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: 36,
  },
  textContainer: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 16,
    marginBottom: 8,
  },
  heroImage: {
    width: 120,
    height: 240,
    marginBottom: -80,
    alignSelf: 'center',
    marginTop: 12,
  },
  title: {
    fontSize: 36,
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.medium,
    textAlign: 'center',
    marginBottom: 20,
  },
  buttonContainer: {
    gap: 16,
    marginBottom: 16,
  },
  primaryButton: {
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  primaryButtonText: {
    fontSize: 18,
    fontFamily: theme.typography.fontFamily.bold,
  },
  signInLink: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  signInLinkText: {
    fontSize: 14,
    fontFamily: theme.typography.fontFamily.regular,
  },
  signInLinkBold: {
    fontFamily: theme.typography.fontFamily.bold,
  },
  legalText: {
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  legalLink: {
    textDecorationLine: 'underline',
  },
});
