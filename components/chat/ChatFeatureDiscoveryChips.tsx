import * as Haptics from 'expo-haptics';
import React from 'react';
import {
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

export type FeatureDiscoveryItem = {
    id: string;
    label: string;
    prompt: string;
};

/**
 * Ambiguous fill-in-the-blank starters. Tapping a chip inserts the `prompt`
 * stub into the input (it does NOT send) and focuses the field so the user
 * completes the thought — the chip teaches the pattern and shows the app's
 * breadth (build / edit / equipment / log / progress / memory / plan).
 *
 * Each `prompt` ends with a trailing space so the cursor sits ready to type.
 * The label's "…" signals "finish this".
 */
export const FEATURE_DISCOVERY_CHIPS: FeatureDiscoveryItem[] = [
    {
        id: 'build-workout',
        label: 'Build me a workout for…',
        prompt: 'Build me a workout for ',
    },
    {
        id: 'swap-exercise',
        label: 'Swap this exercise for…',
        prompt: 'Swap this exercise for ',
    },
    {
        id: 'only-have',
        label: 'I only have … today',
        prompt: 'I only have ',
    },
    {
        id: 'log',
        label: 'Log…',
        prompt: 'Log ',
    },
    {
        id: 'progress',
        label: "How's my … going?",
        prompt: "How's my ",
    },
    {
        id: 'remember',
        label: 'Remember that I…',
        prompt: 'Remember that I ',
    },
    {
        id: 'make-plan-more',
        label: 'Make my plan more…',
        prompt: 'Make my plan more ',
    },
];

type ThemeColors = {
    text: string;
    textSecondary: string;
    background: string;
    border: string;
};

type Props = {
    colors: ThemeColors;
    isDark: boolean;
    onSelectPrompt: (prompt: string) => void;
    extraChips?: { id: string; label: string; prompt: string }[];
};

export function ChatFeatureDiscoveryChips({
    colors,
    isDark,
    onSelectPrompt,
    extraChips = [],
}: Props) {
    const glassBorder = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';
    const glassBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)';

    const validExtras = extraChips.filter(
        (c) => c.label?.trim().length > 0 && c.prompt?.trim().length > 0
    );

    return (
        <View style={styles.wrap}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                Try asking
            </Text>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.row}
            >
                {FEATURE_DISCOVERY_CHIPS.map((item) => (
                    <TouchableOpacity
                        key={item.id}
                        activeOpacity={0.88}
                        style={[
                            styles.chip,
                            {
                                backgroundColor: glassBg,
                                borderColor: glassBorder,
                            },
                        ]}
                        onPress={() => {
                            if (Platform.OS !== 'web') {
                                void Haptics.impactAsync(
                                    Haptics.ImpactFeedbackStyle.Light
                                );
                            }
                            onSelectPrompt(item.prompt);
                        }}
                    >
                        <Text style={[styles.chipLabel, { color: colors.text }]}>
                            {item.label}
                        </Text>
                    </TouchableOpacity>
                ))}
                {validExtras.map((item) => (
                    <TouchableOpacity
                        key={item.id}
                        activeOpacity={0.88}
                        style={[
                            styles.chip,
                            styles.chipExtra,
                            {
                                backgroundColor: glassBg,
                                borderColor: glassBorder,
                            },
                        ]}
                        onPress={() => {
                            if (Platform.OS !== 'web') {
                                void Haptics.impactAsync(
                                    Haptics.ImpactFeedbackStyle.Light
                                );
                            }
                            onSelectPrompt(item.prompt);
                        }}
                    >
                        <Text style={[styles.chipLabel, { color: colors.text }]}>
                            {item.label.trim()}
                        </Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { marginBottom: 8 },
    sectionLabel: {
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 0.35,
        marginBottom: 8,
        marginLeft: 2,
        fontFamily: 'Montserrat_600SemiBold',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 12,
        gap: 8,
    },
    chip: {
        maxWidth: 220,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 16,
        borderWidth: 1,
    },
    chipExtra: {
        maxWidth: 200,
    },
    chipLabel: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
});
