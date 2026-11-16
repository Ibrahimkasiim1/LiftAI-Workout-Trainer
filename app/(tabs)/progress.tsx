// app/(tabs)/progress.tsx
/**
 * Progress Tab — modular dashboard.
 * Grid cards, GitHub-style heatmap, consistency calendar, sparklines, streak gamification, muscle breakdown.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  Image,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Ellipse, RadialGradient as SvgRadialGradient, Stop } from 'react-native-svg';

import AdBanner from '../../components/AdBanner';
import FirstVisitHint from '../../components/FirstVisitHint';
import ConsistencyCalendar from '../../components/ConsistencyCalendar';
import LogWeightSheet from '../../components/LogWeightSheet';
import EmptyState from '../../components/ui/EmptyState';
import { TAB_BAR_CLEARANCE } from '../../constants/layout';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import {
  HeatmapCell,
  MuscleGroupSlice,
  ProgressStats,
  SparklinePoint,
  WeeklyVolumeSeries,
  WeeklyWorkoutProgress,
  getActivityHeatmap,
  getAllExercisesPerformed,
  getExerciseSparklineData,
  getMuscleGroupBreakdown,
  getProgressStats,
  getWeeklyVolumeSeries,
  getWeeklyWorkoutProgress,
} from '../../src/services/ProgressService';
import { resolveFirstName } from '../../utils/nameUtils';
import { getUserProfile, UserProfile } from '../../utils/userProfile';
import { getWeightUnit, toUserUnit } from '../../utils/weightConverter';
import { supabase } from '../../utils/supabase';

const { width: SCREEN_W } = Dimensions.get('window');
const PAGE_PAD = 20;

// Selectable time windows for the body-weight trend chart.
const RANGE_OPTIONS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1y', days: 365 },
] as const;
const MAX_RANGE_DAYS = 365;

// Respect the OS "Reduce Motion" setting so entrance animations can be skipped.
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => mounted && setReduced(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// Lighten/darken a hex color by mixing toward white/black — used to build gradients
// from the single brand primary so we don't hardcode extra palette values.
function shade(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const to2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

// ============================================================================
// Liquid-glass design tokens + reusable GlassCard (expo-blur frosted surface)
// ============================================================================
function useGlass(isDark: boolean) {
  // Flat surface tokens derived from the app's "stage" theme so the Progress
  // tab matches the rest of the app (true-black/white backdrop, translucent
  // white-alpha card surfaces, hairline borders).
  return useMemo(() => {
    const c = getThemeColors(isDark);
    return {
      tint: (isDark ? 'dark' : 'light') as 'dark' | 'light',
      intensity: 0,
      fill: c.backgroundSecondary,
      sheen: ['transparent', 'transparent'] as const,
      border: c.border,
      text: c.text,
      muted: c.textSecondary,
      track: c.backgroundTertiary,
      backdrop: [c.background, c.background, c.background] as const,
    };
  }, [isDark]);
}

function GlassCard({
  children,
  style,
  contentStyle,
  glow,
  glowColor,
  isDark,
  radius = 22,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  contentStyle?: ViewStyle | ViewStyle[];
  glow?: 'soft' | 'strong';
  glowColor: string;
  isDark: boolean;
  radius?: number;
}) {
  const g = useGlass(isDark);
  // Flat card surface — same component API as the old frosted version.
  void glow;
  void glowColor;
  return (
    <View
      style={[
        {
          borderRadius: radius,
          backgroundColor: g.fill,
          borderWidth: 1,
          borderColor: g.border,
          overflow: 'hidden',
        },
        style,
        contentStyle,
      ]}
    >
      {children}
    </View>
  );
}

// Plain page backdrop — true-black/white stage to match the rest of the app.
function AmbientBackground({ isDark, primary }: { isDark: boolean; primary: string }) {
  void primary;
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: getThemeColors(isDark).background }]}
      pointerEvents="none"
    />
  );
}

// ============================================================================
// Activity Heatmap (GitHub-style)
// ============================================================================
function ActivityHeatmap({
  cells,
  color,
  trackColor,
  textColor,
  mutedColor,
}: {
  cells: HeatmapCell[];
  color: string;
  trackColor: string;
  textColor: string;
  mutedColor: string;
}) {
  // Group cells into columns of 7 (weeks). Cells are oldest→newest.
  // Pad the front so the first column starts on Sunday.
  const padded = useMemo(() => {
    if (cells.length === 0) return [] as (HeatmapCell | null)[];
    const first = new Date(cells[0].date + 'T00:00:00');
    const dayOfWeek = first.getDay(); // 0 = Sun
    const out: (HeatmapCell | null)[] = [];
    for (let i = 0; i < dayOfWeek; i++) out.push(null);
    out.push(...cells);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cells]);

  const weeks: (HeatmapCell | null)[][] = useMemo(() => {
    const w: (HeatmapCell | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) w.push(padded.slice(i, i + 7));
    return w;
  }, [padded]);

  const intensityToColor = (i: number): string => {
    if (i === 0) return trackColor;
    const alphas = [0.25, 0.45, 0.7, 1.0];
    const a = alphas[i - 1] ?? 1;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  // Size cells to fill the full card width so the grid is balanced (no dead space).
  const innerW = SCREEN_W - PAGE_PAD * 2 - 32; // card horizontal padding
  const colCount = weeks.length || 1;
  const gap = 4;
  const cellSize = Math.max(10, Math.min(24, Math.floor((innerW - (colCount - 1) * gap) / colCount)));

  return (
    <View>
      <Text style={{ fontSize: 13, color: mutedColor, fontFamily: 'Montserrat_500Medium', marginBottom: 12 }}>
        Activity — last {Math.round(cells.length / 7)} weeks
      </Text>
      <View style={{ flexDirection: 'row', gap, justifyContent: 'center' }}>
        {weeks.map((week, wi) => (
          <View key={wi} style={{ gap }}>
            {week.map((cell, di) => (
              <View
                key={`${wi}-${di}`}
                style={{
                  width: cellSize,
                  height: cellSize,
                  borderRadius: 4,
                  backgroundColor: cell ? intensityToColor(cell.intensity) : 'transparent',
                }}
              />
            ))}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 16, justifyContent: 'center' }}>
        <Text style={{ fontSize: 10, color: mutedColor, marginRight: 4 }}>Less</Text>
        {[0, 1, 2, 3, 4].map(i => (
          <View key={i} style={{ width: 11, height: 11, borderRadius: 4, backgroundColor: intensityToColor(i) }} />
        ))}
        <Text style={{ fontSize: 10, color: mutedColor, marginLeft: 4 }}>More</Text>
      </View>
    </View>
  );
}

// ============================================================================
// Muscle group bars
// ============================================================================
// ============================================================================
// Weekly Volume — the paywall analytics visual as a real chart: rounded
// vertical bars, latest week in solid blue with a PR badge when it's a
// record, and a blue trend delta in the header.
// ============================================================================
function WeeklyVolumeBars({
  series,
  unit,
  primary,
  text,
  muted,
}: {
  series: WeeklyVolumeSeries;
  unit: 'kg' | 'lbs';
  primary: string;
  text: string;
  muted: string;
}) {
  const { points, deltaPct, latestIsRecord } = series;
  const max = Math.max(...points.map(p => p.volumeKg), 1);
  const hasData = points.some(p => p.volumeKg > 0);

  if (!hasData) {
    return (
      <Text style={{ fontSize: 13, color: muted, fontFamily: 'Montserrat_400Regular', textAlign: 'center', paddingVertical: 8 }}>
        Complete workouts to see your weekly volume trend.
      </Text>
    );
  }

  const latest = points[points.length - 1]?.volumeKg ?? 0;
  const latestDisplay = Math.round(toUserUnit(latest, unit)).toLocaleString();

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ fontSize: 13, color: text, fontFamily: 'Montserrat_600SemiBold' }}>
          {latestDisplay} {unit} this week
        </Text>
        {deltaPct !== null && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name={deltaPct >= 0 ? 'trending-up' : 'trending-down'} size={12} color={primary} />
            <Text style={{ fontSize: 12, color: primary, fontFamily: 'Montserrat_700Bold' }}>
              {deltaPct >= 0 ? '+' : ''}{deltaPct}%
            </Text>
          </View>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 104 }}>
        {points.map((p, i) => {
          const isLast = i === points.length - 1;
          const h = Math.max(6, (p.volumeKg / max) * 82);
          return (
            <View key={`${p.label}-${i}`} style={{ alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              {isLast && latestIsRecord && (
                <View style={{ backgroundColor: primary, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontFamily: 'Montserrat_700Bold', fontSize: 9, color: '#FFFFFF', letterSpacing: 0.5 }}>
                    PR
                  </Text>
                </View>
              )}
              <View
                style={{
                  width: 26,
                  borderRadius: 8,
                  height: h,
                  backgroundColor: isLast ? primary : 'rgba(46,144,250,0.32)',
                }}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

function MuscleGroupBars({
  data,
  primary,
  track,
  text,
  muted,
}: {
  data: MuscleGroupSlice[];
  primary: string;
  track: string;
  text: string;
  muted: string;
}) {
  if (data.length === 0) {
    return (
      <Text style={{ fontSize: 13, color: muted, fontFamily: 'Montserrat_400Regular', textAlign: 'center', paddingVertical: 8 }}>
        No sets logged this week yet.
      </Text>
    );
  }
  const max = Math.max(...data.map(d => d.sets), 1);
  return (
    <View style={{ gap: 12 }}>
      {data.slice(0, 8).map((slice, i) => (
        <MuscleGroupBar
          key={slice.muscle}
          muscle={slice.muscle}
          sets={slice.sets}
          pct={slice.sets / max}
          index={i}
          primary={primary}
          track={track}
          text={text}
          muted={muted}
        />
      ))}
    </View>
  );
}

function MuscleGroupBar({
  muscle,
  sets,
  pct,
  index,
  primary,
  track,
  text,
  muted,
}: {
  muscle: string;
  sets: number;
  pct: number;
  index: number;
  primary: string;
  track: string;
  text: string;
  muted: string;
}) {
  const reduced = useReducedMotion();
  const grow = useRef(new Animated.Value(0)).current;
  const isLow = pct < 0.25;

  useEffect(() => {
    if (reduced) {
      grow.setValue(1);
      return;
    }
    grow.setValue(0);
    // Stagger each bar so they fill in sequence (30–50ms apart per the motion guidelines).
    Animated.timing(grow, {
      toValue: 1,
      duration: 700,
      delay: index * 50,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [grow, pct, index, reduced]);

  const widthPct = grow.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', `${Math.max(2, pct * 100)}%`],
  });

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 13, color: text, fontFamily: 'Montserrat_500Medium', textTransform: 'capitalize' }}>
            {muscle}
          </Text>
          {isLow && <Ionicons name="alert-circle" size={13} color="#999999" />}
        </View>
        <Text style={{ fontSize: 12, color: muted, fontFamily: 'Montserrat_600SemiBold' }}>
          {sets} set{sets === 1 ? '' : 's'}
        </Text>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: track, overflow: 'hidden' }}>
        <Animated.View style={{ width: widthPct, height: '100%', borderRadius: 4, overflow: 'hidden' }}>
          <LinearGradient
            colors={[shade(primary, 0.3), primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      </View>
    </View>
  );
}

// ============================================================================
// Sparkline (mini line for exercise rows)
// ============================================================================
function Sparkline({
  points,
  color,
  width = 70,
  height = 28,
}: {
  points: SparklinePoint[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <View style={{ width, height }} />;
  }
  const data = points.map(p => ({ value: p.value }));
  return (
    <View style={{ width, height, overflow: 'hidden' }}>
      <LineChart
        data={data}
        width={width}
        height={height}
        hideDataPoints
        hideAxesAndRules
        hideRules
        hideYAxisText
        xAxisColor="transparent"
        yAxisColor="transparent"
        color={color}
        thickness={2}
        curved
        initialSpacing={0}
        endSpacing={0}
        spacing={width / Math.max(1, points.length - 1)}
        adjustToWidth
        disableScroll
        areaChart
        startFillColor={color}
        endFillColor={color}
        startOpacity={0.25}
        endOpacity={0.0}
      />
    </View>
  );
}

// ============================================================================
// Body-weight trend — full-width animated gradient area chart
// ============================================================================
function WeightTrendChart({
  logs,
  unit,
  goalKg,
  range,
  onRangeChange,
  onLogPress,
  primary,
  text,
  muted,
  tooltipText,
  track,
  isDark,
}: {
  logs: { weight_kg: number; logged_at: string }[];
  unit: 'kg' | 'lbs';
  goalKg: number;
  range: number;
  onRangeChange: (days: number) => void;
  onLogPress: () => void;
  primary: string;
  text: string;
  muted: string;
  tooltipText: string;
  track: string;
  isDark: boolean;
}) {
  const reduced = useReducedMotion();
  const chartW = SCREEN_W - PAGE_PAD * 2 - 32; // card horizontal padding
  const rangeLabel = RANGE_OPTIONS.find(o => o.days === range)?.label ?? `${range}d`;

  const data = useMemo(
    () =>
      logs.map(l => ({
        value: toUserUnit(l.weight_kg, unit),
        label: '',
        date: l.logged_at,
      })),
    [logs, unit],
  );

  const hasTrend = data.length >= 2;
  const goalDisplay = goalKg > 0 ? toUserUnit(goalKg, unit) : 0;

  const values = data.map(d => d.value);
  const last = hasTrend ? values[values.length - 1] : (values[0] ?? 0);
  const first = hasTrend ? values[0] : 0;
  const delta = last - first;
  const down = delta < 0;
  const trendColor = down ? '#2E90FA' : primary;

  // Y-window is DATA-first. The goal is pulled into the window only when it's
  // near the data (within one data-span); a far-away goal used to stretch the
  // axis and leave a third of the card empty just so the dashed line could
  // float in it. The "to go" sentence is the precise measure — when the goal
  // is out of range its line clamps to the chart edge as a direction marker.
  const dataLo = values.length ? Math.min(...values) : 0;
  const dataHi = values.length ? Math.max(...values) : 0;
  const pad = Math.max(0.5, (dataHi - dataLo) * 0.12);
  let lo = dataLo - pad;
  let hi = dataHi + pad;
  const dataSpan = Math.max(1, dataHi - dataLo);
  if (goalDisplay > 0) {
    if (goalDisplay < lo && lo - goalDisplay <= dataSpan) lo = goalDisplay - pad * 0.5;
    else if (goalDisplay > hi && goalDisplay - hi <= dataSpan) hi = goalDisplay + pad * 0.5;
  }
  const yOffset = Math.max(0, lo);
  const yMax = hi - yOffset;
  const winSpan = Math.max(0.001, hi - lo);
  const goalLinePos =
    goalDisplay > 0
      ? Math.min(Math.max(goalDisplay, lo + winSpan * 0.05), hi - winSpan * 0.05)
      : 0;

  // The one-sentence answer this card exists to give: how far you've come,
  // how far to go. Everything else on the card is supporting texture.
  const dec = unit === 'kg' ? 1 : 0;
  const toGo = goalDisplay > 0 ? goalDisplay - last : 0;
  const goalReached =
    goalDisplay > 0 && hasTrend && (Math.abs(toGo) < 0.05 || Math.sign(toGo) !== Math.sign(goalDisplay - first));
  const summary = hasTrend
    ? goalDisplay > 0
      ? goalReached
        ? `${Math.abs(delta).toFixed(1)} ${unit} ${down ? 'down' : 'up'} · goal reached`
        : `${Math.abs(delta).toFixed(1)} ${unit} ${down ? 'down' : 'up'} · ${Math.abs(toGo).toFixed(1)} ${unit} to go`
      : `${Math.abs(delta).toFixed(1)} ${unit} ${down ? 'down' : 'up'} over ${rangeLabel}`
    : goalDisplay > 0
      ? `goal ${goalDisplay.toFixed(dec)} ${unit}`
      : 'log weigh-ins to see your trend';

  const cycleRange = () => {
    Haptics.selectionAsync().catch(() => {});
    const idx = RANGE_OPTIONS.findIndex(o => o.days === range);
    onRangeChange(RANGE_OPTIONS[(idx + 1) % RANGE_OPTIONS.length].days);
  };

  // Spoken summary for VoiceOver so the insight isn't conveyed by color alone.
  const a11ySummary = hasTrend
    ? `Body weight ${last.toFixed(dec)} ${unit}, ${down ? 'down' : 'up'} ${Math.abs(delta).toFixed(1)} ${unit} over the last ${rangeLabel}.${goalDisplay ? ` Goal ${goalDisplay.toFixed(1)} ${unit}.` : ''}`
    : `Not enough weigh-ins in the last ${rangeLabel} to show a trend.`;

  return (
    <GlassCard glow="soft" glowColor={primary} isDark={isDark} style={styles.fullCard} contentStyle={styles.glassCardPad}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardLabel, { color: muted }]}>Body Weight</Text>
          <Text style={{ fontSize: 28, color: text, fontFamily: 'Montserrat_700Bold', marginTop: 4, fontVariant: ['tabular-nums'] }}>
            {hasTrend || values.length ? last.toFixed(dec) : '—'}
            <Text style={{ fontSize: 15, color: muted, fontFamily: 'Montserrat_500Medium' }}> {unit}</Text>
          </Text>
          <Text style={{ fontSize: 13, color: hasTrend ? trendColor : muted, fontFamily: 'Montserrat_600SemiBold', marginTop: 2, fontVariant: ['tabular-nums'] }}>
            {summary}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 10 }}>
          <TouchableOpacity
            onPress={onLogPress}
            style={[styles.logBadge, { backgroundColor: primary + '22' }]}
            accessibilityRole="button"
            accessibilityLabel="Log body weight"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="add" size={18} color={primary} />
          </TouchableOpacity>
          {hasTrend && (
            <TouchableOpacity
              onPress={cycleRange}
              accessibilityRole="button"
              accessibilityLabel={`Showing last ${rangeLabel}. Tap to change range`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={{ fontSize: 12, color: muted, fontFamily: 'Montserrat_600SemiBold' }}>{rangeLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {hasTrend ? (
        <View
          style={{ marginTop: 8 }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={a11ySummary}
        >
          <LineChart
            data={data}
            width={chartW}
            height={90}
            adjustToWidth
            initialSpacing={6}
            endSpacing={6}
            spacing={chartW / Math.max(1, data.length - 1)}
            curved
            thickness={2.5}
            color={trendColor}
            hideDataPoints
            isAnimated={!reduced}
            animateOnDataChange={!reduced}
            animationDuration={900}
            yAxisOffset={yOffset}
            maxValue={yMax}
            noOfSections={3}
            // Chart as texture, not instrument: no axis numbers, no grid, no
            // fill — the line's shape and the dashed goal line ARE the story.
            // (The old auto-derived axis printed labels like "77.725".)
            yAxisColor="transparent"
            xAxisColor="transparent"
            hideRules
            hideYAxisText
            yAxisLabelWidth={0}
            // Goal line — turns "here's my weight" into "here's my weight vs target".
            showReferenceLine1={goalDisplay > 0}
            referenceLine1Position={goalLinePos}
            referenceLine1Config={{
              color: muted,
              thickness: 1.5,
              dashWidth: 6,
              dashGap: 5,
              labelText: `Goal ${goalDisplay.toFixed(unit === 'kg' ? 1 : 0)}`,
              labelTextStyle: { color: muted, fontSize: 9, fontFamily: 'Montserrat_600SemiBold' },
            }}
            pointerConfig={{
              pointerStripColor: muted,
              pointerStripWidth: 1,
              pointerColor: trendColor,
              radius: 5,
              pointerLabelWidth: 110,
              pointerLabelHeight: 50,
              activatePointersOnLongPress: false,
              pointerLabelComponent: (items: any[]) => {
                const it = items?.[0];
                if (!it) return null;
                const d = it.date ? new Date(it.date) : null;
                return (
                  <View style={[styles.tooltip, { backgroundColor: text }]}>
                    <Text style={{ color: tooltipText, fontSize: 13, fontFamily: 'Montserrat_700Bold', fontVariant: ['tabular-nums'] }}>
                      {it.value?.toFixed(unit === 'kg' ? 1 : 0)} {unit}
                    </Text>
                    {d && (
                      <Text style={{ color: tooltipText, fontSize: 10, fontFamily: 'Montserrat_500Medium', opacity: 0.7 }}>
                        {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </Text>
                    )}
                  </View>
                );
              },
            }}
          />
        </View>
      ) : (
        <View style={styles.trendEmpty} accessible accessibilityLabel={a11ySummary}>
          <Ionicons name="trending-up" size={28} color={muted} />
          <Text style={{ fontSize: 13, color: text, fontFamily: 'Montserrat_600SemiBold', marginTop: 12, textAlign: 'center' }}>
            Not enough data for this range
          </Text>
          <Text style={{ fontSize: 12, color: muted, fontFamily: 'Montserrat_400Regular', marginTop: 4, textAlign: 'center' }}>
            Log at least 2 weigh-ins to see your trend, or pick a wider range above.
          </Text>
        </View>
      )}
    </GlassCard>
  );
}

// ============================================================================
// Loading skeleton — mirrors the real layout so there's no jump on load.
// ============================================================================
function SkeletonBlock({
  width,
  height,
  radius = 12,
  isDark,
  style,
}: {
  width: number | string;
  height: number;
  radius?: number;
  isDark: boolean;
  style?: ViewStyle;
}) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduced) {
      pulse.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius: radius,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(11,18,32,0.06)',
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

function ProgressSkeleton({ isDark }: { isDark: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 + insets.bottom + TAB_BAR_CLEARANCE }}>
      <View style={styles.header}>
        <SkeletonBlock width={220} height={28} radius={8} isDark={isDark} />
        <SkeletonBlock width={140} height={16} radius={6} isDark={isDark} style={{ marginTop: 12 }} />
      </View>
      <View style={{ paddingHorizontal: PAGE_PAD, gap: 12 }}>
        <SkeletonBlock width="100%" height={124} radius={22} isDark={isDark} />
        <SkeletonBlock width="100%" height={200} radius={22} isDark={isDark} />
      </View>
      <View style={{ paddingHorizontal: PAGE_PAD, marginTop: 12, gap: 12 }}>
        <SkeletonBlock width="100%" height={220} radius={22} isDark={isDark} />
        <SkeletonBlock width="100%" height={160} radius={22} isDark={isDark} />
        <SkeletonBlock width="100%" height={180} radius={22} isDark={isDark} />
      </View>
    </ScrollView>
  );
}

// ============================================================================
// Main screen
// ============================================================================
export default function ProgressScreen() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const glass = useGlass(isDark);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session, loading: authLoading } = useRequireAuth();

  const [dataLoading, setDataLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<ProgressStats | null>(null);
  const [exerciseNames, setExerciseNames] = useState<string[]>([]);
  const [sparklines, setSparklines] = useState<Map<string, SparklinePoint[]>>(new Map());
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [weekly, setWeekly] = useState<WeeklyWorkoutProgress | null>(null);
  const [muscle, setMuscle] = useState<MuscleGroupSlice[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [volumeSeries, setVolumeSeries] = useState<WeeklyVolumeSeries | null>(null);
  const [unit, setUnit] = useState<'kg' | 'lbs'>('kg');
  const [weightLogs, setWeightLogs] = useState<{ weight_kg: number; logged_at: string }[]>([]);
  // 90d default: long enough to show a real trend, short enough to feel
  // current. Tap the small range chip on the card to cycle windows.
  const [trendRange, setTrendRange] = useState<number>(90);
  const [logSheetOpen, setLogSheetOpen] = useState(false);

  const loadAll = useCallback(async () => {
    if (!session) return;
    try {
      const userId = session.user.id;

      // Fetch the widest selectable window once; the chart filters client-side.
      const weightSince = new Date();
      weightSince.setDate(weightSince.getDate() - MAX_RANGE_DAYS);

      const [statsR, exR, profR, weekR, muscleR, heatR, volR, unitR, weightR] = await Promise.all([
        getProgressStats(userId),
        getAllExercisesPerformed(userId),
        getUserProfile(userId),
        getWeeklyWorkoutProgress(userId),
        getMuscleGroupBreakdown(userId, 7),
        getActivityHeatmap(userId, 12),
        getWeeklyVolumeSeries(userId, 7),
        getWeightUnit(),
        (supabase as any)
          .from('body_weight_logs')
          .select('weight_kg, logged_at')
          .eq('user_id', userId)
          .gte('logged_at', weightSince.toISOString())
          .order('logged_at', { ascending: true })
          .limit(365),
      ]);

      if (statsR.stats) setStats(statsR.stats);
      const names = exR.exercises ?? [];
      setExerciseNames(names);
      if (profR.profile) setProfile(profR.profile);
      setWeekly(weekR);
      setMuscle(muscleR);
      setHeatmap(heatR);
      setVolumeSeries(volR);
      setUnit(unitR);
      setWeightLogs((weightR.data ?? []) as { weight_kg: number; logged_at: string }[]);

      // Sparklines for top N exercises (avoid hammering supabase)
      const topNames = names.slice(0, 12);
      const sparkPairs = await Promise.all(
        topNames.map(async name => [name, await getExerciseSparklineData(userId, name, 8)] as const),
      );
      setSparklines(new Map(sparkPairs));
    } catch (e) {
      console.error('Progress load error:', e);
    } finally {
      setDataLoading(false);
    }
  }, [session]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  useEffect(() => {
    if (!authLoading && session) loadAll();
  }, [authLoading, session, loadAll]);

  useFocusEffect(
    useCallback(() => {
      if (!authLoading && session) loadAll();
    }, [authLoading, session, loadAll]),
  );

  if (authLoading || dataLoading) {
    return (
      <View style={[styles.container, { backgroundColor: glass.backdrop[0] }]}>
        <AmbientBackground isDark={isDark} primary={colors.primary} />
        <SafeAreaView style={styles.container}>
          <ProgressSkeleton isDark={isDark} />
        </SafeAreaView>
      </View>
    );
  }

  // Resolve a real first name via the shared chain (profile → full_name/name
  // → given+family metadata), same as the home and chat greetings.
  const resolvedFirstName = resolveFirstName(profile?.name, session?.user?.user_metadata);
  const userName = resolvedFirstName || 'there';
  const userId = session?.user.id ?? '';
  const latestLog = weightLogs[weightLogs.length - 1];
  const goalWeightKg = profile?.goal_weight_kg ?? 0;
  const goalDir = profile?.goal ?? null;
  const latestWeightKg = latestLog?.weight_kg ?? profile?.weight_kg ?? null;

  // Filter the fetched logs (up to 365d) down to the selected trend window.
  const trendCutoff = Date.now() - trendRange * 24 * 60 * 60 * 1000;
  const filteredWeightLogs = weightLogs.filter(
    (l) => new Date(l.logged_at).getTime() >= trendCutoff,
  );

  const trackColor = glass.track;
  const tooltipText = isDark ? '#0B1220' : '#FFFFFF';

  const openLogSheet = () => {
    Haptics.selectionAsync().catch(() => {});
    setLogSheetOpen(true);
  };

  return (
    <View style={[styles.container, { backgroundColor: glass.backdrop[0] }]}>
      <AmbientBackground isDark={isDark} primary={colors.primary} />
      <SafeAreaView style={styles.container}>
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          // Extra bottom inset: the native tab bar floats over content
          contentContainerStyle={{ paddingBottom: 32 + insets.bottom + TAB_BAR_CLEARANCE }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          {/* Header */}
          <View style={styles.header}>
            <Image
              source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
              style={styles.logo}
            />
            <Text style={[styles.title, { color: glass.text }]}>{userName}, here is your progress</Text>
            <Text style={[styles.subtitle, { color: glass.muted }]}>see how far you&apos;ve come</Text>
          </View>

          {/* One-time orientation hint (first visit only) */}
          <FirstVisitHint
            hintKey="progress"
            text="Every set you log builds these charts — PRs, volume trends, and muscle balance."
          />

          {/* Consistency — ONE card, STREAK-first (user preference): flame +
              streak are the hero, the weekly count is the supporting line.
              fullCard already carries the page margin — no wrapper padding,
              or the card renders narrower than its siblings. */}
          <GlassCard glow="soft" glowColor={colors.primary} isDark={isDark} style={styles.fullCard} contentStyle={styles.weeklyCardContent}>
              <View
                style={[
                  styles.flameBadge,
                  {
                    backgroundColor:
                      (stats?.currentStreak ?? 0) > 0
                        ? colors.primary + '24'
                        : isDark
                          ? 'rgba(255,255,255,0.08)'
                          : 'rgba(11,18,32,0.06)',
                  },
                ]}
              >
                <Ionicons
                  name="flame"
                  size={26}
                  color={(stats?.currentStreak ?? 0) > 0 ? colors.primary : glass.muted}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardLabel, { color: glass.muted }]}>Current Streak</Text>
                <Text style={[styles.streakValue, { color: glass.text }]}>
                  {stats?.currentStreak ?? 0}
                  <Text style={[styles.streakValueUnit, { color: glass.muted }]}>
                    {' '}day{(stats?.currentStreak ?? 0) === 1 ? '' : 's'}
                    {(stats?.longestStreak ?? 0) > 0 ? ` · best ${stats?.longestStreak}` : ''}
                  </Text>
                </Text>
                <Text style={[styles.streakLineText, { color: glass.muted, marginTop: 4 }]}>
                  {weekly?.completed ?? 0} of {weekly?.target ?? 5} workouts this week
                </Text>
              </View>
          </GlassCard>

          {/* Body weight — single card: answer first (weight + goal progress),
              chart as quiet texture underneath. */}
          <WeightTrendChart
            logs={filteredWeightLogs}
            unit={unit}
            goalKg={goalWeightKg}
            range={trendRange}
            onRangeChange={setTrendRange}
            onLogPress={openLogSheet}
            primary={colors.primary}
            text={glass.text}
            muted={glass.muted}
            tooltipText={tooltipText}
            track={trackColor}
            isDark={isDark}
          />

          {/* Consistency calendar (replaces total volume) */}
          <GlassCard glow="soft" glowColor={colors.primary} isDark={isDark} style={[styles.fullCard, { marginTop: 12 }]} contentStyle={styles.glassCardPad}>
            <Text style={[styles.cardLabel, { color: glass.muted, marginBottom: 8, paddingHorizontal: 4 }]}>
              Consistency
            </Text>
            {userId && <ConsistencyCalendar userId={userId} />}
          </GlassCard>

          {/* Heatmap */}
          <GlassCard glow="soft" glowColor={colors.primary} isDark={isDark} style={styles.fullCard} contentStyle={styles.glassCardPad}>
            <ActivityHeatmap
              cells={heatmap}
              color={colors.primary}
              trackColor={trackColor}
              textColor={glass.text}
              mutedColor={glass.muted}
            />
          </GlassCard>

          {/* Weekly volume bars (paywall analytics design) */}
          {volumeSeries && (
            <GlassCard glow="soft" glowColor={colors.primary} isDark={isDark} style={styles.fullCard} contentStyle={styles.glassCardPad}>
              <Text style={[styles.cardLabel, { color: glass.muted, marginBottom: 12 }]}>
                Weekly Volume — last 7 weeks
              </Text>
              <WeeklyVolumeBars
                series={volumeSeries}
                unit={unit}
                primary={colors.primary}
                text={glass.text}
                muted={glass.muted}
              />
            </GlassCard>
          )}

          {/* Muscle group bars */}
          <GlassCard glow="soft" glowColor={colors.primary} isDark={isDark} style={styles.fullCard} contentStyle={styles.glassCardPad}>
            <Text style={[styles.cardLabel, { color: glass.muted, marginBottom: 12 }]}>
              Muscle Groups — this week
            </Text>
            <MuscleGroupBars
              data={muscle}
              primary={colors.primary}
              track={trackColor}
              text={glass.text}
              muted={glass.muted}
            />
          </GlassCard>

          {/* Exercises with sparklines */}
          <View style={{ paddingHorizontal: PAGE_PAD, marginTop: 16 }}>
            <Text style={[styles.sectionTitle, { color: glass.text }]}>Exercises Performed</Text>
            {exerciseNames.length === 0 ? (
              <EmptyState
                icon="barbell-outline"
                headline="No exercises performed yet"
                sub="Complete your first workout to see progress here."
              />
            ) : (
              exerciseNames.map(name => {
                const points = sparklines.get(name) ?? [];
                const last = points[points.length - 1];
                const first = points[0];
                const trendUp = last && first && last.value > first.value;
                return (
                  <TouchableOpacity
                    key={name}
                    activeOpacity={0.85}
                    style={styles.exerciseTouch}
                    accessibilityRole="button"
                    accessibilityLabel={`${name} progress details`}
                    onPress={() =>
                      router.push({
                        pathname: '/workout/exercise-detail',
                        params: { exerciseName: name },
                      })
                    }
                  >
                    <GlassCard isDark={isDark} glowColor={colors.primary} radius={16} contentStyle={styles.exerciseRowContent}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.exerciseName, { color: glass.text }]} numberOfLines={1}>
                          {name}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                          {last && (
                            <Text style={[styles.exerciseMeta, { color: glass.muted }]}>
                              {last.isBodyweight
                                ? `${Math.round(last.value)} reps`
                                : `${Math.round(toUserUnit(last.value, unit))} ${unit}`}
                            </Text>
                          )}
                          {points.length > 1 && (
                            <View style={[styles.trendChip, { backgroundColor: (trendUp ? colors.primary : glass.muted) + '22' }]}>
                              <Ionicons
                                name={trendUp ? 'arrow-up' : 'arrow-down'}
                                size={11}
                                color={trendUp ? colors.primary : glass.muted}
                              />
                            </View>
                          )}
                        </View>
                      </View>
                      <Sparkline points={points} color={trendUp ? colors.primary : glass.muted} />
                      <Ionicons name="chevron-forward" size={18} color={glass.muted} style={{ marginLeft: 6 }} />
                    </GlassCard>
                  </TouchableOpacity>
                );
              })
            )}
          </View>

          <AdBanner style={{ marginTop: 16, marginBottom: 12 }} />
        </ScrollView>

        <LogWeightSheet
          visible={logSheetOpen}
          unit={unit}
          latestKg={latestWeightKg}
          goalWeightKg={goalWeightKg || null}
          goal={goalDir}
          userId={userId}
          isDark={isDark}
          onClose={() => setLogSheetOpen(false)}
          onSaved={async () => {
            setLogSheetOpen(false);
            await loadAll();
          }}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  // SafeAreaView already clears the notch — the old paddingTop: 52 stacked on
  // top of it and left a big dead zone above the logo.
  header: { padding: PAGE_PAD, paddingTop: 12, paddingBottom: 16 },
  logo: { width: 80, height: 36, marginBottom: 8, resizeMode: 'contain' },
  title: { fontSize: 28, fontFamily: 'Montserrat_700Bold', marginBottom: 8, lineHeight: 34 },
  subtitle: { fontSize: 15, fontFamily: 'Montserrat_400Regular', lineHeight: 20 },

  glassCardPad: { padding: 16 },
  // Weekly Workouts — horizontal: ring left, label right.
  weeklyCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    padding: 16,
  },
  flameBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakValue: { fontSize: 28, fontFamily: 'Montserrat_700Bold', marginTop: 2, fontVariant: ['tabular-nums'] },
  streakValueUnit: { fontSize: 14, fontFamily: 'Montserrat_500Medium' },
  streakLineText: { fontSize: 12, fontFamily: 'Montserrat_600SemiBold', fontVariant: ['tabular-nums'] },

  trendChip: {
    width: 20,
    height: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tooltip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: 'center',
  },

  cardLabel: { fontSize: 12, fontFamily: 'Montserrat_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.5 },

  // "+" affordance on the Body Weight card header.
  logBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Empty state shown inside the trend card when a range has < 2 weigh-ins.
  trendEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 12,
    marginTop: 12,
  },

  fullCard: {
    marginHorizontal: PAGE_PAD,
    marginTop: 12,
  },

  sectionTitle: { fontSize: 18, fontFamily: 'Montserrat_700Bold', marginBottom: 12 },

  exerciseTouch: { marginBottom: 8 },
  exerciseRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  exerciseName: { fontSize: 15, fontFamily: 'Montserrat_600SemiBold' },
  exerciseMeta: { fontSize: 12, fontFamily: 'Montserrat_500Medium', marginTop: 2 },

  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 16, fontFamily: 'Montserrat_500Medium', marginTop: 16, marginBottom: 8 },
  emptySubtext: { fontSize: 13, fontFamily: 'Montserrat_400Regular', textAlign: 'center' },
});
