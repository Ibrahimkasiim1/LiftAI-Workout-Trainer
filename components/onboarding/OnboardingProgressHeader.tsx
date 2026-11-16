import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

type Props = {
    /** 0–100 */
    progressPercent: number;
    currentIndex: number;
    totalSteps: number;
    subtitle?: string;
};

export function OnboardingProgressHeader({
    progressPercent,
    currentIndex,
    totalSteps,
    subtitle,
}: Props) {
    const widthPct = useSharedValue(progressPercent);

    useEffect(() => {
        widthPct.value = withTiming(progressPercent, { duration: 420 });
    }, [progressPercent, widthPct]);

    const barStyle = useAnimatedStyle(() => ({
        width: `${widthPct.value}%`,
    }));

    return (
        <View style={styles.wrap}>
            <View style={styles.metaRow}>
                <Text style={styles.stepLabel}>
                    Step {currentIndex} of {totalSteps}
                </Text>
                {subtitle ? <Text style={styles.hint}>{subtitle}</Text> : null}
            </View>
            <View style={styles.track}>
                <Animated.View style={[styles.fill, barStyle]} />
            </View>
            <View style={styles.dots}>
                {Array.from({ length: totalSteps }, (_, i) => {
                    const completed = i < currentIndex - 1;
                    const active = i === currentIndex - 1;
                    return (
                        <View
                            key={i}
                            style={[
                                styles.dot,
                                completed && styles.dotFilled,
                                active && styles.dotActive,
                            ]}
                        />
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        paddingHorizontal: 24,
        paddingTop: 8,
        paddingBottom: 16,
    },
    metaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 12,
    },
    stepLabel: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 13,
        fontFamily: 'Montserrat_600SemiBold',
        letterSpacing: 0.3,
    },
    hint: {
        color: 'rgba(255,255,255,0.38)',
        fontSize: 12,
        fontFamily: 'Montserrat_500Medium',
    },
    track: {
        height: 5,
        borderRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
    },
    fill: {
        height: '100%',
        borderRadius: 4,
        backgroundColor: '#2E90FA',
    },
    dots: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        marginTop: 12,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.15)',
    },
    dotFilled: {
        backgroundColor: 'rgba(46, 144, 250, 0.45)',
    },
    dotActive: {
        backgroundColor: '#2E90FA',
        transform: [{ scale: 1.15 }],
    },
});
