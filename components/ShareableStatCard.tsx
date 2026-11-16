// components/ShareableStatCard.tsx
/**
 * Instagram-Stories share template (9:16). Rendered off-screen and captured to
 * a PNG by utils/shareStat.ts, then handed to the iOS/Android share sheet.
 *
 * Used for celebratory moments — a new streak milestone or a PR. Keep the
 * layout self-contained (no theme hooks / async fonts beyond the bundled
 * Montserrat family) so the snapshot is deterministic.
 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type ShareStat = {
  kind: 'streak' | 'pr';
  /** The hero number, e.g. "14" or "225 lb". */
  value: string;
  /** Caption under the hero number, e.g. "DAY STREAK" or "BENCH PRESS". */
  label: string;
  /** Optional smaller line, e.g. "New personal best!". */
  subtitle?: string;
};

// Logical render size; captured at 3x (1080×1920) for crisp Stories output.
export const CARD_WIDTH = 360;
export const CARD_HEIGHT = 640;

const BRAND_BLUE = '#2E90FA';

export const ShareableStatCard = forwardRef<View, { stat: ShareStat }>(({ stat }, ref) => {
  const isStreak = stat.kind === 'streak';
  return (
    <View ref={ref} collapsable={false} style={styles.card}>
      <LinearGradient
        colors={['#0A0A0F', '#10131C', '#0A0A0F']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Brand glow */}
      <View style={styles.glow} />

      {/* Header wordmark */}
      <View style={styles.header}>
        <Ionicons name="barbell" size={22} color={BRAND_BLUE} />
        <Text style={styles.wordmark}>LiftAI</Text>
      </View>

      {/* Hero */}
      <View style={styles.hero}>
        <View style={styles.iconBadge}>
          <Ionicons
            name={isStreak ? 'flame' : 'trophy'}
            size={44}
            color={isStreak ? '#2E90FA' : '#2E90FA'}
          />
        </View>
        <Text style={styles.value}>{stat.value}</Text>
        <Text style={styles.label}>{stat.label}</Text>
        {stat.subtitle ? <Text style={styles.subtitle}>{stat.subtitle}</Text> : null}
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <View style={styles.divider} />
        <Text style={styles.footerText}>
          {isStreak ? 'Showing up, every day.' : 'Stronger than yesterday.'}
        </Text>
        <Text style={styles.footerBrand}>Tracked with LiftAI</Text>
      </View>
    </View>
  );
});

ShareableStatCard.displayName = 'ShareableStatCard';

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#0A0A0F',
    paddingHorizontal: 32,
    paddingTop: 40,
    paddingBottom: 36,
    justifyContent: 'space-between',
  },
  glow: {
    position: 'absolute',
    top: -120,
    alignSelf: 'center',
    width: 360,
    height: 360,
    borderRadius: 999,
    backgroundColor: BRAND_BLUE,
    opacity: 0.18,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wordmark: {
    color: '#FFFFFF',
    fontSize: 22,
    fontFamily: 'Montserrat_800ExtraBold',
    letterSpacing: 0.5,
  },
  hero: { alignItems: 'center', gap: 8 },
  iconBadge: {
    width: 88,
    height: 88,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  value: {
    color: BRAND_BLUE,
    fontSize: 92,
    lineHeight: 100,
    fontFamily: 'Montserrat_900Black',
    letterSpacing: -1,
    textAlign: 'center',
  },
  label: {
    color: '#FFFFFF',
    fontSize: 22,
    fontFamily: 'Montserrat_700Bold',
    letterSpacing: 3,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 16,
    fontFamily: 'Montserrat_500Medium',
    marginTop: 12,
    textAlign: 'center',
  },
  footer: { alignItems: 'center', gap: 12 },
  divider: {
    width: 48,
    height: 3,
    borderRadius: 4,
    backgroundColor: BRAND_BLUE,
    marginBottom: 4,
  },
  footerText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 17,
    fontFamily: 'Montserrat_600SemiBold',
    textAlign: 'center',
  },
  footerBrand: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    letterSpacing: 1,
  },
});
