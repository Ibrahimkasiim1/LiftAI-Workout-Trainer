/**
 * QuotaPill — the visible free-tier allowance counter ("2 of 3 coach
 * messages left today"). Scarcity only converts when it's countable: this
 * sits directly next to the gated feature so free users always know where
 * they stand, and the zero state names the reset time + one-tap upgrade.
 *
 * Render only for free users (caller checks tier) — premium sees nothing.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { formatResetClock } from '../utils/quotaReset';

interface Props {
    /** Uses left today (0 when exhausted). */
    remaining: number;
    /** The daily allowance for this feature. */
    limit: number;
    /** Feature noun, e.g. "coach messages" / "AI meal log". */
    noun: string;
    /** When the allowance comes back (local midnight). */
    resetAt: Date;
    /** Open the paywall (zero state only). */
    onUpgrade: () => void;
    isDark: boolean;
}

export default function QuotaPill({ remaining, limit, noun, resetAt, onUpgrade, isDark }: Props) {
    const exhausted = remaining <= 0;
    const mutedText = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,36,0.55)';
    const pillBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,36,0.05)';

    if (!exhausted) {
        return (
            <View style={[styles.pill, { backgroundColor: pillBg }]}>
                <Ionicons name="sparkles" size={11} color="#2E90FA" />
                <Text style={[styles.pillText, { color: mutedText }]}>
                    {remaining} of {limit} free {noun} left today
                </Text>
            </View>
        );
    }

    return (
        <TouchableOpacity
            style={[styles.pill, { backgroundColor: pillBg }]}
            onPress={onUpgrade}
            activeOpacity={0.8}
            accessibilityLabel={`Out of free ${noun} for today. Upgrade to Pro for unlimited.`}
        >
            <Ionicons name="time-outline" size={11} color={mutedText} />
            <Text style={[styles.pillText, { color: mutedText }]}>
                Out of free {noun} · back at {formatResetClock(resetAt)} ·
            </Text>
            <Text style={styles.upgradeText}> Go unlimited</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        gap: 5,
        borderRadius: 999,
        paddingVertical: 5,
        paddingHorizontal: 12,
    },
    pillText: {
        fontSize: 12,
        fontWeight: '500',
    },
    upgradeText: {
        fontSize: 12,
        fontWeight: '700',
        color: '#2E90FA',
    },
});
