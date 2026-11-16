import * as Haptics from 'expo-haptics';
import React, { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Animated, {
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = {
    selected: boolean;
    onPress: () => void;
    children: ReactNode;
    style?: ViewStyle;
    /** Single-tap choice: light haptic on press */
    hapticOnPress?: boolean;
    /** Non-interactive + dimmed (e.g. a split that doesn't fit the chosen days) */
    disabled?: boolean;
};

export function OnboardingChoiceCard({
    selected,
    onPress,
    children,
    style,
    hapticOnPress = false,
    disabled = false,
}: Props) {
    const progress = useSharedValue(selected ? 1 : 0);

    React.useEffect(() => {
        progress.value = withSpring(selected ? 1 : 0, { damping: 18, stiffness: 220 });
    }, [selected, progress]);

    const animatedCard = useAnimatedStyle(() => {
        const border = interpolateColor(
            progress.value,
            [0, 1],
            ['rgba(255,255,255,0.12)', 'rgba(46, 144, 250, 0.95)']
        );
        const bg = interpolateColor(
            progress.value,
            [0, 1],
            ['rgba(255,255,255,0.05)', 'rgba(46, 144, 250, 0.14)']
        );
        return {
            borderColor: border,
            backgroundColor: bg,
            transform: [{ scale: 0.98 + progress.value * 0.02 }],
        };
    });

    return (
        <AnimatedPressable
            disabled={disabled}
            onPress={() => {
                if (disabled) return;
                if (hapticOnPress) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
                onPress();
            }}
            style={[styles.card, animatedCard, style, disabled && styles.cardDisabled]}
        >
            {children}
        </AnimatedPressable>
    );
}

type RowProps = {
    selected: boolean;
    onPress: () => void;
    title: string;
    subtitle?: string;
    leading?: ReactNode;
    trailing?: ReactNode;
    disabled?: boolean;
    /** Shown in place of the subtitle when disabled, to explain why */
    disabledHint?: string;
};

export function OnboardingListChoiceRow({
    selected,
    onPress,
    title,
    subtitle,
    leading,
    trailing,
    disabled = false,
    disabledHint,
}: RowProps) {
    const effectiveSubtitle = disabled && disabledHint ? disabledHint : subtitle;
    return (
        <OnboardingChoiceCard selected={selected} onPress={onPress} disabled={disabled}>
            <View style={styles.rowInner}>
                {leading}
                <View style={styles.rowTextWrap}>
                    <Text
                        style={[
                            styles.rowTitle,
                            selected && styles.rowTitleSelected,
                        ]}
                    >
                        {title}
                    </Text>
                    {effectiveSubtitle ? (
                        <Text
                            style={[
                                styles.rowSubtitle,
                                selected && styles.rowSubtitleSelected,
                            ]}
                        >
                            {effectiveSubtitle}
                        </Text>
                    ) : null}
                </View>
                {trailing}
            </View>
        </OnboardingChoiceCard>
    );
}

const styles = StyleSheet.create({
    card: {
        borderRadius: 20,
        borderWidth: 1.5,
        paddingVertical: 20,
        paddingHorizontal: 20,
    },
    cardDisabled: { opacity: 0.4 },
    rowInner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    rowTextWrap: { flex: 1 },
    rowTitle: {
        color: '#F2F2F2',
        fontSize: 17,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
    rowTitleSelected: { color: '#FFFFFF' },
    rowSubtitle: {
        color: 'rgba(255,255,255,0.52)',
        fontSize: 14,
        marginTop: 4,
        fontFamily: 'Montserrat_400Regular',
        lineHeight: 20,
    },
    rowSubtitleSelected: { color: 'rgba(255,255,255,0.72)' },
});
