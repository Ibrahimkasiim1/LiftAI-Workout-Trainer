import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

interface LoadingBubblesProps {
  size?: number; // overall group size baseline (dot ~ size/3)
}

export default function LoadingBubbles({ size = 24 }: LoadingBubblesProps) {
  const dot1Float = useRef(new Animated.Value(0)).current;
  const dot2Float = useRef(new Animated.Value(0)).current;
  const dot3Float = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(dot1Float, { toValue: -4, duration: 800, useNativeDriver: true }),
        Animated.timing(dot1Float, { toValue: 0, duration: 800, useNativeDriver: true }),
      ])
    ).start();

    setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(dot2Float, { toValue: -4, duration: 800, useNativeDriver: true }),
          Animated.timing(dot2Float, { toValue: 0, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    }, 266);

    setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(dot3Float, { toValue: -4, duration: 800, useNativeDriver: true }),
          Animated.timing(dot3Float, { toValue: 0, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    }, 533);

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    ).start();

    Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 4000, useNativeDriver: true })
    ).start();
  }, []);

  const rotateStyle = {
    transform: [
      { scale: pulseAnim },
      {
        rotate: rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
      },
    ],
  } as any;

  const dot1Style = { transform: [{ translateY: dot1Float }] } as any;
  const dot2Style = { transform: [{ translateY: dot2Float }] } as any;
  const dot3Style = { transform: [{ translateY: dot3Float }] } as any;

  const dotSize = Math.max(6, Math.round(size / 3));
  const containerSize = size;

  return (
    <View style={styles.loadingContainer}>
      <Animated.View style={[{ width: containerSize, height: containerSize, position: 'relative' }, rotateStyle]}>
        <Animated.View style={[{ position: 'absolute', width: dotSize, height: dotSize, borderRadius: dotSize / 2, top: 0, left: (containerSize - dotSize) / 2, overflow: 'hidden' }, dot1Style]}>
          <LinearGradient colors={['#5AA6FF', '#2E90FA']} style={{ width: '100%', height: '100%', borderRadius: dotSize / 2 }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', width: dotSize, height: dotSize, borderRadius: dotSize / 2, bottom: 0, left: 0, overflow: 'hidden' }, dot2Style]}>
          <LinearGradient colors={['#1A6FE0', '#5AA6FF']} style={{ width: '100%', height: '100%', borderRadius: dotSize / 2 }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', width: dotSize, height: dotSize, borderRadius: dotSize / 2, bottom: 0, right: 0, overflow: 'hidden' }, dot3Style]}>
          <LinearGradient colors={['#2E90FA', '#1A6FE0']} style={{ width: '100%', height: '100%', borderRadius: dotSize / 2 }} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
});

