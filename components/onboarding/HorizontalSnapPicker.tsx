import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    FlatList,
    ListRenderItemInfo,
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native';
import Animated, {
    Extrapolation,
    interpolate,
    runOnJS,
    SharedValue,
    useAnimatedReaction,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<number>);
const DEFAULT_ITEM_WIDTH = 76;

type HorizontalSnapPickerProps = {
    min: number;
    max: number;
    initialValue: number;
    onValueChange: (value: number) => void;
    itemWidth?: number;
};

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function HorizontalItem({
    value,
    index,
    itemWidth,
    textFontSize,
    textLineHeight,
    scrollX,
}: {
    value: number;
    index: number;
    itemWidth: number;
    textFontSize: number;
    textLineHeight: number;
    scrollX: SharedValue<number>;
}) {
    const animatedTextStyle = useAnimatedStyle(() => {
        const centerX = index * itemWidth;
        const inputRange = [centerX - itemWidth, centerX, centerX + itemWidth];
        const scale = interpolate(scrollX.value, inputRange, [0.66, 1.12, 0.66], Extrapolation.CLAMP);
        const opacity = interpolate(scrollX.value, inputRange, [0.28, 1, 0.28], Extrapolation.CLAMP);

        return {
            opacity,
            transform: [{ scale }],
        };
    }, [index, itemWidth, scrollX]);

    return (
        <View style={[styles.itemContainer, { width: itemWidth }]}>
            <Animated.Text
                style={[
                    styles.itemText,
                    { fontSize: textFontSize, lineHeight: textLineHeight },
                    animatedTextStyle,
                ]}
                numberOfLines={1}
                ellipsizeMode="clip"
                allowFontScaling={false}
            >
                {value}
            </Animated.Text>
        </View>
    );
}

export function HorizontalSnapPicker({
    min,
    max,
    initialValue,
    onValueChange,
    itemWidth = DEFAULT_ITEM_WIDTH,
}: HorizontalSnapPickerProps) {
    const { width: windowWidth } = useWindowDimensions();
    const listRef = useRef<FlatList<number>>(null);
    const scrollX = useSharedValue(0);
    const lastEmittedValueRef = useRef<number | null>(null);

    const values = useMemo(
        () => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i),
        [max, min]
    );

    const textFontSize = Math.max(34, Math.min(48, Math.floor(windowWidth * 0.13)));
    const minWidthForFont = Math.ceil(textFontSize * 2.45);
    const effectiveItemWidth = Math.max(itemWidth, minWidthForFont, Math.floor(windowWidth * 0.24));
    const textLineHeight = textFontSize + 8;
    const sidePadding = Math.max(0, windowWidth / 2 - effectiveItemWidth / 2);
    const clampedInitial = clamp(initialValue, min, max);
    const initialIndex = Math.max(0, values.indexOf(clampedInitial));

    const emitValue = useCallback(
        (rawIndex: number) => {
            const index = clamp(rawIndex, 0, values.length - 1);
            const next = values[index];
            if (next === undefined || lastEmittedValueRef.current === next) return;
            lastEmittedValueRef.current = next;
            onValueChange(next);
        },
        [values, onValueChange]
    );

    useEffect(() => {
        if (!values.length) return;
        // If the parent is just echoing back the value we emitted, don't
        // re-scroll — yanking the settled list is what made snaps feel jerky.
        if (lastEmittedValueRef.current === values[initialIndex]) return;
        const offset = initialIndex * effectiveItemWidth;
        scrollX.value = offset;
        requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset, animated: false });
        });
        emitValue(initialIndex);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveItemWidth, initialIndex, values.length]);

    const onScroll = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollX.value = event.contentOffset.x;
        },
    });

    // Subtle tick haptics while scrolling, throttled so fast flings don't
    // flood the JS thread (which itself causes stutter).
    const lastHapticTsRef = useRef(0);
    const tickHaptic = useCallback(() => {
        const now = Date.now();
        if (now - lastHapticTsRef.current < 45) return;
        lastHapticTsRef.current = now;
        Haptics.selectionAsync().catch(() => {});
    }, []);

    useAnimatedReaction(
        () => Math.round(scrollX.value / effectiveItemWidth),
        (current, previous) => {
            if (previous !== null && current !== previous) {
                runOnJS(tickHaptic)();
            }
        },
        [effectiveItemWidth]
    );

    const onMomentumScrollEnd = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const index = Math.round(event.nativeEvent.contentOffset.x / effectiveItemWidth);
            emitValue(index);
        },
        [effectiveItemWidth, emitValue]
    );

    const onScrollEndDrag = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const velocity = event.nativeEvent.velocity?.x ?? 0;
            if (Math.abs(velocity) < 0.05) {
                const index = Math.round(event.nativeEvent.contentOffset.x / effectiveItemWidth);
                emitValue(index);
            }
        },
        [effectiveItemWidth, emitValue]
    );

    const renderItem = ({ item, index }: ListRenderItemInfo<number>) => (
        <HorizontalItem
            value={item}
            index={index}
            itemWidth={effectiveItemWidth}
            textFontSize={textFontSize}
            textLineHeight={textLineHeight}
            scrollX={scrollX}
        />
    );

    return (
        <View style={[styles.container, { width: windowWidth }]}>
            <AnimatedFlatList
                ref={listRef}
                horizontal
                data={values}
                keyExtractor={(item) => String(item)}
                renderItem={renderItem}
                showsHorizontalScrollIndicator={false}
                snapToInterval={effectiveItemWidth}
                // With manual centering padding, snap offsets are exact multiples
                // of itemWidth — that's "start" alignment. "center" makes iOS
                // shift snap points by the (non-multiple) padding, so the wheel
                // settled off-center and then visibly corrected itself.
                snapToAlignment="start"
                decelerationRate="fast"
                bounces={false}
                onScroll={onScroll}
                onMomentumScrollEnd={onMomentumScrollEnd}
                onScrollEndDrag={onScrollEndDrag}
                scrollEventThrottle={16}
                contentContainerStyle={{ paddingHorizontal: sidePadding }}
                getItemLayout={(_, index) => ({
                    length: effectiveItemWidth,
                    offset: effectiveItemWidth * index,
                    index,
                })}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        alignSelf: 'center',
        justifyContent: 'center',
        minHeight: 168,
    },
    itemContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
    },
    itemText: {
        color: '#FFFFFF',
        fontFamily: 'Montserrat_700Bold',
        textAlign: 'center',
        fontVariant: ['tabular-nums'],
        includeFontPadding: false,
    },
});
