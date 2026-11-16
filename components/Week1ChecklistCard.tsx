/**
 * Week1ChecklistCard — the guided first week, in place of a feature tour.
 *
 * Three checkable moves, each a taste of a core (Pro-flavored) feature:
 *   1. Do your first workout   → the workout player
 *   2. Ask the coach a question → chat tab
 *   3. Log one meal             → nutrition tab
 *
 * Completion is read from the DB (exercise_performance / chat_messages /
 * nutrition_logs — one row each), so it survives reinstalls and syncs across
 * devices. The card shows for the first 10 days after profile creation and
 * disappears forever once all three are done (or the user dismisses it).
 * Every tap/completion is a PostHog event, so this doubles as the activation
 * funnel chart.
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { posthog } from '../src/config/posthog';
import { supabase } from '../utils/supabase';

const DISMISS_KEY = '@week1_checklist_dismissed_v1';
const SHOW_FOR_DAYS = 10;

interface Props {
    userId: string;
    /** Starts today's workout (home already owns this logic). */
    onStartWorkout: () => void;
}

interface ChecklistState {
    withinWindow: boolean;
    workoutDone: boolean;
    chatDone: boolean;
    mealDone: boolean;
}

async function loadChecklistState(userId: string): Promise<ChecklistState> {
    const [profileRes, setRes, chatRes, mealRes] = await Promise.all([
        supabase.from('user_profiles').select('created_at').eq('id', userId).maybeSingle(),
        supabase.from('exercise_performance').select('id').eq('user_id', userId).limit(1),
        supabase.from('chat_messages').select('id').eq('user_id', userId).limit(1),
        supabase.from('nutrition_logs').select('id').eq('user_id', userId).limit(1),
    ]);

    const createdAt = profileRes.data?.created_at ? new Date(profileRes.data.created_at) : null;
    const withinWindow =
        createdAt != null &&
        Date.now() - createdAt.getTime() < SHOW_FOR_DAYS * 24 * 60 * 60 * 1000;

    return {
        withinWindow,
        workoutDone: (setRes.data?.length ?? 0) > 0,
        chatDone: (chatRes.data?.length ?? 0) > 0,
        mealDone: (mealRes.data?.length ?? 0) > 0,
    };
}

export default function Week1ChecklistCard({ userId, onStartWorkout }: Props) {
    const router = useRouter();
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const [dismissed, setDismissed] = useState<boolean | null>(null);

    useEffect(() => {
        void AsyncStorage.getItem(DISMISS_KEY).then((v) => setDismissed(v === '1'));
    }, []);

    const { data } = useQuery({
        queryKey: ['week1-checklist', userId],
        queryFn: () => loadChecklistState(userId),
        staleTime: 60 * 1000,
        enabled: dismissed === false,
    });

    if (dismissed !== false || !data || !data.withinWindow) return null;

    const items = [
        {
            key: 'workout',
            label: 'Do your first workout',
            done: data.workoutDone,
            icon: 'barbell-outline' as const,
            go: onStartWorkout,
        },
        {
            key: 'chat',
            label: 'Ask your coach a question',
            done: data.chatDone,
            icon: 'chatbubble-ellipses-outline' as const,
            go: () => router.push('/(tabs)/chat'),
        },
        {
            key: 'meal',
            label: 'Log one meal',
            done: data.mealDone,
            icon: 'restaurant-outline' as const,
            go: () => router.push('/(tabs)/nutrition'),
        },
    ];
    const doneCount = items.filter((i) => i.done).length;
    if (doneCount === items.length) return null;

    const dismiss = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        posthog.capture('week1_checklist_dismissed', { done_count: doneCount });
        void AsyncStorage.setItem(DISMISS_KEY, '1');
        setDismissed(true);
    };

    return (
        <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
            <View style={styles.header}>
                <View>
                    <Text style={[styles.title, { color: colors.text }]}>Your first week</Text>
                    <Text style={[styles.subtitle, { color: colors.textMuted }]}>
                        {doneCount} of {items.length} done — this is how the app clicks
                    </Text>
                </View>
                <TouchableOpacity
                    onPress={dismiss}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityLabel="Dismiss the first-week checklist"
                >
                    <Ionicons name="close" size={17} color={colors.textMuted} />
                </TouchableOpacity>
            </View>

            {items.map((item) => (
                <TouchableOpacity
                    key={item.key}
                    style={styles.row}
                    disabled={item.done}
                    activeOpacity={0.7}
                    onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        posthog.capture('week1_checklist_item_tapped', { item: item.key });
                        item.go();
                    }}
                >
                    <Ionicons
                        name={item.done ? 'checkmark-circle' : 'ellipse-outline'}
                        size={20}
                        color={item.done ? '#2E90FA' : colors.textMuted}
                    />
                    <Text
                        style={[
                            styles.rowLabel,
                            { color: item.done ? colors.textMuted : colors.text },
                            item.done && styles.rowLabelDone,
                        ]}
                    >
                        {item.label}
                    </Text>
                    {!item.done && <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />}
                </TouchableOpacity>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        padding: 16,
        marginTop: 12,
        gap: 4,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
    },
    subtitle: {
        fontSize: 12,
        marginTop: 2,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 9,
    },
    rowLabel: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
    },
    rowLabelDone: {
        textDecorationLine: 'line-through',
    },
});
