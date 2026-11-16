import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

const COUNT = 200;
const SIZE = 220; // Diameter
const PARTICLE_SIZE = 3;

interface ParticleProps {
    index: number;
    progress: SharedValue<number>;
}

const Particle: React.FC<ParticleProps> = ({ index, progress }) => {
    // Random point on sphere surface or volume
    // Using spherical coordinates
    // Use stable random values based on index to avoid jitter on re-render if it happens
    // Simple pseudo-random based on index
    const random = (seed: number) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const theta = random(index) * 2 * Math.PI; // Azimuth
    const phi = Math.acos(2 * random(index + 1) - 1); // Inclination
    // Distribute mostly on surface but with some depth for "cloud" look
    // Mix of surface (r=1) and volume (r=cbrt(rand))
    const rRandom = random(index + 2);
    const radius = (SIZE / 2) * (0.8 + 0.2 * rRandom);

    // Initial position
    const x0 = radius * Math.sin(phi) * Math.cos(theta);
    const y0 = radius * Math.sin(phi) * Math.sin(theta);
    const z0 = radius * Math.cos(phi);

    const style = useAnimatedStyle(() => {
        // Continuous progress
        const t = progress.value;

        // Rotate around Y axis (and slightly X for tilt)
        // 1 rotation every 1 unit of progress
        const angle = t * 2 * Math.PI;

        // Add subtle in/out movement (breathing/noise)
        // Use index to offset the phase so they don't all move together
        // Match frequency to rotation (2*PI) or a harmonic
        const breathing = Math.sin(t * 2 * Math.PI + index) * 15;
        const currentRadius = radius + breathing;

        // Recalculate positions with dynamic radius
        const scaleFactor = currentRadius / radius;
        const xBase = x0 * scaleFactor;
        const yBase = y0 * scaleFactor;
        const zBase = z0 * scaleFactor;

        let x = xBase * Math.cos(angle) + zBase * Math.sin(angle);
        let z = -xBase * Math.sin(angle) + zBase * Math.cos(angle);
        let y = yBase;

        // Add slight X axis rotation for tilt
        const tilt = 0.2; // radians
        const yNew = y * Math.cos(tilt) - z * Math.sin(tilt);
        const zNew = y * Math.sin(tilt) + z * Math.cos(tilt);
        y = yNew;
        z = zNew;

        // Project to 2D
        const scale = interpolate(z, [-SIZE / 2, SIZE / 2], [0.6, 1.4]);
        const opacity = interpolate(z, [-SIZE / 2, SIZE / 2], [0.3, 1]);

        return {
            transform: [
                { translateX: x },
                { translateY: y },
                { scale },
            ],
            opacity,
        };
    });

    return <Animated.View style={[styles.particle, style]} />;
};

export const CirclePixelAnimation = () => {
    const progress = useSharedValue(0);

    useEffect(() => {
        // Run continuously for a very long time to avoid loop glitches
        // 10000 rotations * 8 seconds = ~22 hours
        progress.value = withTiming(10000, {
            duration: 10000 * 8000,
            easing: Easing.linear,
        });
    }, []);

    // Memoize particles to prevent re-creation
    const particles = React.useMemo(() =>
        Array.from({ length: COUNT }).map((_, i) => (
            <Particle key={i} index={i} progress={progress} />
        )),
        []);

    return (
        <View style={styles.container}>
            {particles}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: SIZE,
        height: SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
    },
    particle: {
        position: 'absolute',
        width: PARTICLE_SIZE,
        height: PARTICLE_SIZE,
        backgroundColor: '#888888', // Grey color
        borderRadius: PARTICLE_SIZE / 2,
    },
});
