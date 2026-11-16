// components/ui/StatChip.tsx
//
// Compact stat pill: bold value over a muted label inside a hairline-bordered
// rounded chip — the macro-chip pattern from the ConversionPaywall slides,
// promoted for app-wide use (nutrition totals, progress stats, workout
// summaries).
//
// Theme-aware. `accent` switches to the blue-tinted variant used for the
// highlighted stat (use sparingly — blue marks selection/emphasis, per the
// design system).

import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

interface StatChipProps {
    /** The big number, e.g. "412" or "24g". */
    value: string;
    /** The muted label under it, e.g. "cal" or "protein". */
    label: string;
    /** Blue-tinted emphasis variant. */
    accent?: boolean;
    style?: ViewStyle;
}

export default function StatChip({ value, label, accent = false, style }: StatChipProps) {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    const tintedBg = isDark ? 'rgba(46,144,250,0.10)' : 'rgba(46,144,250,0.08)';
    const tintedBorder = isDark ? 'rgba(46,144,250,0.28)' : 'rgba(46,144,250,0.32)';

    return (
        <View
            style={[
                styles.chip,
                {
                    backgroundColor: accent ? tintedBg : colors.backgroundSecondary,
                    borderColor: accent ? tintedBorder : colors.border,
                },
                style,
            ]}
        >
            <Text style={[styles.value, { color: colors.text }]} numberOfLines={1}>
                {value}
            </Text>
            <Text style={[styles.label, { color: colors.textMuted }]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    chip: {
        flex: 1,
        alignItems: 'center',
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 8,
        paddingHorizontal: 6,
    },
    value: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 13,
    },
    label: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 10,
        marginTop: 1,
    },
});
