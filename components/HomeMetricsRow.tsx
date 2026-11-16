/**
 * Home Metrics Row — at-a-glance stats on the Home tab.
 *
 * Components (top to bottom):
 *   1. Streak milestone callout (only when current streak ties/breaks personal best)
 *   2. Macros pill + Weight trend card  (side-by-side)
 *   3. Goal weight journey bar (only when user has a goal weight different from current)
 *   4. 7-day calorie bar chart
 *
 * All cards are tappable and use actionable empty states rather than dashes.
 * Tapping the weight card opens an inline LogWeightSheet so users can log
 * weight without leaving Home.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import LogWeightSheet from './LogWeightSheet';
import StatShareButton from './StatShareButton';
import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { calculateStreak } from '../src/services/ProgressService';
import { useNutritionGoals } from '../stores/useNutritionGoals';
import { supabase } from '../utils/supabase';
import { getUserProfile } from '../utils/userProfile';
import { getWeightUnit } from '../utils/weightConverter';

type WeightPoint = { weight_kg: number; logged_at: string };
type DailyCalories = { date: string; calories: number };

interface HomeMetricsRowProps {
  userId: string;
}

const KG_TO_LBS = 2.20462;

const localDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const HomeMetricsRow: React.FC<HomeMetricsRowProps> = ({ userId }) => {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const router = useRouter();
  const { calorieGoal, loadGoalsForUser } = useNutritionGoals();

  // Ensure the calorie ring uses the user's personalized goal even if they open
  // Home before visiting the Nutrition tab.
  useEffect(() => {
    if (userId) void loadGoalsForUser(userId);
  }, [userId, loadGoalsForUser]);

  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [calories, setCalories] = useState(0);
  const [weeklyCalories, setWeeklyCalories] = useState<DailyCalories[]>([]);
  const [weightPoints, setWeightPoints] = useState<WeightPoint[]>([]);
  const [profileWeightKg, setProfileWeightKg] = useState<number | null>(null);
  const [goalWeightKg, setGoalWeightKg] = useState<number | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('kg');
  const [loading, setLoading] = useState(true);
  const [logSheetOpen, setLogSheetOpen] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const today = new Date();
      const todayKey = localDateStr(today);
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - 6);
      const weekStartKey = localDateStr(weekStart);
      const weightSince = new Date(today);
      weightSince.setDate(weightSince.getDate() - 90);

      const [streakRes, weekCalRes, weightRes, unit, profileRes] = await Promise.all([
        calculateStreak(userId),
        supabase
          .from('nutrition_logs')
          .select('date, calories')
          .eq('user_id', userId)
          .gte('date', weekStartKey)
          .lte('date', todayKey),
        (supabase as any)
          .from('body_weight_logs')
          .select('weight_kg, logged_at')
          .eq('user_id', userId)
          .gte('logged_at', weightSince.toISOString())
          .order('logged_at', { ascending: true })
          .limit(60),
        getWeightUnit(),
        getUserProfile(userId),
      ]);

      setStreak({
        current: streakRes.streak.currentStreak,
        longest: streakRes.streak.longestStreak,
      });

      // Aggregate weekly calories — fill in missing days with 0.
      const calByDate = new Map<string, number>();
      (weekCalRes.data ?? []).forEach((row: { date: string; calories: number | null }) => {
        calByDate.set(row.date, (calByDate.get(row.date) ?? 0) + (row.calories ?? 0));
      });
      const days: DailyCalories[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = localDateStr(d);
        days.push({ date: key, calories: Math.round(calByDate.get(key) ?? 0) });
      }
      setWeeklyCalories(days);
      setCalories(days[days.length - 1]?.calories ?? 0);

      setWeightPoints((weightRes.data ?? []) as unknown as WeightPoint[]);
      setWeightUnit(unit);

      const profile = profileRes.profile;
      setProfileWeightKg(profile?.weight_kg ?? null);
      setGoalWeightKg(profile?.goal_weight_kg ?? null);
      setGoal(profile?.goal ?? null);
    } catch (err) {
      console.warn('HomeMetricsRow load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadAll();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  const isMilestone =
    streak.current >= 3 && streak.current >= streak.longest && streak.current > 0;

  const calorieRatio = Math.min(calories / Math.max(calorieGoal, 1), 1);
  const calorieEmpty = calories === 0;

  // Latest weight: prefer the most recent log, fall back to profile snapshot.
  const latestWeightKg = useMemo(() => {
    if (weightPoints.length > 0) return weightPoints[weightPoints.length - 1].weight_kg;
    return profileWeightKg;
  }, [weightPoints, profileWeightKg]);

  const trend = useMemo(() => {
    if (weightPoints.length < 2) return null;
    const values = weightPoints.map((p) =>
      weightUnit === 'lbs' ? p.weight_kg * KG_TO_LBS : p.weight_kg,
    );
    const latest = values[values.length - 1];
    const earliest = values[0];
    return { values, delta: latest - earliest };
  }, [weightPoints, weightUnit]);

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }

  // Match the rest of the app's "stage" cards (Today's Workout, AI Trainer, etc.):
  // translucent white/black-alpha surface + hairline border.
  const surface = colors.backgroundSecondary;
  const border = colors.border;

  return (
    <View style={styles.container}>
      {isMilestone && (
        <View
          style={[
            styles.streakCard,
            {
              backgroundColor: isDark ? '#0F2236' : '#EAF3FF',
              borderColor: isDark ? '#14375C' : '#CDE0FF',
            },
          ]}
        >
          <View
            style={[styles.streakIconWrap, { backgroundColor: isDark ? '#14375C' : '#DCE9FF' }]}
          >
            <Ionicons name="flame" size={20} color="#2E90FA" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.streakDays, { color: colors.text }]}>
              {streak.current} day{streak.current === 1 ? '' : 's'}
            </Text>
            <Text style={[styles.streakSub, { color: isDark ? '#8FBFFC' : '#1A6FE0' }]}>
              {streak.current === streak.longest
                ? 'Your longest streak!'
                : 'New personal best!'}
            </Text>
          </View>
          <StatShareButton
            label="Share"
            tint="#2E90FA"
            textColor={colors.text}
            stat={{
              kind: 'streak',
              value: String(streak.current),
              label: 'Day Streak',
              subtitle:
                streak.current === streak.longest
                  ? 'My longest streak yet!'
                  : 'New personal best!',
            }}
          />
        </View>
      )}

      <View style={styles.row}>
        <MacrosCard
          calories={calories}
          goal={calorieGoal}
          ratio={calorieRatio}
          empty={calorieEmpty}
          surface={surface}
          border={border}
          isDark={isDark}
          onPress={() => router.push('/(tabs)/nutrition')}
        />
        <WeightCard
          latestKg={latestWeightKg}
          unit={weightUnit}
          trend={trend}
          surface={surface}
          border={border}
          isDark={isDark}
          onPress={() => setLogSheetOpen(true)}
        />
      </View>

      {/* Goal weight journey — only when goal is set and meaningfully different */}
      <GoalProgressBar
        latestKg={latestWeightKg}
        goalKg={goalWeightKg}
        goalType={goal}
        unit={weightUnit}
        surface={surface}
        border={border}
        isDark={isDark}
      />

      {/* 7-day calorie chart */}
      <CalorieWeeklyChart
        days={weeklyCalories}
        goal={calorieGoal}
        surface={surface}
        border={border}
        isDark={isDark}
        onPress={() => router.push('/(tabs)/nutrition')}
      />

      <LogWeightSheet
        visible={logSheetOpen}
        unit={weightUnit}
        latestKg={latestWeightKg}
        goalWeightKg={goalWeightKg}
        goal={goal}
        userId={userId}
        isDark={isDark}
        onClose={() => setLogSheetOpen(false)}
        onSaved={async () => {
          setLogSheetOpen(false);
          await loadAll();
        }}
      />
    </View>
  );
};

// ─── Macros card ────────────────────────────────────────────────────────────

interface MacrosCardProps {
  calories: number;
  goal: number;
  ratio: number;
  empty: boolean;
  surface: string;
  border: string;
  isDark: boolean;
  onPress: () => void;
}

const MacrosCard: React.FC<MacrosCardProps> = ({
  calories,
  goal,
  ratio,
  empty,
  surface,
  border,
  isDark,
  onPress,
}) => {
  const colors = getThemeColors(isDark);
  const trackColor = isDark ? '#2A2A2A' : '#EFEFEF';
  const pct = Math.round(ratio * 100);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.metricCard, { backgroundColor: surface, borderColor: border }]}
    >
      <View style={styles.metricHeader}>
        <View
          style={[styles.metricIconWrap, { backgroundColor: isDark ? '#0F2236' : '#E8F8EF' }]}
        >
          <Ionicons name="nutrition-outline" size={14} color={colors.primary} />
        </View>
        <Text style={[styles.metricLabel, { color: colors.textMuted }]}>Today</Text>
      </View>

      {empty ? (
        <>
          <Text style={[styles.emptyTitle, { color: colors.text }]} numberOfLines={1}>
            Log your meals
          </Text>
          <Text style={[styles.emptySub, { color: colors.textMuted }]} numberOfLines={1}>
            Goal {goal.toLocaleString()} cal
          </Text>
          <View style={[styles.progressTrack, { backgroundColor: trackColor }]}>
            <View style={[styles.progressFill, { backgroundColor: trackColor, width: '0%' }]} />
          </View>
          <View style={styles.cardCta}>
            <Text style={[styles.cardCtaText, { color: colors.primary }]}>Open nutrition</Text>
            <Ionicons name="chevron-forward" size={12} color={colors.primary} />
          </View>
        </>
      ) : (
        <>
          <View style={styles.valueRow}>
            <Text style={[styles.bigNumber, { color: colors.text }]} numberOfLines={1}>
              {calories.toLocaleString()}
            </Text>
            <Text style={[styles.bigNumberSuffix, { color: colors.textTertiary }]} numberOfLines={1}>
              /{goal.toLocaleString()}
            </Text>
          </View>
          <Text style={[styles.metricSubLabel, { color: colors.textMuted }]}>
            cal • {pct}%
          </Text>
          <View style={[styles.progressTrack, { backgroundColor: trackColor }]}>
            <View
              style={[
                styles.progressFill,
                { backgroundColor: colors.primary, width: `${Math.max(2, pct)}%` },
              ]}
            />
          </View>
        </>
      )}
    </TouchableOpacity>
  );
};

// ─── Weight card ────────────────────────────────────────────────────────────

interface WeightCardProps {
  latestKg: number | null;
  unit: 'kg' | 'lbs';
  trend: { values: number[]; delta: number } | null;
  surface: string;
  border: string;
  isDark: boolean;
  onPress: () => void;
}

const WeightCard: React.FC<WeightCardProps> = ({
  latestKg,
  unit,
  trend,
  surface,
  border,
  isDark,
  onPress,
}) => {
  const colors = getThemeColors(isDark);
  const accent = '#2E90FA';
  const display = latestKg != null
    ? (unit === 'lbs' ? latestKg * KG_TO_LBS : latestKg).toFixed(1)
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.metricCard, { backgroundColor: surface, borderColor: border }]}
    >
      <View style={styles.metricHeader}>
        <View
          style={[styles.metricIconWrap, { backgroundColor: isDark ? '#1F1A29' : '#F0EDFB' }]}
        >
          <Ionicons name="trending-up-outline" size={14} color={accent} />
        </View>
        <Text style={[styles.metricLabel, { color: colors.textMuted }]}>Weight</Text>
      </View>

      {display == null ? (
        <>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Log weight</Text>
          <Text style={[styles.emptySub, { color: colors.textMuted }]}>
            Track your progress
          </Text>
          <View style={{ flex: 1 }} />
          <View style={styles.cardCta}>
            <Text style={[styles.cardCtaText, { color: accent }]}>Add entry</Text>
            <Ionicons name="add-circle" size={12} color={accent} />
          </View>
        </>
      ) : (
        <>
          <View style={styles.valueRow}>
            <Text style={[styles.bigNumber, { color: colors.text }]} numberOfLines={1}>
              {display}
            </Text>
            <Text style={[styles.bigNumberSuffix, { color: colors.textTertiary }]}>{unit}</Text>
          </View>
          <Text
            style={[
              styles.metricSubLabel,
              {
                color: trend
                  ? Math.abs(trend.delta) < 0.05
                    ? colors.textTertiary
                    : trend.delta < 0
                      ? '#2E90FA'
                      : '#999999'
                  : colors.textMuted,
              },
            ]}
            numberOfLines={1}
          >
            {trend
              ? Math.abs(trend.delta) < 0.05
                ? '→ steady'
                : `${trend.delta < 0 ? '↓' : '↑'} ${Math.abs(trend.delta).toFixed(1)} ${unit} (90d)`
              : 'Tap to log new entry'}
          </Text>
          {trend ? (
            <Sparkline values={trend.values} color={trend.delta < 0 ? '#2E90FA' : accent} />
          ) : (
            <View style={{ height: SPARK_HEIGHT, marginTop: 'auto' }} />
          )}
        </>
      )}
    </TouchableOpacity>
  );
};

// ─── Goal progress bar ──────────────────────────────────────────────────────

interface GoalProgressBarProps {
  latestKg: number | null;
  goalKg: number | null;
  goalType: string | null;
  unit: 'kg' | 'lbs';
  surface: string;
  border: string;
  isDark: boolean;
}

const GoalProgressBar: React.FC<GoalProgressBarProps> = ({
  latestKg,
  goalKg,
  goalType,
  unit,
  surface,
  border,
  isDark,
}) => {
  const colors = getThemeColors(isDark);
  if (latestKg == null || goalKg == null) return null;
  if (Math.abs(latestKg - goalKg) < 0.5) return null; // already at goal
  if (goalType === 'maintain') return null;

  const display = (v: number) => (unit === 'lbs' ? v * KG_TO_LBS : v).toFixed(1);
  const isLoss = goalKg < latestKg; // goal is to weigh less
  const directionLabel = isLoss ? 'to lose' : 'to gain';
  const diff = Math.abs(latestKg - goalKg);
  const diffDisplay = (unit === 'lbs' ? diff * KG_TO_LBS : diff).toFixed(1);

  return (
    <View style={[styles.goalCard, { backgroundColor: surface, borderColor: border }]}>
      <View style={styles.goalRowTop}>
        <View style={styles.goalLabelRow}>
          <Ionicons
            name={isLoss ? 'trending-down' : 'trending-up'}
            size={14}
            color={colors.primary}
          />
          <Text style={[styles.goalLabel, { color: colors.textMuted }]}>Goal weight</Text>
        </View>
        <Text style={[styles.goalDiff, { color: colors.text }]}>
          {diffDisplay} {unit} {directionLabel}
        </Text>
      </View>
      <GoalScale
        currentKg={latestKg}
        goalKg={goalKg}
        unit={unit}
        isDark={isDark}
        accent={colors.primary}
      />
      <View style={styles.goalRowBottom}>
        <Text style={[styles.goalEndpoint, { color: colors.textMuted }]}>
          {display(latestKg)} {unit}
        </Text>
        <Text style={[styles.goalEndpoint, { color: colors.textMuted }]}>
          Goal {display(goalKg)} {unit}
        </Text>
      </View>
    </View>
  );
};

const GoalScale: React.FC<{
  currentKg: number;
  goalKg: number;
  unit: 'kg' | 'lbs';
  isDark: boolean;
  accent: string;
}> = ({ currentKg, goalKg, isDark, accent }) => {
  // Show position of `current` on a scale anchored by current↔goal endpoints.
  // For motivational framing the current is always at left, goal at right;
  // direction arrow makes sense regardless of which is higher.
  const trackColor = isDark ? '#2A2A2A' : '#EFEFEF';
  // Static fill always 100% — the visual emphasizes the journey rather than
  // % completed (we don't yet know the starting point reliably for everyone).
  return (
    <View style={[styles.goalScaleTrack, { backgroundColor: trackColor }]}>
      <View style={[styles.goalScaleFill, { backgroundColor: accent }]} />
      <View style={[styles.goalScaleDot, { backgroundColor: accent }]} />
    </View>
  );
};

// ─── 7-day calorie bar chart ────────────────────────────────────────────────

interface CalorieWeeklyChartProps {
  days: DailyCalories[];
  goal: number;
  surface: string;
  border: string;
  isDark: boolean;
  onPress: () => void;
}

const CalorieWeeklyChart: React.FC<CalorieWeeklyChartProps> = ({
  days,
  goal,
  surface,
  border,
  isDark,
  onPress,
}) => {
  const colors = getThemeColors(isDark);
  const hasData = days.some((d) => d.calories > 0);
  const max = Math.max(goal, ...days.map((d) => d.calories), 1);
  const todayKey = localDateStr(new Date());
  const dayLetter = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.weeklyCard, { backgroundColor: surface, borderColor: border }]}
    >
      <View style={styles.weeklyHeader}>
        <View style={styles.weeklyHeaderLeft}>
          <View
            style={[styles.metricIconWrap, { backgroundColor: isDark ? '#0F2236' : '#E8F8EF' }]}
          >
            <Ionicons name="bar-chart-outline" size={14} color={colors.primary} />
          </View>
          <Text style={[styles.weeklyTitle, { color: colors.text }]}>Calories</Text>
        </View>
        <Text style={[styles.weeklySubtitle, { color: colors.textMuted }]}>last 7 days</Text>
      </View>

      <View style={styles.barChartWrap}>
        {/* Goal reference dashed line */}
        <View
          style={[
            styles.goalLine,
            {
              bottom: (goal / max) * BAR_AREA_H,
              borderColor: isDark ? '#3A3A3A' : '#D8D8D8',
            },
          ]}
        />
        {days.map((d) => {
          const isToday = d.date === todayKey;
          const ratio = Math.min(d.calories / max, 1);
          const barHeight = Math.max(2, ratio * BAR_AREA_H);
          const barColor = d.calories === 0
            ? (isDark ? '#262626' : '#EAEAEA')
            : isToday
              ? colors.primary
              : (isDark ? '#3F3F3F' : '#C8C8C8');
          return (
            <View key={d.date} style={styles.barCol}>
              <View style={styles.barTrack}>
                <View
                  style={{
                    width: 14,
                    height: barHeight,
                    borderRadius: 4,
                    backgroundColor: barColor,
                  }}
                />
              </View>
              <Text
                style={[
                  styles.barDay,
                  { color: isToday ? colors.text : colors.textMuted },
                  isToday && { fontFamily: 'Montserrat_700Bold' },
                ]}
              >
                {dayLetter(d.date)}
              </Text>
            </View>
          );
        })}
      </View>
      {!hasData && (
        <Text style={[styles.weeklyEmpty, { color: colors.textMuted }]}>
          Log a meal to start tracking
        </Text>
      )}
    </TouchableOpacity>
  );
};

// ─── Sparkline ──────────────────────────────────────────────────────────────

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 32;

const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  if (values.length < 2) return <View style={{ height: SPARK_HEIGHT, marginTop: 'auto' }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = SPARK_WIDTH / (values.length - 1);
  const points = values.map((v, i) => ({
    x: i * stepX,
    y: SPARK_HEIGHT - 4 - ((v - min) / range) * (SPARK_HEIGHT - 8),
  }));
  const d = points.reduce(
    (acc, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`),
    '',
  );
  const last = points[points.length - 1];
  return (
    <View style={{ height: SPARK_HEIGHT, marginTop: 'auto', overflow: 'hidden' }}>
      <Svg width={SPARK_WIDTH} height={SPARK_HEIGHT}>
        <Path
          d={d}
          stroke={color}
          strokeWidth={1.8}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Circle cx={last.x} cy={last.y} r={2.5} fill={color} />
      </Svg>
    </View>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const BAR_AREA_H = 64;

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    marginTop: 8,
    marginBottom: 4,
    gap: 12,
  },
  loadingWrap: {
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  streakIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakDays: { fontSize: 15, fontFamily: 'Montserrat_700Bold' },
  streakSub: { fontSize: 12, fontFamily: 'Montserrat_600SemiBold', marginTop: 1 },
  row: { flexDirection: 'row', gap: 12 },
  metricCard: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 132,
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  metricIconWrap: {
    width: 22,
    height: 22,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricLabel: {
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  bigNumber: { fontSize: 22, fontFamily: 'Montserrat_700Bold', fontVariant: ['tabular-nums'] },
  bigNumberSuffix: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
    fontVariant: ['tabular-nums'],
  },
  metricSubLabel: {
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
    marginTop: 2,
    marginBottom: 12,
  },
  emptyTitle: { fontSize: 15, fontFamily: 'Montserrat_700Bold' },
  emptySub: { fontSize: 11, fontFamily: 'Montserrat_500Medium', marginTop: 2, marginBottom: 12 },
  progressTrack: {
    height: 4,
    borderRadius: 999,
    overflow: 'hidden',
    marginTop: 'auto',
  },
  progressFill: { height: '100%', borderRadius: 999 },
  cardCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  cardCtaText: { fontSize: 11, fontFamily: 'Montserrat_600SemiBold' },

  // Goal progress card
  goalCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  goalRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  goalLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  goalLabel: {
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  goalDiff: { fontSize: 13, fontFamily: 'Montserrat_700Bold' },
  goalScaleTrack: {
    height: 6,
    borderRadius: 999,
    position: 'relative',
    overflow: 'visible',
  },
  goalScaleFill: { height: '100%', width: '100%', borderRadius: 999, opacity: 0.4 },
  goalScaleDot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 8,
    top: -3,
    right: -2,
  },
  goalRowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  goalEndpoint: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },

  // Weekly calorie chart
  weeklyCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
  },
  weeklyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  weeklyHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  weeklyTitle: { fontSize: 13, fontFamily: 'Montserrat_700Bold' },
  weeklySubtitle: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },
  barChartWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: BAR_AREA_H + 18,
    position: 'relative',
  },
  goalLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 0,
    borderTopWidth: 1,
    borderStyle: 'dashed',
  },
  barCol: { alignItems: 'center', flex: 1 },
  barTrack: { height: BAR_AREA_H, justifyContent: 'flex-end', alignItems: 'center' },
  barDay: {
    fontSize: 10,
    fontFamily: 'Montserrat_500Medium',
    marginTop: 4,
  },
  weeklyEmpty: {
    fontSize: 11,
    fontFamily: 'Montserrat_500Medium',
    textAlign: 'center',
    marginTop: 8,
  },

});

export default HomeMetricsRow;
