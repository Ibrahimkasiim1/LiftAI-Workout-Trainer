// components/ProFeatureLockScreen.tsx
//
// Full-screen lock state shown in place of a Pro-gated tab/section.
// Pulls headline + bullets from the PAYWALL_COPY map so the message is
// specific to the feature the user just tried to use.

import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { PAYWALL_COPY, useProGate, type GatedFeature } from '../hooks/useProGate';

interface Props {
  feature: GatedFeature;
  /** Optional sub-headline override; otherwise pulled from PAYWALL_COPY. */
  subhead?: string;
  /** Optional callback after a successful upgrade (e.g. retry the gated action). */
  onUnlocked?: () => void;
}

export default function ProFeatureLockScreen({ feature, subhead, onUnlocked }: Props) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { showPaywall, isPro } = useProGate();
  const copy = PAYWALL_COPY[feature];

  const handlePress = async () => {
    await showPaywall(feature);
    if (isPro) onUnlocked?.();
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.iconWrap,
            { backgroundColor: colors.primary + '22', borderColor: colors.primary },
          ]}
        >
          <Ionicons name="lock-closed" size={36} color={colors.primary} />
        </View>

        <Text style={[styles.headline, { color: colors.text }]}>{copy.headline}</Text>
        <Text style={[styles.subhead, { color: colors.textMuted }]}>
          {subhead ?? copy.subhead}
        </Text>

        <View style={styles.bullets}>
          {copy.bullets.map((b) => (
            <View key={b} style={styles.bulletRow}>
              <View style={[styles.bulletDot, { backgroundColor: colors.primary }]}>
                <Ionicons name="checkmark" size={14} color={colors.textInverse ?? '#000'} />
              </View>
              <Text style={[styles.bulletText, { color: colors.text }]}>{b}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.cta, { backgroundColor: colors.primary }]}
          onPress={handlePress}
          activeOpacity={0.85}
        >
          <Ionicons name="sparkles" size={18} color={colors.textInverse ?? '#000'} />
          <Text style={[styles.ctaText, { color: colors.textInverse ?? '#000' }]}>
            Upgrade to Pro
          </Text>
        </TouchableOpacity>

        <Text style={[styles.footnote, { color: colors.textMuted }]}>
          Cancel anytime · Restore from Settings
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 40,
    gap: 20,
  },
  iconWrap: {
    width: 84,
    height: 84,
    borderRadius: 24,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  headline: {
    fontFamily: 'Montserrat_700Bold',
    fontSize: 26,
    textAlign: 'center',
  },
  subhead: {
    fontFamily: 'Montserrat_500Medium',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  bullets: {
    alignSelf: 'stretch',
    gap: 16,
    marginVertical: 8,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  bulletDot: {
    width: 22,
    height: 22,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  bulletText: {
    flex: 1,
    fontFamily: 'Montserrat_500Medium',
    fontSize: 15,
    lineHeight: 22,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
    alignSelf: 'stretch',
    marginTop: 12,
  },
  ctaText: {
    fontFamily: 'Montserrat_700Bold',
    fontSize: 17,
  },
  footnote: {
    fontFamily: 'Montserrat_500Medium',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
});
