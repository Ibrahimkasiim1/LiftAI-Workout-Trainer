/**
 * FlatList-based wheel picker with snap-to-interval, fast deceleration, and haptics.
 */
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    FlatList,
    ListRenderItemInfo,
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleSheet,
    Text,
    View,
} from 'react-native';

const DEFAULT_ITEM_HEIGHT = 52;
const DEFAULT_WHEEL_HEIGHT = 220;

export type SnappingWheelPickerProps = {
    items: number[];
    value: number;
    onSelect: (v: number) => void;
    label: string;
    /** Optional display formatter (e.g. month names). */
    formatLabel?: (item: number) => string;
    width?: number;
    itemHeight?: number;
    wheelHeight?: number;
    theme?: 'dark' | 'light';
};

export function SnappingWheelPicker({
    items,
    value,
    onSelect,
    label,
    formatLabel,
    width = 88,
    itemHeight = DEFAULT_ITEM_HEIGHT,
    wheelHeight = DEFAULT_WHEEL_HEIGHT,
    theme = 'dark',
}: SnappingWheelPickerProps) {
    const listRef = useRef<FlatList<number>>(null);
    const lastCommittedValueRef = useRef<number | null>(null);
    const lastHapticTsRef = useRef(0);
    const paddingY = Math.max(0, (wheelHeight - itemHeight) / 2);

    const indexOfValue = useCallback(() => {
        const i = items.indexOf(value);
        return i >= 0 ? i : 0;
    }, [items, value]);

    // Index under the selection band right now (updates live while scrolling),
    // so the highlight tracks the finger instead of snapping in after release.
    const [liveIndex, setLiveIndex] = useState(indexOfValue);

    useEffect(() => {
        // Parent echoing back the value we just committed — don't yank the list.
        if (lastCommittedValueRef.current === value) return;
        const idx = indexOfValue();
        const offset = idx * itemHeight;
        requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset, animated: false });
        });
        lastCommittedValueRef.current = value;
        setLiveIndex(idx);
    }, [value, items, itemHeight, indexOfValue]);

    const onScroll = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const idx = Math.max(
                0,
                Math.min(items.length - 1, Math.round(e.nativeEvent.contentOffset.y / itemHeight))
            );
            setLiveIndex((prev) => {
                if (prev === idx) return prev;
                const now = Date.now();
                if (now - lastHapticTsRef.current >= 45) {
                    lastHapticTsRef.current = now;
                    Haptics.selectionAsync().catch(() => {});
                }
                return idx;
            });
        },
        [itemHeight, items.length]
    );

    const commitIndex = useCallback(
        (rawIndex: number) => {
            const clamped = Math.max(0, Math.min(rawIndex, items.length - 1));
            const selected = items[clamped];
            if (selected === undefined) return;
            lastCommittedValueRef.current = selected;
            setLiveIndex(clamped);
            onSelect(selected);
        },
        [items, onSelect]
    );

    const onMomentumScrollEnd = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const idx = Math.round(e.nativeEvent.contentOffset.y / itemHeight);
            commitIndex(idx);
        },
        [itemHeight, commitIndex]
    );

    const onScrollEndDrag = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const velocity = e.nativeEvent.velocity?.y ?? 0;
            if (Math.abs(velocity) < 0.05) {
                const idx = Math.round(e.nativeEvent.contentOffset.y / itemHeight);
                commitIndex(idx);
            }
        },
        [itemHeight, commitIndex]
    );

    const renderItem = useCallback(
        ({ item, index }: ListRenderItemInfo<number>) => {
            const display = formatLabel ? formatLabel(item) : String(item);
            const selected = index === liveIndex;
            return (
                <View style={[styles.itemRow, { height: itemHeight, width }]}>
                    <Text
                        style={[
                            styles.itemText,
                            theme === 'light' && styles.itemTextLight,
                            selected && styles.itemTextSelected,
                            selected && theme === 'light' && styles.itemTextSelectedLight,
                        ]}
                        numberOfLines={1}
                    >
                        {display}
                    </Text>
                </View>
            );
        },
        [formatLabel, itemHeight, liveIndex, theme, width]
    );

    const getItemLayout = useCallback(
        (_: unknown, index: number) => ({
            length: itemHeight,
            offset: itemHeight * index,
            index,
        }),
        [itemHeight]
    );

    return (
        <View style={[styles.column, { width }]}>
            <Text style={[styles.label, theme === 'light' && styles.labelLight]}>{label}</Text>
            <View style={[styles.window, theme === 'light' && styles.windowLight, { height: wheelHeight, width }]}>
                <View
                    pointerEvents="none"
                    style={[
                        styles.selectionBand,
                        theme === 'light' && styles.selectionBandLight,
                        {
                            top: paddingY,
                            height: itemHeight,
                        },
                    ]}
                />
                <FlatList
                    ref={listRef}
                    data={items}
                    keyExtractor={(n) => String(n)}
                    renderItem={renderItem}
                    showsVerticalScrollIndicator={false}
                    snapToInterval={itemHeight}
                    snapToAlignment="start"
                    decelerationRate="fast"
                    bounces={false}
                    onScroll={onScroll}
                    onMomentumScrollEnd={onMomentumScrollEnd}
                    onScrollEndDrag={onScrollEndDrag}
                    scrollEventThrottle={16}
                    getItemLayout={getItemLayout}
                    contentContainerStyle={{ paddingVertical: paddingY }}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    column: { alignItems: 'center' },
    label: {
        color: 'rgba(255,255,255,0.45)',
        fontSize: 11,
        fontWeight: '700',
        marginBottom: 12,
        letterSpacing: 1.2,
        fontFamily: 'Montserrat_700Bold',
    },
    labelLight: {
        color: '#8D8D8D',
    },
    window: {
        overflow: 'hidden',
        position: 'relative',
        borderRadius: 16,
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    windowLight: {
        backgroundColor: '#F7F7F7',
        borderColor: '#E5E5E5',
    },
    selectionBand: {
        position: 'absolute',
        left: 0,
        right: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(46, 144, 250, 0.45)',
        zIndex: 1,
    },
    selectionBandLight: {
        borderColor: 'rgba(46, 144, 250, 0.35)',
    },
    itemRow: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    itemText: {
        color: 'rgba(255,255,255,0.28)',
        fontSize: 17,
        fontFamily: 'Montserrat_500Medium',
    },
    itemTextLight: {
        color: '#A6A6A6',
    },
    itemTextSelected: {
        color: '#FFFFFF',
        fontSize: 21,
        fontFamily: 'Montserrat_700Bold',
    },
    itemTextSelectedLight: {
        color: '#0F0F0F',
    },
});
