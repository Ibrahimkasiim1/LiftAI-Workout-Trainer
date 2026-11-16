// components/ui/EmptyState.tsx
//
// Standard empty state, paywall icon treatment: icon in a blue-tinted
// circle on a soft glow, one-line headline, muted sub, optional CTA.
// Replaces the ad-hoc empty states across progress / saved / nutrition.

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import Glow from './Glow';

interface EmptyStateProps {
    icon: keyof typeof Ionicons.glyphMap;
    headline: string;
    sub?: string;
    /** Optional CTA — monochrome button per the design system. */
    actionLabel?: string;
    onAction?: () => void;
    style?: ViewStyle;
}

export default function EmptyState({
    icon,
    headline,
    sub,
    actionLabel,
    onAction,
    style,
}: EmptyStateProps) {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    return (
        <View style={[styles.wrap, style]}>
            <View style={styles.iconStage}>
                <Glow size={200} opacity={isDark ? 0.3 : 0.14} />
                <View
                    style={[
                        styles.iconCircle,
                        {
                            backgroundColor: isDark ? 'rgba(46,144,250,0.13)' : 'rgba(46,144,250,0.10)',
                            borderColor: isDark ? 'rgba(46,144,250,0.30)' : 'rgba(46,144,250,0.28)',
                        },
                    ]}
                >
                    <Ionicons name={icon} size={28} color={colors.primary} />
                </View>
            </View>
            <Text style={[styles.headline, { color: colors.text }]}>{headline}</Text>
            {sub ? <Text style={[styles.sub, { color: colors.textMuted }]}>{sub}</Text> : null}
            {actionLabel && onAction ? (
                <TouchableOpacity
                    style={[styles.cta, { backgroundColor: colors.text }]}
                    onPress={onAction}
                    activeOpacity={0.85}
                >
                    <Text style={[styles.ctaText, { color: colors.textInverse }]}>{actionLabel}</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        alignItems: 'center',
        paddingHorizontal: 32,
        paddingVertical: 36,
    },
    iconStage: {
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    iconCircle: {
        width: 64,
        height: 64,
        borderRadius: 999,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headline: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 17,
        textAlign: 'center',
    },
    sub: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        lineHeight: 19,
        textAlign: 'center',
        marginTop: 6,
        maxWidth: 280,
    },
    cta: {
        marginTop: 18,
        borderRadius: 16,
        paddingVertical: 13,
        paddingHorizontal: 28,
    },
    ctaText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 14,
    },
});
