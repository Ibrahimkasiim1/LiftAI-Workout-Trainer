// components/ProLockBadge.tsx
//
// Small lock + sparkle pill rendered on Pro-gated entry points so free users
// can SEE what's behind the paywall (rather than the feature being hidden).
// Tap is handled by the parent — the badge itself is presentational.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';

interface Props {
  label?: string;
  size?: 'sm' | 'md';
}

export default function ProLockBadge({ label = 'Pro', size = 'sm' }: Props) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const isSm = size === 'sm';

  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: colors.primary,
          paddingHorizontal: isSm ? 6 : 10,
          paddingVertical: isSm ? 2 : 4,
        },
      ]}
    >
      <Ionicons
        name="sparkles"
        size={isSm ? 10 : 13}
        color={colors.textInverse ?? '#000'}
      />
      <Text
        style={[
          styles.label,
          { color: colors.textInverse ?? '#000', fontSize: isSm ? 10 : 12 },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  label: {
    fontFamily: 'Montserrat_700Bold',
    letterSpacing: 0.3,
  },
});
