import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetTextInput,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useFocusEffect, useRouter } from 'expo-router';
import { posthog } from '../../src/config/posthog';
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector, Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Extrapolation,
  FadeInUp,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import AdBanner from '../../components/AdBanner';
import SmartLogLine, { ClarificationBlock, ClarificationOption, ParsedNutrition, ResolveResult } from '../../components/nutrition/SmartLogLine';
import { SkeletonBlock, useSkeletonPulse } from '../../components/ui/Skeleton';
import EmptyState from '../../components/ui/EmptyState';
import { TAB_BAR_CLEARANCE } from '../../constants/layout';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { useProGate } from '../../hooks/useProGate';
import { FREE_TIER_LIMITS, useUserQuota } from '../../hooks/useUserQuota';
import QuotaPill from '../../components/QuotaPill';
import FirstVisitHint from '../../components/FirstVisitHint';
import { backendClient, isQuotaExceededError, QuotaExceededError } from '../../src/api/backendClient';
import QuotaLimitSheet from '../../components/QuotaLimitSheet';
import ProLockBadge from '../../components/ProLockBadge';
import { useNutritionGoals } from '../../stores/useNutritionGoals';
import { usePhotoLogHandoff } from '../../stores/usePhotoLogHandoff';
import { supabase } from '../../utils/supabase';
import { Image as ExpoImage } from 'expo-image';

// Pro upsell nudge: once dismissed we hide it for this long, then let it
// resurface so it stays a gentle reminder rather than a permanent fixture.
const PRO_NUDGE_DISMISS_KEY = '@pro_nudge_dismissed_at';
const PRO_NUDGE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ── Types ──────────────────────────────────────────────────────────────────────

type NutritionLogRow = {
  id: string;
  user_id: string;
  date: string;
  raw_text: string;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  vitamin_a_mcg: number | null;
  vitamin_c_mg: number | null;
  calcium_mg: number | null;
  iron_mg: number | null;
  created_at: string;
  /** Provenance: 'text' | 'barcode' | 'photo' (older rows may predate it). */
  source?: string | null;
  /** Photo logs only: storage path in the private meal-photos bucket. */
  image_path?: string | null;
  /** Photo logs only: itemized Plate-card breakdown. */
  items?: unknown[] | null;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const VITAMIN_REFS = {
  vitamin_a: { label: 'Vitamin A', unit: 'mcg', color: '#2E90FA' },
  vitamin_c: { label: 'Vitamin C', unit: 'mg', color: '#5AA6FF' },
  calcium: { label: 'Calcium', unit: 'mg', color: '#8FBFFC' },
  iron: { label: 'Iron', unit: 'mg', color: '#1A6FE0' },
} as const;

// Header collapsed/expanded heights. We animate `expandRatio` (0–1) between them.
// Both include `paddingBottom: 44` baked into the headerCard for drag-handle
// clearance, so the *visible* content area is roughly height - 44.
// 188 (was 204): the collapsed content was re-laid-out to fit tighter (logo
// inline with week nav, 72pt ring) — the saved height goes to the food list.
const HEADER_COLLAPSED = 188;
// First-paint estimate only. The real expanded height is measured from the
// content via onLayout (see `expandedHeight`) so macros/micros never clip,
// regardless of device size or Dynamic Type scaling.
const HEADER_EXPANDED = 396;
// When the keyboard is up the list viewport is tiny, so the header shrinks to
// a slim one-line summary (date + kcal remaining) to give the space back.
const HEADER_MINIMIZED = 64;

const AnimatedText = Animated.createAnimatedComponent(Text);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// Real Apple Liquid Glass (UIGlassEffect) is only available on iOS 26+ builds;
// everywhere else the logger keeps the expo-blur GlassFill approximation.
const HAS_NATIVE_GLASS = isLiquidGlassAvailable();

function NutritionSkeleton({ isDark }: { isDark: boolean }) {
  const pulse = useSkeletonPulse();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
      <SkeletonBlock width="100%" height={HEADER_COLLAPSED} radius={24} pulse={pulse} isDark={isDark} style={{ marginBottom: 16 }} />
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonBlock key={i} width="100%" height={64} radius={16} pulse={pulse} isDark={isDark} style={{ marginBottom: 12 }} />
      ))}
    </View>
  );
}

// Local-date ISO (YYYY-MM-DD). Must NOT use toISOString(), which converts to
// UTC and rolls the date back a day in timezones ahead of UTC — that shifted
// the whole day strip off by one (e.g. the "17" cell queried the 16th).
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string {
  return localDateStr(new Date());
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function getWeekDays(weekOffset: number = 0) {
  const today = new Date();
  const todayIso = todayStr();
  const dayOfWeek = today.getDay();
  const diff = (dayOfWeek + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - diff + weekOffset * 7);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = localDateStr(d);
    return {
      iso,
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      dayNum: String(d.getDate()),
      isToday: iso === todayIso,
      isFuture: iso > todayIso,
    };
  });
}

type MealBucket = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

const MEAL_BUCKET_META: Record<MealBucket, { title: string; icon: keyof typeof Ionicons.glyphMap; order: number }> = {
  breakfast: { title: 'Breakfast', icon: 'sunny-outline', order: 0 },
  lunch: { title: 'Lunch', icon: 'restaurant-outline', order: 1 },
  dinner: { title: 'Dinner', icon: 'moon-outline', order: 2 },
  snacks: { title: 'Snacks', icon: 'cafe-outline', order: 3 },
};

function bucketForLog(log: NutritionLogRow): MealBucket {
  const hour = new Date(log.created_at).getHours();
  if (hour >= 5 && hour <= 10) return 'breakfast';
  if (hour >= 11 && hour <= 15) return 'lunch';
  if (hour >= 16 && hour <= 21) return 'dinner';
  return 'snacks';
}

function groupLogsByMeal(
  logs: NutritionLogRow[]
): { bucket: MealBucket; title: string; icon: keyof typeof Ionicons.glyphMap; data: NutritionLogRow[]; totalKcal: number }[] {
  const map = new Map<MealBucket, NutritionLogRow[]>();
  for (const log of logs) {
    const b = bucketForLog(log);
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(log);
  }
  return Array.from(map.entries())
    .map(([bucket, data]) => ({
      bucket,
      title: MEAL_BUCKET_META[bucket].title,
      icon: MEAL_BUCKET_META[bucket].icon,
      data,
      totalKcal: data.reduce((s, l) => s + l.calories, 0),
    }))
    .sort((a, b) => MEAL_BUCKET_META[a.bucket].order - MEAL_BUCKET_META[b.bucket].order);
}

function formatWeekRange(weekDays: ReturnType<typeof getWeekDays>): string {
  const first = new Date(weekDays[0].iso + 'T00:00:00');
  const last = new Date(weekDays[6].iso + 'T00:00:00');
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (first.getMonth() === last.getMonth()) {
    return `${first.toLocaleDateString('en-US', opts)} – ${last.getDate()}`;
  }
  return `${first.toLocaleDateString('en-US', opts)} – ${last.toLocaleDateString('en-US', opts)}`;
}

// ── Liquid-glass background layer ────────────────────────────────────────────
// Drop this as the first (absolute) child of any clipped, rounded container to
// turn it into a frosted "liquid glass" surface: expo-blur + a translucent base
// fill (so it stays legible where blur degrades) + a top-light sheen + an
// optional brand-tinted glow.
function GlassFill({
  isDark,
  primary,
  tinted,
}: {
  isDark: boolean;
  primary: string;
  tinted?: boolean;
}) {
  const fill = isDark ? 'rgba(20,22,30,0.55)' : 'rgba(255,255,255,0.55)';
  const sheen: readonly [string, string] = isDark
    ? ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)']
    : ['rgba(255,255,255,0.70)', 'rgba(255,255,255,0.22)'];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <BlurView
        intensity={isDark ? 40 : 55}
        tint={isDark ? 'dark' : 'light'}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
        style={StyleSheet.absoluteFill}
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
        <LinearGradient
          colors={sheen}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {tinted && (
          <LinearGradient
            colors={[primary + '24', primary + '00']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        )}
      </BlurView>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function NutritionScreen() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();

  // The native tab bar floats over content, so the pinned logger input needs
  // the bottom safe-area inset (which includes the tab bar) when the keyboard
  // is hidden; when the keyboard is up it covers the tab bar, so drop it.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const { session, loading: authLoading } = useRequireAuth();
  const userId = session?.user?.id;
  const queryClient = useQueryClient();
  const proGate = useProGate();
  const router = useRouter();
  const { tier: quotaTier, mealsRemaining, nextResetAt, refetch: refetchQuota } = useUserQuota();

  const { calorieGoal, proteinGoal, carbsGoal, fatsGoal, isCustom, loadGoalsForUser, saveCustomGoals, resetToRecommended } =
    useNutritionGoals();

  // Hydrate personalized goals from the user's onboarding profile (or their
  // saved override) the moment we know who they are.
  useEffect(() => {
    if (userId) void loadGoalsForUser(userId);
  }, [userId, loadGoalsForUser]);

  // Re-pull on focus so a calorie/macro change made in chat (which writes the
  // same nutrition_goals row) is reflected when the user returns to this tab.
  useFocusEffect(
    useCallback(() => {
      if (userId) void loadGoalsForUser(userId, true);
    }, [userId, loadGoalsForUser])
  );

  const [weekOffset, setWeekOffset] = useState(0);
  const weekDays = useMemo(() => getWeekDays(weekOffset), [weekOffset]);
  const weekStart = weekDays[0].iso;
  const weekEnd = weekDays[6].iso;

  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [inputResetKey, setInputResetKey] = useState(0);
  const [quotaError, setQuotaError] = useState<QuotaExceededError | null>(null);
  const [animatedTotalLabel, setAnimatedTotalLabel] = useState('0');
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  // Holds a pending clarification produced by the most recent log. Renders as
  // pills attached to the matching list row. Cleared when the user picks an
  // option or submits a new log.
  const [pendingClarification, setPendingClarification] = useState<{
    logId: string;
    clarification: ClarificationBlock;
  } | null>(null);

  const inputRef = useRef<TextInput>(null);
  const goalsSheetRef = useRef<BottomSheetModal>(null);
  const [goalDraft, setGoalDraft] = useState({
    cal: calorieGoal,
    prot: proteinGoal,
    carbs: carbsGoal,
    fats: fatsGoal,
  });

  // Pro nudge dismissal — hidden during the cooldown window after the user
  // taps the , then automatically shown again.
  const [proNudgeDismissed, setProNudgeDismissed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PRO_NUDGE_DISMISS_KEY);
        const dismissedAt = raw ? parseInt(raw, 10) : 0;
        const stillHidden =
          !!dismissedAt && Date.now() - dismissedAt < PRO_NUDGE_COOLDOWN_MS;
        if (!cancelled) setProNudgeDismissed(stillHidden);
      } catch {
        if (!cancelled) setProNudgeDismissed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissProNudge = useCallback(async () => {
    setProNudgeDismissed(true);
    try {
      await AsyncStorage.setItem(PRO_NUDGE_DISMISS_KEY, String(Date.now()));
    } catch {
      // Non-fatal — worst case the nudge reappears on next launch.
    }
  }, []);

  // ── Daily logs query ─────────────────────────────────────────────────────────

  const { data: logs = [], isLoading: logsLoading } = useQuery<NutritionLogRow[]>({
    queryKey: ['nutrition_logs', userId, selectedDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nutrition_logs')
        .select('*')
        .eq('user_id', userId!)
        .eq('date', selectedDate)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as NutritionLogRow[];
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  const { data: weekLogs = [] } = useQuery<NutritionLogRow[]>({
    queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nutrition_logs')
        .select('id,date,calories,protein,carbs,fats,user_id')
        .eq('user_id', userId!)
        .gte('date', weekStart)
        .lte('date', weekEnd);
      if (error) throw error;
      return (data ?? []) as NutritionLogRow[];
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  // ── Derived data ─────────────────────────────────────────────────────────────

  const weeklyCalories = useMemo(() => {
    const map: Record<string, number> = {};
    for (const log of weekLogs) {
      map[log.date] = (map[log.date] ?? 0) + log.calories;
    }
    return map;
  }, [weekLogs]);

  const totals = useMemo(
    () => ({
      calories: logs.reduce((s, l) => s + l.calories, 0),
      protein: logs.reduce((s, l) => s + l.protein, 0),
      carbs: logs.reduce((s, l) => s + l.carbs, 0),
      fats: logs.reduce((s, l) => s + l.fats, 0),
      vitamin_a: logs.reduce((s, l) => s + (l.vitamin_a_mcg ?? 0), 0),
      vitamin_c: logs.reduce((s, l) => s + (l.vitamin_c_mg ?? 0), 0),
      calcium: logs.reduce((s, l) => s + (l.calcium_mg ?? 0), 0),
      iron: logs.reduce((s, l) => s + (l.iron_mg ?? 0), 0),
    }),
    [logs]
  );

  // ── Animations ───────────────────────────────────────────────────────────────

  const animatedTotal = useSharedValue(0);
  const animatedCalorieRatio = useSharedValue(0);

  // Header expand: 0 = compact (calories only), 1 = expanded (macros + micros).
  const expandRatio = useSharedValue(0);
  const dragStart = useSharedValue(0);

  // Keyboard minimize: 0 = normal header, 1 = slim summary bar.
  const kbProgress = useSharedValue(0);
  useEffect(() => {
    kbProgress.value = withTiming(keyboardVisible ? 1 : 0, { duration: 220 });
    if (keyboardVisible) expandRatio.value = withTiming(0, { duration: 220 });
  }, [keyboardVisible, kbProgress, expandRatio]);

  useEffect(() => {
    animatedTotal.value = withTiming(totals.calories, { duration: 900 });
    animatedCalorieRatio.value = withTiming(
      Math.min(totals.calories / Math.max(calorieGoal, 1), 1),
      { duration: 900 }
    );
  }, [totals.calories, calorieGoal]);

  useAnimatedReaction(
    () => Math.round(animatedTotal.value),
    (value) => runOnJS(setAnimatedTotalLabel)(`${value}`)
  );

  // 72 (was 88): with the fixed collapsed header height, the bigger ring's
  // row rode into the drag-handle clearance; smaller ring + tighter strip
  // buys the whole summary back plus a shorter header overall.
  const ringSize = 72;
  const ringStroke = 7;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;

  const ringAnimatedProps = useAnimatedProps(() => ({
    strokeDashoffset: ringCircumference * (1 - animatedCalorieRatio.value),
  }));

  // Expanded height is measured from the real content (onHeaderContentLayout)
  // so the macros + micros always fit — a fixed height clipped them at the
  // bottom on shorter screens / larger text. HEADER_EXPANDED is just the
  // first-paint estimate before measurement lands.
  const [expandedHeight, setExpandedHeight] = useState(HEADER_EXPANDED);
  const onHeaderContentLayout = useCallback((e: LayoutChangeEvent) => {
    // The measured child excludes the card's own padding, so add it back:
    // +4 (paddingTop beyond the safe-area inset) + 44 (paddingBottom that
    // clears the drag handle).
    const needed = Math.ceil(e.nativeEvent.layout.height) + 48;
    setExpandedHeight((prev) => (Math.abs(prev - needed) > 1 ? needed : prev));
  }, []);

  // ── Header gesture ───────────────────────────────────────────────────────────
  // Drag down on the header to reveal macros + micros. Snap to 0 or 1 on
  // release based on travel distance.
  const dragRange = expandedHeight - HEADER_COLLAPSED;
  const headerPan = Gesture.Pan()
    .activeOffsetY([-12, 12])
    .onStart(() => {
      dragStart.value = expandRatio.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value + e.translationY / dragRange;
      expandRatio.value = Math.min(1, Math.max(0, next));
    })
    .onEnd((e) => {
      const projected = expandRatio.value + (e.velocityY / dragRange) * 0.18;
      const snapTo = projected > 0.5 ? 1 : 0;
      // Plain timing — no bounce on snap.
      expandRatio.value = withTiming(snapTo, { duration: 240 });
    });

  // The header card *is* the dark surface — no separate background rectangle.
  // It paints from y=0 (above the status bar) all the way down to its rounded
  // bottom edge. Total height = status-bar inset + content height.
  const headerAnimatedStyle = useAnimatedStyle(() => {
    const fullHeight = insets.top + HEADER_COLLAPSED + expandRatio.value * dragRange;
    const minHeight = insets.top + HEADER_MINIMIZED;
    return { height: fullHeight + (minHeight - fullHeight) * kbProgress.value };
  }, [insets.top, dragRange]);

  // Normal header content fades out quickly as the keyboard minimizes the
  // header; the slim summary row fades in after, so they never overlap.
  const headerContentFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(kbProgress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
  }));

  const minimizedFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(kbProgress.value, [0.6, 1], [0, 1], Extrapolation.CLAMP),
  }));

  const expandedFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expandRatio.value, [0, 0.5, 1], [0, 0, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(expandRatio.value, [0, 1], [12, 0], Extrapolation.CLAMP) },
    ],
  }));

  const toggleExpand = useCallback(() => {
    expandRatio.value = withTiming(expandRatio.value > 0.5 ? 0 : 1, { duration: 240 });
  }, [expandRatio]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const parseNutritionAndPersist = async (rawText: string): Promise<ResolveResult> => {
    if (!session?.user?.id) throw new Error('Session required');
    // Client-side pre-gate: at 0 free AI meal logs the server is guaranteed to
    // 429, so open the quota sheet immediately instead of burning a round trip.
    // The thrown error keeps SmartLogLine's text intact (its catch reverts to
    // 'typing'). Server-side quotaGate stays the source of truth.
    if (quotaTier === 'ad_supported' && mealsRemaining === 0) {
      posthog.capture('meal_log_blocked_client_quota');
      router.push({
        pathname: '/quota-limit',
        params: { feature: 'nutrition_ai', reason: 'meal_limit' },
      });
      throw new Error('Daily free AI meal log used');
    }
    try {
      // Clear any previous pending clarification — only the newest log gets pills.
      setPendingClarification(null);
      const response = await backendClient.logNutrition({ raw_text: rawText, date: selectedDate });
      // The server consumed the day's allowance pre-flight — sync the pill.
      void refetchQuota();
      if (!response.success || !response.parsed || !response.log) {
        throw new Error(response.error || 'Failed to parse nutrition log.');
      }
      queryClient.invalidateQueries({ queryKey: ['nutrition_logs', userId, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd] });
      if (response.clarification) {
        setPendingClarification({ logId: response.log.id, clarification: response.clarification });
      }
      return {
        logId: response.log.id,
        parsed: {
          calories: response.parsed.calories,
          protein: response.parsed.protein,
          carbs: response.parsed.carbs,
          fats: response.parsed.fats,
        },
        clarification: response.clarification ?? null,
      };
    } catch (err) {
      if (isQuotaExceededError(err)) {
        setQuotaError(err);
        void refetchQuota();
      }
      throw err;
    }
  };

  /**
   * Barcode logs with exact Open Food Facts macros persist deterministically:
   * no LLM parse, no daily AI-meal quota, no clarification pills. Free-tier
   * barcode logging is unlimited by design — so no pre-gate and no
   * refetchQuota here (nothing was consumed).
   */
  const logBarcodeAndPersist = async (payload: {
    rawText: string;
    macros: { calories: number; protein: number; carbs: number; fats: number };
  }): Promise<ResolveResult> => {
    if (!session?.user?.id) throw new Error('Session required');
    setPendingClarification(null);
    const response = await backendClient.logNutritionStructured({
      raw_text: payload.rawText,
      ...payload.macros,
      date: selectedDate,
    });
    if (!response.success || !response.parsed || !response.log) {
      throw new Error(response.error || 'Failed to save barcode log.');
    }
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs', userId, selectedDate] });
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd] });
    return {
      logId: response.log.id,
      parsed: {
        calories: response.parsed.calories,
        protein: response.parsed.protein,
        carbs: response.parsed.carbs,
        fats: response.parsed.fats,
      },
      clarification: null,
    };
  };

  const applyClarification = async (
    logId: string,
    option: ClarificationOption
  ): Promise<ParsedNutrition> => {
    const response = await backendClient.clarifyNutritionLog(logId, option);
    if (!response.success || !response.log) {
      throw new Error(response.error || 'Failed to apply clarification.');
    }
    setPendingClarification(null);
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs', userId, selectedDate] });
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd] });
    return {
      calories: response.log.calories,
      protein: response.log.protein,
      carbs: response.log.carbs,
      fats: response.log.fats,
    };
  };

  const updateLogRawText = async (logId: string, rawText: string) => {
    try {
      const response = await backendClient.updateNutritionLog(logId, rawText);
      if (!response.success) {
        throw new Error(response.error || 'Failed to update log');
      }
      queryClient.invalidateQueries({ queryKey: ['nutrition_logs', userId, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd] });
    } catch (err) {
      if (isQuotaExceededError(err)) setQuotaError(err);
      throw err;
    }
  };

  const deleteLog = async (logId: string) => {
    await backendClient.deleteNutritionLog(logId);
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs', userId, selectedDate] });
    queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week', userId, weekStart, weekEnd] });
  };

  const handleLineResolved = () => {
    setInputResetKey((k) => k + 1);
  };

  /**
   * Photo meal logging entry point. Same client-side quota pre-gate as the
   * typed path — don't let users take a photo they can't use. The camera
   * route itself handles the server 429 as the source of truth.
   */
  // PostHog rollout flag (mirrors the paywall_config pattern): explicit false
  // hides the camera entry point; missing/undefined stays visible so dev
  // builds and PostHog outages never hide the feature.
  const photoLoggingOff = posthog.getFeatureFlag('photo_meal_logging') === false;

  const openPhotoLog = useCallback(() => {
    if (quotaTier === 'ad_supported' && mealsRemaining === 0) {
      posthog.capture('meal_photo_blocked_client_quota');
      router.push({
        pathname: '/quota-limit',
        params: { feature: 'nutrition_ai', reason: 'meal_limit' },
      });
      return;
    }
    setPendingClarification(null);
    router.push({ pathname: '/nutrition/photo-log', params: { date: selectedDate } });
  }, [quotaTier, mealsRemaining, router, selectedDate]);

  // Photo logs confirmed on the camera route hand their un-fixed
  // clarification back through a one-shot store; attach it to the new row so
  // the pills render exactly like typed logs.
  useFocusEffect(
    useCallback(() => {
      const handoff = usePhotoLogHandoff.getState().consume();
      if (handoff) {
        setPendingClarification({ logId: handoff.logId, clarification: handoff.clarification });
      }
      // Quota pill may have changed while the camera route consumed a scan.
      void refetchQuota();
    }, [refetchQuota])
  );

  const openGoalsSheet = useCallback(() => {
    setGoalDraft({ cal: calorieGoal, prot: proteinGoal, carbs: carbsGoal, fats: fatsGoal });
    goalsSheetRef.current?.present();
  }, [calorieGoal, proteinGoal, carbsGoal, fatsGoal]);

  const saveGoals = () => {
    if (userId) {
      void saveCustomGoals(userId, {
        calorieGoal: goalDraft.cal,
        proteinGoal: goalDraft.prot,
        carbsGoal: goalDraft.carbs,
        fatsGoal: goalDraft.fats,
      });
    }
    goalsSheetRef.current?.dismiss();
  };

  const handleResetGoals = () => {
    if (userId) void resetToRecommended(userId);
    goalsSheetRef.current?.dismiss();
  };

  const goToPrevWeek = useCallback(() => {
    setWeekOffset((o) => {
      const newOffset = o - 1;
      const days = getWeekDays(newOffset);
      const today = todayStr();
      const pastDays = days.filter((d) => d.iso <= today);
      setSelectedDate(pastDays.length > 0 ? pastDays[pastDays.length - 1].iso : days[0].iso);
      return newOffset;
    });
  }, []);

  const goToNextWeek = useCallback(() => {
    setWeekOffset((o) => {
      if (o >= 0) return o;
      const newOffset = o + 1;
      const days = getWeekDays(newOffset);
      const today = todayStr();
      if (newOffset === 0) setSelectedDate(today);
      else setSelectedDate(days[0].iso);
      return newOffset;
    });
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />
    ),
    []
  );

  // ── Sub-renders ───────────────────────────────────────────────────────────────

  const macroRows = [
    { label: 'Protein', value: totals.protein, goal: proteinGoal, color: colors.primary, unit: 'g' },
    { label: 'Carbs', value: totals.carbs, goal: carbsGoal, color: '#5AA6FF', unit: 'g' },
    { label: 'Fats', value: totals.fats, goal: fatsGoal, color: '#9CA3AF', unit: 'g' },
  ] as const;

  const caloriesRemaining = calorieGoal - totals.calories;
  const isOverCalories = caloriesRemaining < 0;
  const sections = useMemo(() => groupLogsByMeal(logs), [logs]);
  const trackColor = isDark ? colors.borderDark : colors.borderLight;

  const vitamins = [
    { key: 'vitamin_a' as const, value: totals.vitamin_a },
    { key: 'vitamin_c' as const, value: totals.vitamin_c },
    { key: 'calcium' as const, value: totals.calcium },
    { key: 'iron' as const, value: totals.iron },
  ];

  // ── Auth loading ──────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <NutritionSkeleton isDark={isDark} />
      </SafeAreaView>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <BottomSheetModalProvider>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <GestureDetector gesture={headerPan}>
          <Animated.View
            style={[
              styles.headerCard,
              {
                backgroundColor: 'transparent',
                borderBottomColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(11,18,32,0.08)',
                paddingTop: insets.top + 4,
              },
              headerAnimatedStyle,
            ]}
          >
              {/* Liquid-glass frosted backdrop */}
              <GlassFill isDark={isDark} primary={colors.primary} tinted />

              {/* Slim summary shown while the keyboard minimizes the header */}
              <Animated.View
                pointerEvents="none"
                style={[styles.minimizedRow, { top: insets.top }, minimizedFadeStyle]}
              >
                <Text style={[styles.minimizedDate, { color: colors.textTertiary }]}>
                  {selectedDate === todayStr() ? 'Today' : formatDate(selectedDate)}
                </Text>
                <Text
                  style={[
                    styles.minimizedKcal,
                    { color: isOverCalories ? colors.warning : colors.text },
                  ]}
                >
                  {Math.abs(caloriesRemaining)}
                  <Text style={[styles.minimizedKcalUnit, { color: colors.textTertiary }]}>
                    {' '}
                    kcal {isOverCalories ? 'over' : 'left'}
                  </Text>
                </Text>
              </Animated.View>

              <Animated.View
                style={headerContentFadeStyle}
                pointerEvents={keyboardVisible ? 'none' : 'auto'}
                onLayout={onHeaderContentLayout}
              >
              {/* Brand + week navigation share ONE row — a stacked logo added
                  ~32pt to a fixed-height collapsed header and cropped the
                  calorie summary off the bottom. */}
              <View style={styles.brandNavRow}>
                <ExpoImage
                  source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
                  style={styles.headerLogo}
                  contentFit="contain"
                />
                <View style={styles.weekNavGroup}>
                  <Pressable onPress={goToPrevWeek} hitSlop={12} style={styles.weekNavBtn}>
                    <Ionicons name="chevron-back" size={20} color={colors.textMuted} />
                  </Pressable>
                  <Text style={[styles.weekRangeText, { color: colors.textMuted }]}>
                    {weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : formatWeekRange(weekDays)}
                  </Text>
                  <Pressable
                    onPress={goToNextWeek}
                    hitSlop={12}
                    style={[styles.weekNavBtn, weekOffset >= 0 && styles.weekNavBtnDisabled]}
                    disabled={weekOffset >= 0}
                  >
                    <Ionicons name="chevron-forward" size={20} color={weekOffset >= 0 ? 'transparent' : colors.textMuted} />
                  </Pressable>
                </View>
              </View>

              {/* Week day strip */}
              <View style={styles.weekStrip}>
                {weekDays.map((day) => {
                  const dayCals = weeklyCalories[day.iso] ?? 0;
                  const ratio = Math.min(dayCals / Math.max(calorieGoal, 1), 1);
                  const isSelected = selectedDate === day.iso;
                  const hasData = dayCals > 0;
                  const dotColor = hasData
                    ? ratio >= 1
                      ? colors.success
                      : colors.primary
                    : trackColor;

                  return (
                    <Pressable
                      key={day.iso}
                      style={[
                        styles.dayCol,
                        isSelected && {
                          backgroundColor: isDark ? colors.backgroundTertiary : '#FFFFFF',
                          borderColor: colors.primary,
                          borderWidth: 1.5,
                        },
                        day.isFuture && { opacity: 0.3 },
                      ]}
                      onPress={() => !day.isFuture && setSelectedDate(day.iso)}
                      disabled={day.isFuture}
                      accessibilityLabel={`${day.label} ${day.dayNum}${isSelected ? ', selected' : ''}`}
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.dayLabel,
                          { color: isSelected ? colors.text : colors.textTertiary },
                        ]}
                      >
                        {day.label.charAt(0)}
                      </Text>
                      <Text style={[styles.dayNum, { color: colors.text }]}>{day.dayNum}</Text>
                      <View style={[styles.dayDot, { backgroundColor: dotColor }]} />
                    </Pressable>
                  );
                })}
              </View>

              {/* Compact calorie summary */}
              <View style={styles.compactCalorieRow}>
                <View style={styles.compactRingWrap}>
                  <Svg width={ringSize} height={ringSize}>
                    <Circle
                      cx={ringSize / 2}
                      cy={ringSize / 2}
                      r={ringRadius}
                      stroke={trackColor}
                      strokeWidth={ringStroke}
                      fill="none"
                    />
                    <AnimatedCircle
                      animatedProps={ringAnimatedProps}
                      cx={ringSize / 2}
                      cy={ringSize / 2}
                      r={ringRadius}
                      stroke={isOverCalories ? colors.warning : colors.primary}
                      strokeWidth={ringStroke}
                      strokeLinecap="round"
                      fill="none"
                      strokeDasharray={`${ringCircumference} ${ringCircumference}`}
                      transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
                    />
                  </Svg>
                  <View style={styles.compactRingCenter}>
                    <AnimatedText style={[styles.compactKcal, { color: colors.text }]}>
                      {animatedTotalLabel}
                    </AnimatedText>
                    <Text style={[styles.compactKcalUnit, { color: colors.textTertiary }]}>
                      / {calorieGoal}
                    </Text>
                  </View>
                </View>

                <View style={styles.compactInfo}>
                  <Text style={[styles.compactDateLabel, { color: colors.textTertiary }]}>
                    {selectedDate === todayStr() ? 'Today' : formatDate(selectedDate)}
                  </Text>
                  <Text
                    style={[
                      styles.compactSubLabel,
                      { color: isOverCalories ? colors.warning : colors.text },
                    ]}
                  >
                    {Math.abs(caloriesRemaining)}
                    <Text style={[styles.compactSubLabelUnit, { color: colors.textTertiary }]}>
                      {' '}
                      kcal {isOverCalories ? 'over' : 'left'}
                    </Text>
                  </Text>
                  <Pressable
                    onPress={openGoalsSheet}
                    hitSlop={8}
                    style={styles.editGoalsInline}
                    accessibilityRole="button"
                    accessibilityLabel="Edit daily goals"
                  >
                    <Ionicons name="create-outline" size={13} color={colors.textTertiary} />
                    <Text style={[styles.editGoalsText, { color: colors.textTertiary }]}>
                      Edit goals
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* Expanded content (macros + micros). Fades in as user pulls down. */}
              <Animated.View style={[styles.expandedSection, expandedFadeStyle]} pointerEvents="box-none">
                <View style={styles.macroColumn}>
                  {macroRows.map((macro) => {
                    const ratio = Math.min(macro.value / Math.max(macro.goal, 1), 1);
                    return (
                      <View
                        key={macro.label}
                        style={[
                          styles.macroRow,
                          {
                            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <View style={styles.macroHeader}>
                          <Text style={[styles.macroLabel, { color: colors.textMuted }]}>
                            {macro.label}
                          </Text>
                          <Text style={[styles.macroValue, { color: colors.text }]}>
                            {macro.value}/{macro.goal}{macro.unit}
                          </Text>
                        </View>
                        <View style={[styles.macroTrack, { backgroundColor: trackColor }]}>
                          <View
                            style={[
                              styles.macroFill,
                              { backgroundColor: macro.color, width: `${Math.max(2, ratio * 100)}%` },
                            ]}
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>

                <View style={styles.vitaminRow}>
                  {vitamins.map(({ key, value }) => {
                    const ref = VITAMIN_REFS[key];
                    return (
                      <View key={key} style={styles.vitaminItem}>
                        <View style={[styles.vitaminDot, { backgroundColor: ref.color }]} />
                        <Text style={[styles.vitaminItemLabel, { color: colors.textMuted }]}>
                          {ref.label}
                        </Text>
                        <Text style={[styles.vitaminItemValue, { color: colors.text }]}>
                          {value}
                          <Text style={{ color: colors.textMuted, fontSize: 10 }}>{ref.unit}</Text>
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </Animated.View>
              </Animated.View>

              {/* Drag handle — chevron rotates to indicate expanded state. */}
              <Animated.View
                style={[styles.dragHandleWrap, headerContentFadeStyle]}
                pointerEvents={keyboardVisible ? 'none' : 'box-none'}
              >
                <Pressable
                  onPress={toggleExpand}
                  hitSlop={16}
                  style={styles.dragHandleHit}
                  accessibilityRole="button"
                  accessibilityLabel="Toggle macro details"
                >
                  <View style={[styles.dragBar, { backgroundColor: colors.textTertiary, opacity: 0.5 }]} />
                </Pressable>
              </Animated.View>
            </Animated.View>
          </GestureDetector>

          {/* Body. Explicit background masks the dark top band so the meal
              list sits cleanly below the header even when scrolled. */}
          <KeyboardAvoidingView
            style={[styles.body, { backgroundColor: colors.background }]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            // No vertical offset: this view's bottom edge is measured in
            // window coordinates already (the tab bar sits below it), so any
            // extra offset over-pads and leaves a dead gap above the keyboard.
            keyboardVerticalOffset={0}
          >
            <SectionList
              sections={sections}
              keyExtractor={(item) => item.id}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.listContent}
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => (
                <View style={styles.sectionHeader}>
                  <Ionicons name={section.icon} size={14} color={colors.textTertiary} />
                  <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                    {section.title}
                  </Text>
                  <View style={[styles.sectionDivider, { backgroundColor: colors.border }]} />
                  <Text style={[styles.sectionKcal, { color: colors.textTertiary }]}>
                    {section.totalKcal} kcal
                  </Text>
                </View>
              )}
              ListEmptyComponent={
                logsLoading ? null : (
                  <EmptyState
                    icon="restaurant-outline"
                    headline="Nothing logged yet"
                    sub="Type what you ate below — even rough is fine."
                  />
                )
              }
              ListFooterComponent={
                // No ad while typing (tiny viewport, mid-task) or on an empty
                // day (a new user's first impression shouldn't be an ad).
                !keyboardVisible && logs.length > 0 ? (
                  <View style={styles.footerWrap}>
                    <View style={[styles.footerDivider, { backgroundColor: colors.border }]} />
                    <AdBanner />
                  </View>
                ) : null
              }
              renderItem={({ item, index }) => (
                <Animated.View entering={FadeInUp.delay(index * 40).duration(320)}>
                  <EditableLogRow
                    row={item}
                    isEditing={editingLogId === item.id}
                    onStartEdit={() => setEditingLogId(item.id)}
                    onCancelEdit={() => setEditingLogId(null)}
                    onSaveEdit={async (text) => {
                      await updateLogRawText(item.id, text);
                      setEditingLogId(null);
                    }}
                    onDelete={() => deleteLog(item.id)}
                    clarification={
                      pendingClarification && pendingClarification.logId === item.id
                        ? pendingClarification.clarification
                        : null
                    }
                    onClarify={(option) => applyClarification(item.id, option)}
                    onOpenPlate={
                      item.source === 'photo' && Array.isArray(item.items) && item.items.length > 0
                        ? () =>
                            router.push({
                              pathname: '/nutrition/photo-log',
                              params: { logId: item.id },
                            })
                        : undefined
                    }
                  />
                </Animated.View>
              )}
            />

            {/* Input pinned BELOW the list (outside the scroll content) so the
                KeyboardAvoidingView keeps it glued above the keyboard. Living
                inside the list footer made it scroll away and let iOS yank the
                whole list when the field focused. */}
            <View
              style={[
                styles.inputWrap,
                { paddingBottom: keyboardVisible ? 10 : 10 + insets.bottom + TAB_BAR_CLEARANCE },
              ]}
            >
              {!proGate.isPro && !proNudgeDismissed && (
                <Pressable
                  onPress={() => proGate.showPaywall('nutrition_ai')}
                  style={({ pressed }) => [
                    styles.proNudge,
                    {
                      borderColor: colors.primary + '40',
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Upgrade to Pro for smarter AI logging"
                >
                  <GlassFill isDark={isDark} primary={colors.primary} tinted />
                  <ProLockBadge label="Pro" />
                  <Text style={[styles.proNudgeText, { color: colors.text }]}>
                    For smarter AI logging, upgrade to Pro
                  </Text>
                  <Pressable
                    onPress={dismissProNudge}
                    hitSlop={10}
                    style={styles.proNudgeClose}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss this reminder"
                  >
                    <Ionicons name="close" size={16} color={colors.textTertiary} />
                  </Pressable>
                </Pressable>
              )}
              {/* One-time orientation hint (first visit only) */}
              <FirstVisitHint
                hintKey="nutrition"
                text="Just type what you ate — “2 eggs and toast” — and the AI counts calories and macros."
              />
              {/* Photo logging launch hint — points at the camera button */}
              {!photoLoggingOff && (
                <FirstVisitHint
                  hintKey="nutrition_photo"
                  text="New: snap a photo of your meal — tap the camera and the AI itemizes it."
                />
              )}

              {/* Free-tier allowance counter — countable scarcity next to the feature. */}
              {quotaTier === 'ad_supported' && mealsRemaining != null && (
                <View style={{ paddingBottom: 8 }}>
                  <QuotaPill
                    remaining={mealsRemaining}
                    limit={FREE_TIER_LIMITS.meals}
                    noun="AI meal log"
                    resetAt={nextResetAt}
                    onUpgrade={() => proGate.showPaywall('nutrition_ai')}
                    isDark={isDark}
                  />
                </View>
              )}
              <View style={[styles.loggerGlow, { shadowColor: colors.primary }]}>
                {HAS_NATIVE_GLASS ? (
                  // Native Liquid Glass: the system draws its own lensed edge
                  // and highlight, so no border or GlassFill underlay here.
                  <GlassView
                    style={styles.loggerCardNative}
                    glassEffectStyle="regular"
                    colorScheme={isDark ? 'dark' : 'light'}
                    isInteractive
                  >
                    <SmartLogLine
                      key={inputResetKey}
                      ref={inputRef}
                      placeholder={logs.length === 0 ? 'Log your first meal…' : 'Log a meal…'}
                      onResolve={parseNutritionAndPersist}
                      onResolveBarcode={logBarcodeAndPersist}
                      onResolved={handleLineResolved}
                      onCameraPress={photoLoggingOff ? undefined : openPhotoLog}
                    />
                  </GlassView>
                ) : (
                  <View
                    style={[
                      styles.loggerCard,
                      { borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(11,18,32,0.10)' },
                    ]}
                  >
                    <GlassFill isDark={isDark} primary={colors.primary} />
                    <SmartLogLine
                      key={inputResetKey}
                      ref={inputRef}
                      placeholder={logs.length === 0 ? 'Log your first meal…' : 'Log a meal…'}
                      onResolve={parseNutritionAndPersist}
                      onResolveBarcode={logBarcodeAndPersist}
                      onResolved={handleLineResolved}
                      onCameraPress={photoLoggingOff ? undefined : openPhotoLog}
                    />
                  </View>
                )}
              </View>
            </View>
          </KeyboardAvoidingView>
      </View>

      {/* Goals bottom sheet — uses BottomSheetTextInput so the keyboard pushes
          the inputs above it instead of covering them. */}
      <BottomSheetModal
        ref={goalsSheetRef}
        snapPoints={['58%']}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: colors.backgroundSecondary }}
        handleIndicatorStyle={{ backgroundColor: colors.textMuted }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetView style={styles.sheetContent}>
          <Text style={[styles.sheetTitle, { color: colors.text }]}>Daily Goals</Text>
          <Text style={[styles.sheetSubtitle, { color: colors.textTertiary }]}>
            {isCustom
              ? 'Custom targets — set by you.'
              : 'Recommended for you, based on your profile.'}
          </Text>

          {(
            [
              { label: 'Calories (kcal)', key: 'cal' },
              { label: 'Protein (g)', key: 'prot' },
              { label: 'Carbs (g)', key: 'carbs' },
              { label: 'Fats (g)', key: 'fats' },
            ] as const
          ).map(({ label, key }) => (
            <View key={key} style={styles.sheetRow}>
              <Text style={[styles.sheetLabel, { color: colors.textMuted }]}>{label}</Text>
              <BottomSheetTextInput
                style={[styles.sheetInput, { color: colors.text, borderColor: colors.border }]}
                keyboardType="numeric"
                value={String(goalDraft[key])}
                onChangeText={(v) => {
                  const n = parseInt(v, 10);
                  if (!isNaN(n) && n >= 0) setGoalDraft((prev) => ({ ...prev, [key]: n }));
                  else if (v === '') setGoalDraft((prev) => ({ ...prev, [key]: 0 }));
                }}
                selectTextOnFocus
                returnKeyType="done"
              />
            </View>
          ))}

          <Pressable onPress={saveGoals} style={[styles.saveBtn, { backgroundColor: colors.primary }]}>
            <Text style={styles.saveBtnText}>Save</Text>
          </Pressable>
          {isCustom && (
            <Pressable onPress={handleResetGoals} style={styles.resetBtn} hitSlop={8}>
              <Ionicons name="sparkles-outline" size={15} color={colors.primary} />
              <Text style={[styles.resetBtnText, { color: colors.primary }]}>
                Reset to recommended
              </Text>
            </Pressable>
          )}
        </BottomSheetView>
      </BottomSheetModal>

      <QuotaLimitSheet error={quotaError} onClose={() => setQuotaError(null)} feature="nutrition_ai" />
    </BottomSheetModalProvider>
  );
}

// ── EditableLogRow ─────────────────────────────────────────────────────────────
// Tap on a logged meal to edit the raw text inline. On submit, the row's
// macros are re-parsed by the backend and the row re-renders.

type EditableLogRowProps = {
  row: NutritionLogRow;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
  clarification?: ClarificationBlock | null;
  onClarify?: (option: ClarificationOption) => Promise<unknown>;
  /** Photo logs: tapping reopens the Plate card instead of inline text edit. */
  onOpenPlate?: () => void;
};

/** Thumbnail for photo logs — private bucket, so render via a signed URL. */
function PhotoLogThumb({ imagePath }: { imagePath: string }) {
  const { data: uri } = useQuery({
    queryKey: ['meal_photo_thumb', imagePath],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from('meal-photos')
        .createSignedUrl(imagePath, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
    staleTime: 50 * 60 * 1000, // refresh before the 60-min URL expires
  });
  if (!uri) return null;
  return <ExpoImage source={{ uri }} style={styles.logPhotoThumb} contentFit="cover" />;
}

function EditableLogRow({
  row,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  clarification,
  onClarify,
  onOpenPlate,
}: EditableLogRowProps) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const [draft, setDraft] = useState(row.raw_text);
  const [saving, setSaving] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const editRef = useRef<TextInput>(null);

  const handlePillTap = async (option: ClarificationOption) => {
    if (!onClarify || clarifying) return;
    setClarifying(true);
    try {
      await onClarify(option);
    } catch (err) {
      console.error('Failed to apply clarification:', err);
    } finally {
      setClarifying(false);
    }
  };

  useEffect(() => {
    if (isEditing) {
      setDraft(row.raw_text);
      // Focus on the next frame so the keyboard actually opens.
      requestAnimationFrame(() => editRef.current?.focus());
    }
  }, [isEditing, row.raw_text]);

  const handleSubmit = async () => {
    // "Done" fires onSubmitEditing AND (via blurOnSubmit) onBlur — both route
    // here, so without this guard the backend update runs twice.
    if (saving) return;
    const next = draft.trim();
    if (!next) {
      onCancelEdit();
      return;
    }
    if (next === row.raw_text) {
      onCancelEdit();
      return;
    }
    setSaving(true);
    try {
      await onSaveEdit(next);
    } catch (err) {
      console.error('Edit failed:', err);
    } finally {
      setSaving(false);
    }
  };

  if (isEditing) {
    return (
      <View style={[styles.logRow, styles.logRowEditing]}>
        <TextInput
          ref={editRef}
          style={[styles.logEditInput, { color: colors.text }]}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={handleSubmit}
          onBlur={handleSubmit}
          returnKeyType="done"
          blurOnSubmit
        />
        <View style={styles.logEditActions}>
          {saving ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <>
              <Pressable onPress={onDelete} hitSlop={8} style={styles.logEditBtn}>
                <Ionicons name="trash-outline" size={18} color="#EF4444" />
              </Pressable>
              <Pressable onPress={handleSubmit} hitSlop={8} style={styles.logEditBtn}>
                <Ionicons name="checkmark" size={20} color={colors.primary} />
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  }

  const renderRightActions = () => (
    <View style={styles.swipeDeleteWrap}>
      <Pressable
        onPress={onDelete}
        style={styles.swipeDeleteBtn}
        accessibilityRole="button"
        accessibilityLabel="Delete meal"
      >
        <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
        <Text style={styles.swipeDeleteText}>Delete</Text>
      </Pressable>
    </View>
  );

  return (
    <View>
      <Swipeable
        renderRightActions={renderRightActions}
        overshootRight={false}
        rightThreshold={48}
      >
        <Pressable onPress={onOpenPlate ?? onStartEdit} style={[styles.logRow, styles.logRowWithThumb]}>
          {row.image_path ? <PhotoLogThumb imagePath={row.image_path} /> : null}
          <View style={styles.logRowBody}>
            <Text style={[styles.logBodyText, { color: colors.text }]} numberOfLines={2}>
              {row.raw_text}
            </Text>
            <View style={styles.logMacroChips}>
              <Text style={[styles.logKcal, { color: colors.text }]}>
                {row.calories}
                <Text style={[styles.logKcalUnit, { color: colors.textTertiary }]}> kcal</Text>
              </Text>
              {([
                [row.protein, 'protein'],
                [row.carbs, 'carbs'],
                [row.fats, 'fat'],
              ] as const).map(([value, label]) => (
                <View
                  key={label}
                  style={[
                    styles.logChip,
                    { borderColor: colors.border, backgroundColor: colors.backgroundSecondary },
                  ]}
                >
                  <Text style={[styles.logChipValue, { color: colors.text }]}>{value}g</Text>
                  <Text style={[styles.logChipLabel, { color: colors.textMuted }]}>{label}</Text>
                </View>
              ))}
            </View>
          </View>
        </Pressable>
      </Swipeable>
      {clarification && clarification.options.length > 0 ? (
        <View style={styles.rowClarifyBlock}>
          <Text style={[styles.rowClarifyQuestion, { color: colors.textMuted }]}>
            {clarification.question}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rowClarifyPills}
            keyboardShouldPersistTaps="handled"
          >
            {clarification.options.map((opt, idx) => (
              <Pressable
                key={`${opt.label}-${idx}`}
                onPress={() => handlePillTap(opt)}
                disabled={clarifying}
                style={({ pressed }) => [
                  styles.rowPill,
                  {
                    borderColor: colors.border,
                    backgroundColor: pressed ? colors.backgroundTertiary : 'transparent',
                    opacity: clarifying ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.rowPillText, { color: colors.text }]}>{opt.label}</Text>
                {opt.delta.calories !== 0 ? (
                  <Text style={[styles.rowPillDelta, { color: colors.textMuted }]}>
                    {opt.delta.calories > 0 ? '+' : ''}
                    {opt.delta.calories}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Dark surface that paints from y=0 (status bar) to the rounded bottom edge.
  // Animated height + paddingTop (set inline from safe-area insets).
  headerCard: {
    paddingHorizontal: 16,
    paddingBottom: 44, // generous clearance below content for the drag handle
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    borderBottomWidth: 1,
    overflow: 'hidden',
  },

  headerLogo: {
    width: 56,
    height: 24,
  },

  // Brand + week nav (one row — see render comment)
  brandNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingTop: 2,
    paddingBottom: 4,
  },
  weekNavGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  weekNavBtn: { padding: 4 },
  weekNavBtnDisabled: { opacity: 0 },
  weekRangeText: { fontSize: 12, fontFamily: 'Montserrat_600SemiBold' },

  // Week strip
  weekStrip: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
  },
  dayCol: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 12,
    gap: 4,
  },
  dayLabel: { fontSize: 10, fontFamily: 'Montserrat_500Medium' },
  dayNum: { fontSize: 14, fontFamily: 'Montserrat_700Bold' },
  dayDot: { width: 4, height: 4, borderRadius: 4 },

  // Compact calorie row
  compactCalorieRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 4,
  },
  compactRingWrap: { justifyContent: 'center', alignItems: 'center' },
  compactRingCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactKcal: { fontSize: 17, fontFamily: 'Montserrat_700Bold' },
  compactKcalUnit: { fontSize: 10, fontFamily: 'Montserrat_500Medium', marginTop: 1 },

  compactInfo: { flex: 1, gap: 2 },
  compactDateLabel: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  compactSubLabel: {
    fontSize: 22,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
  },
  compactSubLabelUnit: { fontSize: 12, fontFamily: 'Montserrat_500Medium' },
  editGoalsInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  editGoalsText: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },

  // Expanded
  expandedSection: {
    marginTop: 16,
    paddingHorizontal: 4,
    gap: 16,
  },
  macroColumn: { gap: 8 },
  // Soft inset rows (paywall card-row language) around each macro bar.
  macroRow: {
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  macroHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  macroLabel: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },
  macroValue: { fontSize: 12, fontFamily: 'Montserrat_700Bold' },
  macroTrack: { height: 4, borderRadius: 4, overflow: 'hidden' },
  macroFill: { height: '100%', borderRadius: 4 },

  vitaminRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  vitaminItem: { alignItems: 'flex-start', flex: 1, gap: 2 },
  vitaminDot: { width: 6, height: 6, borderRadius: 4, marginBottom: 2 },
  vitaminItemLabel: { fontSize: 10, fontFamily: 'Montserrat_500Medium' },
  vitaminItemValue: { fontSize: 13, fontFamily: 'Montserrat_700Bold' },

  // Slim header row shown while the keyboard is open
  minimizedRow: {
    position: 'absolute',
    left: 20,
    right: 20,
    height: HEADER_MINIMIZED,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  minimizedDate: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  minimizedKcal: {
    fontSize: 17,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
  },
  minimizedKcalUnit: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },

  // Drag handle
  dragHandleWrap: {
    position: 'absolute',
    bottom: 4,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  dragHandleHit: { alignItems: 'center', paddingVertical: 4 },
  dragBar: { width: 32, height: 3, borderRadius: 4, marginBottom: 2 },

  // Body
  body: { flex: 1 },
  listContent: {
    paddingTop: 8,
    paddingBottom: 32,
  },
  // Pinned above the keyboard / tab bar (not part of the scrolling list).
  inputWrap: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 10,
  },

  // Section headers (Breakfast / Lunch / Dinner / Snacks)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: 'Montserrat_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionDivider: { flex: 1, height: StyleSheet.hairlineWidth, opacity: 0.6 },
  sectionKcal: {
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
    fontVariant: ['tabular-nums'],
  },

  // Empty state
  emptyState: {
    paddingHorizontal: 32,
    paddingTop: 48,
    paddingBottom: 8,
    alignItems: 'center',
    gap: 12,
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Montserrat_700Bold' },
  emptyText: {
    fontSize: 13,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 19,
  },

  // Smart logger card + Pro nudge
  loggerGlow: {
    borderRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 6,
  },
  loggerCard: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  // Native Liquid Glass variant — the system effect supplies the surface,
  // edge highlight, and corner masking from borderRadius alone.
  loggerCardNative: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  proNudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 12,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  proNudgeText: {
    flex: 1,
    fontFamily: 'Montserrat_500Medium',
    fontSize: 13,
  },
  proNudgeClose: {
    padding: 2,
    marginLeft: 2,
  },

  // Swipe-to-delete
  swipeDeleteWrap: {
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: 12,
  },
  swipeDeleteBtn: {
    backgroundColor: '#EF4444',
    height: '78%',
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minWidth: 76,
  },
  swipeDeleteText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
  },

  // Logged rows (Notes-style: no border, just text on a single row)
  logRow: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  logRowEditing: {
    // Same horizontal padding as the read-only row (set by logRow) so the
    // text doesn't jump when entering edit mode. No background change.
    alignItems: 'flex-start',
    gap: 8,
  },
  logRowWithThumb: { justifyContent: 'flex-start' },
  logPhotoThumb: { width: 44, height: 44, borderRadius: 12 },
  logRowBody: { flex: 1, gap: 8 },
  logBodyText: {
    fontSize: 15,
    fontFamily: 'Montserrat_500Medium',
    lineHeight: 20,
  },
  logInlineMacros: {
    fontSize: 11,
    fontFamily: 'Montserrat_500Medium',
    textAlign: 'right',
  },
  logMacroChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  logKcal: {
    fontSize: 13,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
    marginRight: 4,
  },
  logKcalUnit: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },
  // Mini macro chips (paywall food-card pattern): bold value + muted label
  // in a hairline-bordered pill.
  logChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  logChipValue: {
    fontSize: 11,
    fontFamily: 'Montserrat_600SemiBold',
    fontVariant: ['tabular-nums'],
  },
  logChipLabel: {
    fontSize: 9,
    fontFamily: 'Montserrat_500Medium',
  },
  logEditInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Montserrat_400Regular',
    paddingVertical: 0,
    paddingHorizontal: 0,
    lineHeight: 22,
    backgroundColor: 'transparent',
  },
  logEditActions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 },
  logEditBtn: { padding: 4 },

  // Row-level clarification pills (appear directly below the meal row they refer to)
  rowClarifyBlock: {
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 12,
    gap: 8,
  },
  rowClarifyQuestion: {
    fontSize: 11,
    fontFamily: 'Montserrat_500Medium',
  },
  rowClarifyPills: {
    gap: 8,
    paddingRight: 12,
  },
  rowPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rowPillText: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
  },
  rowPillDelta: {
    fontSize: 10,
    fontFamily: 'Montserrat_400Regular',
  },

  // Full-bleed so the adaptive banner is never clipped (AdMob policy); the
  // hairline divider visually separates it from the last meal row.
  footerWrap: { paddingTop: 24, gap: 16 },
  footerDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 20, opacity: 0.8 },

  // Goals sheet
  sheetContent: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 32, gap: 16 },
  sheetTitle: { fontSize: 18, fontFamily: 'Montserrat_700Bold', marginBottom: 4 },
  sheetSubtitle: { fontSize: 13, fontFamily: 'Montserrat_400Regular', marginTop: -10 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetLabel: { fontSize: 14, fontFamily: 'Montserrat_500Medium' },
  sheetInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: 'Montserrat_600SemiBold',
    width: 90,
    textAlign: 'center',
  },
  saveBtn: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveBtnText: { color: '#FFFFFF', fontSize: 16, fontFamily: 'Montserrat_700Bold' },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  resetBtnText: { fontSize: 14, fontFamily: 'Montserrat_600SemiBold' },
});
