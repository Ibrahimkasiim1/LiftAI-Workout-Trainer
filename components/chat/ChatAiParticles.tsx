import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

/**
 * The signature LiftAI "AI" mark — three gradient dots in a triangle that float
 * (staggered), with the whole group gently pulsing and rotating. This is the
 * SAME animation used in the chat input box; extracted here so the thinking
 * indicator reuses the exact aesthetic.
 *
 * `size` scales the whole cluster (default matches the input box).
 */
export function ChatAiParticles({ size = 24 }: { size?: number }) {
    const dot1Float = useRef(new Animated.Value(0)).current;
    const dot2Float = useRef(new Animated.Value(0)).current;
    const dot3Float = useRef(new Animated.Value(0)).current;
    const pulseAnim = useRef(new Animated.Value(1)).current;
    const rotateAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const floatLoop = (val: Animated.Value) =>
            Animated.loop(
                Animated.sequence([
                    Animated.timing(val, { toValue: -4, duration: 800, useNativeDriver: true }),
                    Animated.timing(val, { toValue: 0, duration: 800, useNativeDriver: true }),
                ])
            );

        const dot1 = floatLoop(dot1Float);
        dot1.start();
        let dot2: Animated.CompositeAnimation | null = null;
        let dot3: Animated.CompositeAnimation | null = null;
        const t2 = setTimeout(() => {
            dot2 = floatLoop(dot2Float);
            dot2.start();
        }, 266);
        const t3 = setTimeout(() => {
            dot3 = floatLoop(dot3Float);
            dot3.start();
        }, 533);

        const pulse = Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, { toValue: 1.15, duration: 1200, useNativeDriver: true }),
                Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
            ])
        );
        pulse.start();

        const rotate = Animated.loop(
            Animated.timing(rotateAnim, { toValue: 1, duration: 4000, useNativeDriver: true })
        );
        rotate.start();

        return () => {
            dot1.stop();
            dot2?.stop();
            dot3?.stop();
            pulse.stop();
            rotate.stop();
            clearTimeout(t2);
            clearTimeout(t3);
        };
    }, [dot1Float, dot2Float, dot3Float, pulseAnim, rotateAnim]);

    const dot = size * (10 / 24); // dot diameter scales with cluster
    const groupStyle = {
        width: size,
        height: size,
        transform: [
            { scale: pulseAnim },
            { rotate: rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
    };
    const dotBase = {
        position: 'absolute' as const,
        width: dot,
        height: dot,
        borderRadius: dot / 2,
        overflow: 'hidden' as const,
    };
    const gradient = { width: dot, height: dot, borderRadius: dot / 2 };

    return (
        <Animated.View style={[styles.group, groupStyle]}>
            <Animated.View style={[dotBase, { top: 0, left: (size - dot) / 2 }, { transform: [{ translateY: dot1Float }] }]}>
                <LinearGradient colors={['#5AA6FF', '#2E90FA']} style={gradient} />
            </Animated.View>
            <Animated.View style={[dotBase, { bottom: 0, left: 0 }, { transform: [{ translateY: dot2Float }] }]}>
                <LinearGradient colors={['#1A6FE0', '#5AA6FF']} style={gradient} />
            </Animated.View>
            <Animated.View style={[dotBase, { bottom: 0, right: 0 }, { transform: [{ translateY: dot3Float }] }]}>
                <LinearGradient colors={['#2E90FA', '#1A6FE0']} style={gradient} />
            </Animated.View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    group: { position: 'relative' },
});
