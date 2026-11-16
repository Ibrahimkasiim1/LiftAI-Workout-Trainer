import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FlatList,
    ListRenderItemInfo,
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedReaction,
    useAnimatedScrollHandler,
    useSharedValue,
} from 'react-native-reanimated';

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<number>);
const DEFAULT_TICK_HEIGHT = 14;
const DEFAULT_RULER_HEIGHT = 520;

type VerticalRulerPickerProps = {
    min: number;
    max: number;
    initialValue: number;
    unit: string;
    onValueChange: (value: number) => void;
    tickHeight?: number;
    rulerHeight?: number;
    fullScreen?: boolean;
    /** Big readout formatter (e.g. inches → 5'10"). Defaults to the raw number. */
    formatDisplay?: (value: number) => string;
    /** Label next to major ticks. Defaults to the raw number. */
    formatTickLabel?: (value: number) => string;
    /** Major (labeled) tick spacing. Default 10 (use 12 for inches → feet). */
    majorEvery?: number;
    /** Mid-length tick spacing. Default 5 (use 6 for inches). */
    midEvery?: number;
};

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function tickWidthForValue(value: number, majorEvery: number, midEvery: number) {
    if (value % majorEvery === 0) return 54;
    if (value % midEvery === 0) return 34;
    return 22;
}

export function VerticalRulerPicker({
    min,
    max,
    initialValue,
    unit,
    onValueChange,
    tickHeight = DEFAULT_TICK_HEIGHT,
    rulerHeight = DEFAULT_RULER_HEIGHT,
    fullScreen = false,
    formatDisplay,
    formatTickLabel,
    majorEvery = 10,
    midEvery = 5,
}: VerticalRulerPickerProps) {
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const listRef = useRef<FlatList<number>>(null);
    const lastValueRef = useRef<number | null>(null);
    const offsetY = useSharedValue(0);
    const clampedInitial = clamp(initialValue, min, max);
    const [displayValue, setDisplayValue] = useState(clampedInitial);

    const values = useMemo(
        () => Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i),
        [max, min]
    );

    const initialIndex = Math.max(0, values.indexOf(clampedInitial));
    const effectiveRulerHeight = Math.min(rulerHeight, Math.max(300, Math.floor(windowHeight * 0.56)));
    const displayFontSize = Math.max(34, Math.min(44, Math.floor(windowWidth * 0.115)));
    const displayUnitSize = Math.max(18, Math.min(20, Math.floor(displayFontSize * 0.46)));
    const sidePadding = Math.max(0, (effectiveRulerHeight - tickHeight) / 2);

    // Throttle tick haptics: firing one per tick during a fast fling floods the
    // JS thread and the vibration motor, which reads as scroll stutter.
    const lastHapticTsRef = useRef(0);
    const updateDisplay = useCallback(
        (rawIndex: number) => {
            const index = clamp(rawIndex, 0, values.length - 1);
            const next = values[index];
            if (next === undefined) return;
            setDisplayValue(next);
            const now = Date.now();
            if (now - lastHapticTsRef.current >= 45) {
                lastHapticTsRef.current = now;
                Haptics.selectionAsync().catch(() => {});
            }
        },
        [values]
    );

    const commitValue = useCallback(
        (rawIndex: number) => {
            const index = clamp(rawIndex, 0, values.length - 1);
            const next = values[index];
            if (next === undefined || lastValueRef.current === next) return;
            lastValueRef.current = next;
            setDisplayValue(next);
            onValueChange(next);
        },
        [values, onValueChange]
    );

    useEffect(() => {
        if (!values.length) return;
        // Parent echoing back our own committed value — don't yank the list.
        if (lastValueRef.current === values[initialIndex]) return;
        const offset = initialIndex * tickHeight;
        offsetY.value = offset;
        requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset, animated: false });
        });
        lastValueRef.current = values[initialIndex] ?? null;
        setDisplayValue(values[initialIndex] ?? clampedInitial);
        onValueChange(values[initialIndex] ?? clampedInitial);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialIndex, tickHeight, values.length]);

    const trackedIndex = useSharedValue(initialIndex);

    const onScroll = useAnimatedScrollHandler({
        onScroll: (event) => {
            offsetY.value = event.contentOffset.y;
        },
    });

    useAnimatedReaction(
        () => Math.round(offsetY.value / tickHeight),
        (current, previous) => {
            if (current !== previous && current !== trackedIndex.value) {
                trackedIndex.value = current;
                runOnJS(updateDisplay)(current);
            }
        },
        [tickHeight]
    );

    const onMomentumScrollEnd = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const index = Math.round(event.nativeEvent.contentOffset.y / tickHeight);
            commitValue(index);
        },
        [tickHeight, commitValue]
    );

    const onScrollEndDrag = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const velocity = event.nativeEvent.velocity?.y ?? 0;
            if (Math.abs(velocity) < 0.05) {
                const index = Math.round(event.nativeEvent.contentOffset.y / tickHeight);
                commitValue(index);
            }
        },
        [tickHeight, commitValue]
    );

    const renderItem = ({ item }: ListRenderItemInfo<number>) => {
        const width = tickWidthForValue(item, majorEvery, midEvery);
        const majorTick = item % majorEvery === 0;

        return (
            <View style={[styles.tickRow, { height: tickHeight }]}>
                {majorTick ? (
                    <Text style={styles.tickLabel}>
                        {formatTickLabel ? formatTickLabel(item) : item}
                    </Text>
                ) : null}
                <View style={[styles.tickMark, { width }]} />
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <View style={[styles.display, { width: windowWidth - 48 }]}>
                <Text style={[styles.displayValue, { fontSize: displayFontSize, lineHeight: displayFontSize + 8 }]} allowFontScaling={false}>
                    {formatDisplay ? formatDisplay(displayValue) : displayValue}
                    {unit ? (
                        <Text style={[styles.displayUnit, { fontSize: displayUnitSize }]}> {unit}</Text>
                    ) : null}
                </Text>
            </View>

            <View style={[styles.rulerShell, fullScreen && styles.rulerShellFullscreen, { height: effectiveRulerHeight }]}>
                <View pointerEvents="none" style={styles.centerIndicator} />
                <AnimatedFlatList
                    ref={listRef}
                    data={values}
                    keyExtractor={(item) => String(item)}
                    renderItem={renderItem}
                    showsVerticalScrollIndicator={false}
                    snapToInterval={tickHeight}
                    // "start" pairs with the manual centering padding; "center"
                    // shifts iOS snap offsets by the padding remainder, leaving
                    // the ruler resting between ticks before correcting itself.
                    snapToAlignment="start"
                    decelerationRate="fast"
                    bounces={false}
                    onScroll={onScroll}
                    onMomentumScrollEnd={onMomentumScrollEnd}
                    onScrollEndDrag={onScrollEndDrag}
                    scrollEventThrottle={16}
                    contentContainerStyle={{ paddingVertical: sidePadding }}
                    getItemLayout={(_, index) => ({
                        length: tickHeight,
                        offset: tickHeight * index,
                        index,
                    })}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        alignItems: 'center',
    },
    display: {
        alignItems: 'center',
        marginBottom: 8,
    },
    displayValue: {
        color: '#FFFFFF',
        fontFamily: 'Montserrat_700Bold',
    },
    displayUnit: {
        color: 'rgba(255,255,255,0.7)',
        fontFamily: 'Montserrat_500Medium',
    },
    rulerShell: {
        width: '100%',
        backgroundColor: 'transparent',
        overflow: 'hidden',
        justifyContent: 'center',
    },
    rulerShellFullscreen: {
        borderRadius: 4,
    },
    centerIndicator: {
        position: 'absolute',
        left: 18,
        right: 18,
        height: 2,
        borderRadius: 4,
        backgroundColor: 'rgba(46, 144, 250, 0.95)',
        zIndex: 2,
    },
    tickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: 20,
        gap: 12,
    },
    tickLabel: {
        color: 'rgba(255,255,255,0.62)',
        fontSize: 12,
        minWidth: 34,
        textAlign: 'right',
        fontFamily: 'Montserrat_600SemiBold',
    },
    tickMark: {
        height: 2,
        borderRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.92)',
    },
});
