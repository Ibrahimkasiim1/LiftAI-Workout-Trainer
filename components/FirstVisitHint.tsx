/**
 * FirstVisitHint — one contextual tooltip the first time a tab is opened.
 *
 * Replaces the swipe-through feature tour: one sentence, at the moment the
 * user is actually looking at the feature, dismissed forever with one tap
 * (or automatically the next visit — the flag writes on first render).
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../context/ThemeContext';
import { posthog } from '../src/config/posthog';

interface Props {
    /** Stable key per surface, e.g. "chat" | "nutrition" | "progress" | "saved". */
    hintKey: string;
    text: string;
    /**
     * 'auto' follows the app theme. 'light' forces the light palette — for
     * surfaces that stay light regardless of theme (the workout player).
     */
    appearance?: 'auto' | 'light';
}

// Module-level seen cache: a hint key resolves at most one AsyncStorage read
// per app session. Hosts that mount the hint repeatedly (the workout player
// re-mounts it every work phase) must not re-hit the bridge for a flag that
// can never un-set.
const seenCache = new Set<string>();

export default function FirstVisitHint({ hintKey, text, appearance = 'auto' }: Props) {
    const { isDark: themeIsDark } = useTheme();
    const isDark = appearance === 'light' ? false : themeIsDark;
    const [visible, setVisible] = useState(false);
    const storageKey = `@first_visit_hint_${hintKey}_v1`;

    useEffect(() => {
        if (seenCache.has(storageKey)) return;
        let mounted = true;
        void AsyncStorage.getItem(storageKey).then((seen) => {
            if (seen) {
                seenCache.add(storageKey);
                return;
            }
            if (!mounted) return;
            seenCache.add(storageKey);
            setVisible(true);
            posthog.capture('first_visit_hint_shown', { hint: hintKey });
            // Mark immediately: the hint shows once, ever, even if not tapped.
            void AsyncStorage.setItem(storageKey, '1');
        });
        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    if (!visible) return null;

    return (
        <View
            style={[
                styles.banner,
                {
                    backgroundColor: isDark ? 'rgba(46,144,250,0.12)' : 'rgba(46,144,250,0.08)',
                    borderColor: isDark ? 'rgba(46,144,250,0.35)' : 'rgba(46,144,250,0.25)',
                },
            ]}
        >
            <Ionicons name="bulb-outline" size={15} color="#2E90FA" style={styles.icon} />
            <Text style={[styles.text, { color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,36,0.8)' }]}>
                {text}
            </Text>
            <TouchableOpacity
                onPress={() => setVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Dismiss hint"
            >
                <Ionicons name="close" size={15} color={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,36,0.45)'} />
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 12,
        borderWidth: 1,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    icon: {
        flexShrink: 0,
    },
    text: {
        flex: 1,
        fontSize: 12.5,
        lineHeight: 17,
        fontWeight: '500',
    },
});
