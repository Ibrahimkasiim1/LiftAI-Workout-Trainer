/**
 * Edit Week — drag workouts between days.
 *
 * Route: /workout/edit-week
 *
 * Seven fixed day slots (Mon–Sun). The day labels stay put; the workout cards
 * move. Long-press a card and drag it onto another day — rest days are empty
 * slots, so dragging a workout onto a rest day trains that day and the old
 * day becomes rest. Tap a card to fine-tune that day's exercises (Edit Day).
 *
 * Persistence: after a drag settles, every daily_workouts row whose
 * day_of_week changed is updated (no unique constraint on day, so update
 * order doesn't matter). Failures reload from the source of truth.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toast } from '../../components/ui/Toast';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useProGate } from '../../hooks/useProGate';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { supabase } from '../../utils/supabase';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface DayWorkout {
  id: string;
  split_day_name: string;
  exerciseCount: number;
  estimated_time: number | null;
}

/** One list item per weekday slot; `workout` is null on rest days. */
interface WeekSlot {
  key: string;
  workout: DayWorkout | null;
}

export default function EditWeekScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { session, loading: authLoading } = useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Manual editing is Pro-only: viewing the week is free, committing a drag
  // gates (see handleDragEnd).
  const proGate = useProGate();
  const [slots, setSlots] = useState<WeekSlot[]>([]);

  const load = useCallback(async () => {
    if (!session?.user?.id) return;
    setLoading(true);
    try {
      const { data: plan } = await supabase
        .from('workout_plans')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!plan) {
        toast.error('No active plan found');
        router.back();
        return;
      }

      const { data: rows } = await supabase
        .from('daily_workouts')
        .select('id, day_of_week, split_day_name, exercises_structured, estimated_time')
        .eq('plan_id', plan.id);

      const byDay = new Map<string, DayWorkout>();
      for (const row of rows ?? []) {
        byDay.set(String(row.day_of_week).toLowerCase(), {
          id: row.id,
          split_day_name: row.split_day_name || 'Workout',
          exerciseCount: Array.isArray(row.exercises_structured) ? row.exercises_structured.length : 0,
          estimated_time: row.estimated_time ?? null,
        });
      }

      setSlots(
        DAYS.map((day) => ({
          key: day,
          workout: byDay.get(day) ?? null,
        })),
      );
    } catch (e) {
      console.error('edit-week load failed:', e);
      toast.error('Could not load your week');
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id, router]);

  useEffect(() => {
    if (!authLoading && session) load();
  }, [authLoading, session, load]);

  /** After a drag: slot i now owns data[i].workout → day DAYS[i]. */
  const handleDragEnd = useCallback(
    async ({ data }: { data: WeekSlot[] }) => {
      // Manual editing is Pro-only. Not committing the new order makes the
      // list snap back; the contextual paywall explains why.
      if (!proGate.isPro) {
        proGate.showPaywall('manual_edit');
        return;
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const previous = slots;
      setSlots(data);

      // Rows whose day assignment changed.
      const updates: { id: string; day: string }[] = [];
      data.forEach((slot, i) => {
        if (slot.workout) {
          const prevIndex = previous.findIndex((s) => s.workout?.id === slot.workout!.id);
          if (prevIndex !== i) updates.push({ id: slot.workout.id, day: DAYS[i] });
        }
      });
      if (updates.length === 0) return;

      setSaving(true);
      try {
        for (const u of updates) {
          const { error } = await supabase
            .from('daily_workouts')
            .update({ day_of_week: u.day })
            .eq('id', u.id);
          if (error) throw error;
        }
        toast.success('Week updated');
      } catch (e) {
        console.error('edit-week persist failed:', e);
        toast.error("Couldn't save — check your connection");
        void load();
      } finally {
        setSaving(false);
      }
    },
    [slots, load, proGate],
  );

  const renderItem = ({ item, drag, isActive, getIndex }: RenderItemParams<WeekSlot>) => {
    const index = getIndex() ?? 0;
    const dayLabel = DAY_LABELS[index] ?? '';
    const w = item.workout;
    return (
      <View style={styles.slotRow}>
        {/* Fixed day label — labels never move, cards do. */}
        <Text style={[styles.dayLabel, { color: colors.textMuted }]}>{dayLabel.slice(0, 3)}</Text>

        {w ? (
          <TouchableOpacity
            style={[
              styles.workoutCard,
              { backgroundColor: colors.backgroundSecondary, borderColor: isActive ? colors.primary : colors.border },
            ]}
            onLongPress={drag}
            delayLongPress={180}
            onPress={() => router.push({ pathname: '/workout/edit-day', params: { dayOfWeek: DAYS[index] } } as any)}
            activeOpacity={0.8}
          >
            <Ionicons name="reorder-three-outline" size={18} color={colors.textMuted} />
            <View style={styles.cardText}>
              <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
                {w.split_day_name}
              </Text>
              <Text style={[styles.cardMeta, { color: colors.textMuted }]}>
                {w.exerciseCount} exercises{w.estimated_time ? ` · ${w.estimated_time} min` : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.restCard, { borderColor: colors.border }]}
            onPress={() => router.push({ pathname: '/workout/edit-day', params: { dayOfWeek: DAYS[index] } } as any)}
            activeOpacity={0.7}
          >
            <Ionicons name="bed-outline" size={15} color={colors.textMuted} />
            <Text style={[styles.restText, { color: colors.textMuted }]}>Rest — tap to add a workout</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  if (authLoading || loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Edit Week</Text>
            <Text style={[styles.headerSubtitle, { color: colors.textMuted }]}>
              Hold & drag a workout onto any day{saving ? '  ·  Saving…' : ''}
            </Text>
          </View>
        </View>

        <DraggableFlatList
          data={slots}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          onDragEnd={handleDragEnd}
          containerStyle={{ flex: 1 }}
          contentContainerStyle={styles.listContent}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 8,
  },
  backBtn: { padding: 4 },
  headerText: { flex: 1 },
  headerTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 19 },
  headerSubtitle: { fontFamily: 'Montserrat_500Medium', fontSize: 12, marginTop: 2 },

  listContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40 },

  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  dayLabel: {
    width: 38,
    fontFamily: 'Montserrat_700Bold',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  workoutCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  cardText: { flex: 1, gap: 2 },
  cardTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 14 },
  cardMeta: { fontFamily: 'Montserrat_500Medium', fontSize: 11 },
  restCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingVertical: 14,
  },
  restText: { fontFamily: 'Montserrat_500Medium', fontSize: 12 },
});
