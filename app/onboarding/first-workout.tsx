/**
 * First-Workout Moment — the screen between "Start This Plan" and the app.
 *
 * Puts new users one tap from actually training ("your first workout takes
 * ~35 min — start now") instead of landing them on the home dashboard.
 *
 * Paths out:
 *   - "Start my first workout" → straight into the workout player (main_plan).
 *   - "Remind me later today"  → schedules a +4h local push; if notification
 *     permission was never requested, routes through notification-setup first
 *     (the reminder request IS the permission context) — else home.
 *
 * Today is guaranteed to be a training day for new users (the day-selection
 * step locks it in), but legacy/edge rows fall back to the first non-empty
 * day of the plan so this screen never dead-ends.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRequireAuth } from '../../hooks/useRequireAuth';
import { posthog } from '../../src/config/posthog';
import { scheduleFirstWorkoutReminder } from '../../utils/engagementNotifications';
import { writeFunnelSnapshot } from '../../utils/funnelState';
import { hasRequestedNotificationPermission } from '../../utils/userProfile';
import { supabase } from '../../utils/supabase';

const BLUE = '#2E90FA';

interface FirstWorkout {
    name: string;
    estimatedTime: number | null;
    exerciseNames: string[];
    exercisesStructured: any[];
}

function extractWorkout(row: any): FirstWorkout | null {
    const structured = Array.isArray(row?.exercises_structured) ? row.exercises_structured : [];
    if (structured.length === 0) return null;
    return {
        name: row.split_day_name || 'Day 1',
        estimatedTime: typeof row.estimated_time === 'number' ? row.estimated_time : null,
        exerciseNames: structured.map((e: any) => e?.name).filter(Boolean),
        exercisesStructured: structured,
    };
}

export default function FirstWorkoutScreen() {
    const router = useRouter();
    const { session, loading: authLoading } = useRequireAuth();
    const [workout, setWorkout] = useState<FirstWorkout | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (authLoading || !session) return;
        (async () => {
            try {
                posthog.capture('first_workout_screen_viewed');
                const { data: plan } = await supabase
                    .from('workout_plans')
                    .select('id')
                    .eq('user_id', session.user.id)
                    .eq('is_active', true)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (!plan?.id) {
                    setLoading(false);
                    return;
                }

                const { data: days } = await supabase
                    .from('daily_workouts')
                    .select('day_of_week, split_day_name, exercises_structured, estimated_time')
                    .eq('plan_id', plan.id);

                const today = new Date()
                    .toLocaleDateString('en-US', { weekday: 'long' })
                    .toLowerCase();
                const todayRow = (days ?? []).find(
                    (d: any) => String(d.day_of_week).toLowerCase() === today
                );
                const firstAvailable = (days ?? [])
                    .map(extractWorkout)
                    .find((w): w is FirstWorkout => w != null);

                setWorkout((todayRow && extractWorkout(todayRow)) || firstAvailable || null);
            } catch (e) {
                console.warn('first-workout load failed:', e);
            } finally {
                setLoading(false);
            }
        })();
    }, [authLoading, session]);

    const goHome = async () => {
        await writeFunnelSnapshot('main_app', {
            route: '/(tabs)',
            reason: 'first_workout_screen_done',
        });
        router.replace('/(tabs)');
    };

    const handleStartNow = () => {
        if (!workout) return;
        posthog.capture('first_workout_started', {
            source: 'onboarding',
            exercise_count: workout.exerciseNames.length,
        });
        void writeFunnelSnapshot('main_app', {
            route: '/(tabs)',
            reason: 'first_workout_started',
        });
        router.replace({
            pathname: '/workout',
            params: {
                exercises: JSON.stringify(workout.exerciseNames),
                exerciseStructure: JSON.stringify(workout.exercisesStructured),
                exerciseNames: JSON.stringify(workout.exerciseNames),
                workoutName: workout.name,
                estimatedTime: String(workout.estimatedTime ?? 0),
                difficulty: 'personalized',
                workoutType: 'main_plan',
            },
        } as any);
    };

    const handleRemindLater = async () => {
        posthog.capture('first_workout_deferred');
        if (!session) return void goHome();

        const permissionRequested = await hasRequestedNotificationPermission(session.user.id);
        if (!permissionRequested) {
            // The reminder they just asked for IS the permission pitch —
            // notification-setup schedules it after a grant (see param).
            await writeFunnelSnapshot('notification_setup', {
                route: '/onboarding/notification-setup',
                reason: 'first_workout_deferred',
            });
            router.replace({
                pathname: '/onboarding/notification-setup',
                params: { firstWorkoutReminder: '1', estimatedMinutes: String(workout?.estimatedTime ?? '') },
            } as any);
            return;
        }
        await scheduleFirstWorkoutReminder(workout?.estimatedTime ?? null);
        await goHome();
    };

    // No usable workout (shouldn't happen for new users) — never dead-end.
    // Navigating from an effect, not the render body: router.replace during
    // render can fire on every re-render and trip "navigate before mount".
    const noWorkout = !authLoading && !loading && !workout;
    useEffect(() => {
        if (noWorkout) void goHome();
        // goHome is stable for this screen's lifetime; keying on the flag
        // alone guarantees a single replace.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noWorkout]);

    if (authLoading || loading || !workout) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.center}>
                    <ActivityIndicator size="large" color={BLUE} />
                </View>
            </SafeAreaView>
        );
    }

    const previewNames = workout.exerciseNames.slice(0, 3);
    const extraCount = Math.max(0, workout.exerciseNames.length - previewNames.length);

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                <View style={styles.headerBlock}>
                    <View style={styles.dayOnePill}>
                        <Text style={styles.dayOnePillText}>DAY 1</Text>
                    </View>
                    <Text style={styles.title}>Your first workout{'\n'}starts now</Text>
                    <Text style={styles.subtitle}>
                        {workout.estimatedTime
                            ? `About ${workout.estimatedTime} minutes — do it now and day one is done.`
                            : 'Do it now and day one is done.'}
                    </Text>
                </View>

                <View style={styles.workoutCard}>
                    <View style={styles.workoutCardHeader}>
                        <Text style={styles.workoutName}>{workout.name}</Text>
                        <View style={styles.metaRow}>
                            <Ionicons name="barbell-outline" size={13} color="rgba(255,255,255,0.55)" />
                            <Text style={styles.metaText}>
                                {workout.exerciseNames.length} exercises
                                {workout.estimatedTime ? ` · ~${workout.estimatedTime} min` : ''}
                            </Text>
                        </View>
                    </View>
                    {previewNames.map((name) => (
                        <View key={name} style={styles.exerciseRow}>
                            <View style={styles.exerciseDot} />
                            <Text style={styles.exerciseName} numberOfLines={1}>
                                {name}
                            </Text>
                        </View>
                    ))}
                    {extraCount > 0 && <Text style={styles.moreText}>+{extraCount} more</Text>}
                </View>

                <View style={styles.actions}>
                    <TouchableOpacity style={styles.primaryBtn} onPress={handleStartNow} activeOpacity={0.85}>
                        <Ionicons name="play" size={18} color="#000000" />
                        <Text style={styles.primaryBtnText}>Start my first workout</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryBtn} onPress={handleRemindLater} activeOpacity={0.7}>
                        <Text style={styles.secondaryBtnText}>Remind me later today</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 32,
        paddingBottom: 24,
        justifyContent: 'space-between',
    },
    headerBlock: {
        alignItems: 'center',
    },
    dayOnePill: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(46,144,250,0.45)',
        backgroundColor: 'rgba(46,144,250,0.12)',
        paddingVertical: 5,
        paddingHorizontal: 14,
        marginBottom: 18,
    },
    dayOnePillText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 11,
        letterSpacing: 2.5,
        color: '#5AA6FF',
    },
    title: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 30,
        lineHeight: 37,
        color: '#FFFFFF',
        textAlign: 'center',
    },
    subtitle: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 14.5,
        lineHeight: 21,
        color: 'rgba(255,255,255,0.6)',
        textAlign: 'center',
        marginTop: 12,
        paddingHorizontal: 8,
    },
    workoutCard: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderRadius: 16,
        padding: 18,
        gap: 10,
        shadowColor: BLUE,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.25,
        shadowRadius: 24,
        elevation: 8,
    },
    workoutCardHeader: {
        marginBottom: 4,
    },
    workoutName: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 17,
        color: '#FFFFFF',
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 4,
    },
    metaText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 12,
        color: 'rgba(255,255,255,0.55)',
    },
    exerciseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderRadius: 12,
        paddingVertical: 11,
        paddingHorizontal: 12,
    },
    exerciseDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: BLUE,
    },
    exerciseName: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13.5,
        color: 'rgba(255,255,255,0.92)',
        flex: 1,
    },
    moreText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 12,
        color: 'rgba(255,255,255,0.45)',
        textAlign: 'center',
        marginTop: 2,
    },
    actions: {
        gap: 6,
    },
    primaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        paddingVertical: 17,
    },
    primaryBtnText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 16,
        color: '#000000',
    },
    secondaryBtn: {
        alignItems: 'center',
        paddingVertical: 14,
    },
    secondaryBtnText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 14,
        color: 'rgba(255,255,255,0.55)',
    },
});
