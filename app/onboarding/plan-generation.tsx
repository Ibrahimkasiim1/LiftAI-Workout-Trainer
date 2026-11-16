/**
 * Plan generation — calls /api/generate-plan with long timeout for cold backends.
 * Multi-stage loading UX (no alert modals for timeouts/network; inline retry only).
 */

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { posthog } from '../../src/config/posthog';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import LoadingBubbles from '../../components/LoadingBubbles';
import { getApiUrl } from '../../config/api';
import { useColors } from '../../hooks/useColors';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import {
  getPlanGenerationState,
  hasActivePlan,
  isInitialPlanGenerationPending,
  PLAN_GENERATION_RUNNING_TTL_MS,
} from '../../utils/funnelGuard';
import { writeFunnelSnapshot } from '../../utils/funnelState';
import { supabase } from '../../utils/supabase';

const GENERATION_TIMEOUT_MS = 300_000;
const MAX_FETCH_RETRIES = 2;
const MAX_AUTO_TIMEOUT_RETRIES = 2;
const PLAN_POLL_INTERVAL_MS = 4000;
const PLAN_POLL_MAX_MS = Math.max(PLAN_GENERATION_RUNNING_TTL_MS, 10 * 60 * 1000);

const STAGES = [
  {
    title: 'Analyzing your goals…',
    hint: 'Dialing in your goals, schedule, and equipment.',
    thresholdMs: 0,
  },
  {
    title: 'Designing your split…',
    hint: 'Mapping the perfect training week for your body.',
    thresholdMs: 12_000,
  },
  {
    title: 'Balancing your volume…',
    hint: 'Tuning sets and reps to match your experience.',
    thresholdMs: 28_000,
  },
  {
    title: 'Picking your exercises…',
    hint: 'Choosing the best moves for how you train.',
    thresholdMs: 48_000,
  },
] as const;

function stageIndexForElapsed(ms: number): number {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (ms >= STAGES[i].thresholdMs) idx = i;
  }
  return idx;
}

const ROTATING_QUOTES = [
  'Day one starts now.',
  "Just show up — the rest will follow.",
  'Every strong body started with one small step.',
  "You don't need perfect. You just need to begin.",
];

const SPLIT_LABELS: Record<string, string> = {
  full_body: 'Full Body',
  upper_lower: 'Upper/Lower',
  ppl: 'Push/Pull/Legs',
  bro_split: 'Bro Split',
};

export default function PlanGenerationScreen() {
  const colors = useColors();
  const router = useRouter();
  const { session, loading: authLoading } = useRequireAuth();

  const [working, setWorking] = useState(true);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [activeStageIndex, setActiveStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  /** "4 days/week · Push/Pull/Legs · 60 min · Dumbbell, Barbell +3 more" */
  const [planSummary, setPlanSummary] = useState<string | null>(null);

  const [quoteIndex, setQuoteIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const hasStartedGeneration = useRef(false);
  const requestStartMs = useRef(Date.now());
  const fetchAbortRef = useRef<AbortController | null>(null);
  const hardDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenMountedRef = useRef(true);
  const creepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRetryCountRef = useRef(0);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      screenMountedRef.current = false;
      fetchAbortRef.current?.abort();
      if (hardDeadlineRef.current) clearTimeout(hardDeadlineRef.current);
      if (creepIntervalRef.current) clearInterval(creepIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (!authLoading && session && !hasStartedGeneration.current) {
      hasStartedGeneration.current = true;
      bootstrapGenerationFlow().catch((error: unknown) => {
        const err = error as Error;
        setGenerationError(
          err?.message || 'Something went wrong while reconciling your plan state.'
        );
        setWorking(false);
      });
    }
  }, [authLoading, session]);

  useEffect(() => {
    if (!authLoading && session) {
      writeFunnelSnapshot('plan_generation', {
        route: '/onboarding/plan-generation',
        reason: 'plan_generation_screen',
      });
    }
  }, [authLoading, session]);

  // Replay the user's own inputs while the bar creeps — the wait IS their
  // plan being built, so show what it's being built from. Cosmetic: never block.
  useEffect(() => {
    if (authLoading || !session) return;
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('workout_days_per_week, workout_split_type, workout_duration_minutes, available_equipment')
          .eq('id', session.user.id)
          .single();
        if (!active || !data) return;
        const parts: string[] = [];
        if (data.workout_days_per_week) parts.push(`${data.workout_days_per_week} days/week`);
        if (data.workout_split_type) {
          parts.push(SPLIT_LABELS[data.workout_split_type] ?? data.workout_split_type);
        }
        if (data.workout_duration_minutes) parts.push(`${data.workout_duration_minutes} min`);
        const equipment: string[] = Array.isArray(data.available_equipment)
          ? data.available_equipment
          : [];
        if (equipment.length) {
          const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
          const shown = equipment.slice(0, 2).map(cap).join(', ');
          parts.push(equipment.length > 2 ? `${shown} +${equipment.length - 2} more` : shown);
        }
        if (parts.length) setPlanSummary(parts.join(' · '));
      } catch {
        // summary is a nice-to-have; generation must never depend on it
      }
    })();
    return () => {
      active = false;
    };
  }, [authLoading, session]);

  useEffect(() => {
    const interval = setInterval(() => {
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
      setQuoteIndex((prev) => (prev + 1) % ROTATING_QUOTES.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [fadeAnim]);

  useEffect(() => {
    if (!working || generationError) return;
    const tick = () => {
      const elapsed = Date.now() - requestStartMs.current;
      setActiveStageIndex(stageIndexForElapsed(elapsed));
    };
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [working, generationError]);

  const animateProgress = (to: number, duration = 400) => {
    setProgress(to);
    Animated.timing(progressAnim, {
      toValue: to,
      duration,
      useNativeDriver: false,
    }).start();
  };

  const stopProgressCreep = () => {
    if (creepIntervalRef.current) {
      clearInterval(creepIntervalRef.current);
      creepIntervalRef.current = null;
    }
  };

  /**
   * Continuous, asymptotic creep — the bar NEVER stalls until we explicitly
   * jump it to 100. It eases toward `ceiling` (default 95) so the user always
   * sees forward motion even if the backend takes a while to respond.
   */
  const startProgressCreep = (ceiling: number = 95) => {
    stopProgressCreep();
    creepIntervalRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev >= ceiling) return prev;
        const remaining = ceiling - prev;
        // Larger step early, tiny but non-zero step late — guarantees motion.
        const step = Math.max(0.15, remaining * 0.025);
        const next = Math.min(ceiling, prev + step);
        Animated.timing(progressAnim, {
          toValue: next,
          duration: 500,
          useNativeDriver: false,
        }).start();
        return next;
      });
    }, 500);
  };

  const navigateToPlanReview = async (reason: string) => {
    await writeFunnelSnapshot('hard_paywall', {
      route: '/onboarding/plan-review',
      reason,
    });
    router.replace('/onboarding/plan-review');
  };

  const waitForExistingPlan = async (userId: string): Promise<boolean> => {
    requestStartMs.current = Date.now();
    setGenerationError(null);
    setWorking(true);
    setActiveStageIndex(1);
    animateProgress(28, 300);
    // Keep the bar moving while we poll for the in-flight generation.
    startProgressCreep(95);

    const pollStart = Date.now();
    while (screenMountedRef.current && Date.now() - pollStart < PLAN_POLL_MAX_MS) {
      const [planExists, generationState] = await Promise.all([
        hasActivePlan(userId),
        getPlanGenerationState(userId),
      ]);

      if (planExists) {
        stopProgressCreep();
        animateProgress(100, 450);
        await navigateToPlanReview('plan_generation_reconciled');
        return true;
      }

      if (!isInitialPlanGenerationPending(generationState.status, generationState.startedAt)) {
        stopProgressCreep();
        return false;
      }

      // Continuous creep handles the visual; just sleep until the next poll.
      await new Promise((resolve) => setTimeout(resolve, PLAN_POLL_INTERVAL_MS));
    }

    stopProgressCreep();
    return false;
  };

  const bootstrapGenerationFlow = async () => {
    if (!session) return;

    const userId = session.user.id;
    const [planExists, generationState] = await Promise.all([
      hasActivePlan(userId),
      getPlanGenerationState(userId),
    ]);

    if (planExists) {
      await navigateToPlanReview('plan_found_on_boot');
      return;
    }

    if (isInitialPlanGenerationPending(generationState.status, generationState.startedAt)) {
      const resolved = await waitForExistingPlan(userId);
      if (resolved) {
        return;
      }
    }

    await generateUserPlan();
  };

  const generateUserPlan = async () => {
    if (!session) return;

    fetchAbortRef.current?.abort();
    if (hardDeadlineRef.current) clearTimeout(hardDeadlineRef.current);

    const controller = new AbortController();
    fetchAbortRef.current = controller;
    hardDeadlineRef.current = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

    setGenerationError(null);
    setWorking(true);
    requestStartMs.current = Date.now();
    setActiveStageIndex(0);
    animateProgress(8, 200);
    // Only clear the retry banner once we have meaningful progress again.

    try {
      await new Promise((resolve) => setTimeout(resolve, 800));

      const apiUrl = getApiUrl();
      let response: Response | null = null;
      let lastError: unknown = null;

      animateProgress(22, 350);
      // Continuous creep — runs until we navigate or hit an error.
      startProgressCreep(95);

      const accessToken = session.access_token;
      if (!accessToken) {
        throw new Error('Your session is missing a token. Please sign in again.');
      }

      for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
        try {
          response = await fetch(`${apiUrl}/api/generate-plan`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({}),
            signal: controller.signal,
          });
          break;
        } catch (fetchError: unknown) {
          lastError = fetchError;
          const name = (fetchError as Error)?.name;
          if (name === 'AbortError') throw fetchError;
          if (attempt === MAX_FETCH_RETRIES) throw fetchError;
        }
      }

      if (!response) throw lastError;

      // Lift the floor to 70 once we have a response, but keep the creep going
      // until the JSON is fully parsed and we navigate.
      setProgress((prev) => Math.max(prev, 70));
      animateProgress(Math.max(progress, 70), 500);
      setRetryNotice(null);

      if (!response.ok) {
        if (response.status === 409) {
          let conflictPayload: any = null;
          try {
            conflictPayload = await response.json();
          } catch {
            conflictPayload = null;
          }

          if (conflictPayload?.code === 'GENERATION_IN_PROGRESS') {
            const resumed = await waitForExistingPlan(session.user.id);
            if (resumed) {
              return;
            }

            throw new Error(
              'Your previous generation request is no longer running. Tap "Try again" to start a fresh one.'
            );
          }
        }

        const errorText = await response.text();
        throw new Error(`Server returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to generate plan');
      }
      if (!data.plan) {
        throw new Error('Backend did not return a plan');
      }

      animateProgress(100, 500);
      posthog.capture('plan_generated', {
        duration_ms: Date.now() - requestStartMs.current,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await navigateToPlanReview('plan_generated');
    } catch (error: unknown) {
      const err = error as Error;
      const name = err?.name;
      let message =
        err?.message || 'Something went wrong while creating your plan.';

      // Auto-retry on hard-deadline timeouts before surfacing an error.
      if (
        name === 'AbortError' &&
        autoRetryCountRef.current < MAX_AUTO_TIMEOUT_RETRIES &&
        screenMountedRef.current
      ) {
        autoRetryCountRef.current += 1;
        const attempt = autoRetryCountRef.current;
        const total = MAX_AUTO_TIMEOUT_RETRIES;
        setRetryNotice(`Reconnecting… (attempt ${attempt} of ${total})`);
        // Brief breather before the next attempt
        setTimeout(() => {
          if (!screenMountedRef.current) return;
          void generateUserPlan();
        }, 1500);
        return;
      }

      if (name === 'AbortError') {
        message =
          'This is taking longer than expected — your plan may still be processing. Try again in a moment.';
      }

      setGenerationError(message);
      setRetryNotice(null);
      setWorking(false);
    } finally {
      stopProgressCreep();
      if (hardDeadlineRef.current) clearTimeout(hardDeadlineRef.current);
      hardDeadlineRef.current = null;
      fetchAbortRef.current = null;
    }
  };

  const stage = STAGES[activeStageIndex];
  // Brand blue — this is the highest-value moment in the funnel, keep it on-brand.
  const accent = '#2E90FA';
  const accentSoft = `${accent}33`;

  if (generationError && !working) {
    return (
      <LinearGradient
        colors={['#0B1320', '#0F2236', '#0B1320']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradientFill}
      >
        <SafeAreaView style={styles.safe}>
          <View style={styles.errorCenter}>
            <View style={[styles.errorGlass, { borderColor: accentSoft, backgroundColor: colors.backgroundSecondary }]}>
              <View style={[styles.errorIconRing, { borderColor: accent }]}>
                <Ionicons name="cloud-offline-outline" size={36} color={accent} />
              </View>
              <Text style={[styles.errorTitle, { color: colors.text }]}>Couldn’t finish yet</Text>
              <Text style={[styles.errorBody, { color: colors.textMuted }]}>{generationError}</Text>
              <Text style={[styles.errorHint, { color: colors.textTertiary }]}>
                Cold servers sometimes need a minute. Your progress is saved — try again when ready.
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: accent }]}
                onPress={() => {
                  autoRetryCountRef.current = 0;
                  setRetryNotice(null);
                  void generateUserPlan();
                }}
                activeOpacity={0.85}
              >
                <Text style={[styles.primaryBtnText, { color: colors.textInverse }]}>Try again</Text>
                <Ionicons name="refresh" size={20} color={colors.textInverse} style={styles.btnIcon} />
              </TouchableOpacity>
              {/* The funnel navigates with router.replace, so this screen is
                  often the ONLY entry in the stack — render "Go back" only
                  when there is actually somewhere to go. Retry is the real
                  recovery path either way. */}
              {router.canGoBack() && (
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.back()} hitSlop={12}>
                  <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>Go back</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={['#0B1320', '#0F2236', '#14375C']}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={styles.gradientFill}
    >
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <View style={styles.stageRow}>
            {STAGES.map((s, i) => {
              const active = i === activeStageIndex;
              const done = i < activeStageIndex;
              return (
                <View key={s.title} style={styles.stageDotWrap}>
                  <View
                    style={[
                      styles.stageDot,
                      {
                        backgroundColor: done || active ? accent : colors.border,
                        opacity: active ? 1 : done ? 0.55 : 0.35,
                        transform: [{ scale: active ? 1.15 : 1 }],
                      },
                    ]}
                  />
                </View>
              );
            })}
          </View>

          <View style={[styles.iconWrapper, { borderColor: accentSoft, backgroundColor: colors.backgroundSecondary }]}>
            <Ionicons name="sparkles" size={52} color={accent} />
          </View>

          <Text style={[styles.headline, { color: colors.text }]}>Building your plan</Text>
          <Text style={[styles.stageTitle, { color: colors.text }]}>{stage.title}</Text>
          <Text style={[styles.stageHint, { color: colors.textMuted }]}>{stage.hint}</Text>
          {planSummary ? (
            <View style={[styles.summaryPill, { borderColor: accentSoft }]}>
              <Ionicons name="checkmark-circle" size={14} color={accent} style={{ marginRight: 6 }} />
              <Text style={[styles.summaryText, { color: colors.textSecondary }]} numberOfLines={2}>
                {planSummary}
              </Text>
            </View>
          ) : null}
          <Text style={[styles.takeAMoment, { color: colors.textTertiary }]}>This may take a moment</Text>

          <View style={styles.progressBlock}>
            <View style={styles.progressHeader}>
              <Text style={[styles.progressLabelLg, { color: colors.text }]}>{Math.round(progress)}%</Text>
              <Text style={[styles.progressCaption, { color: colors.textTertiary }]}>complete</Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: accent,
                    width: progressAnim.interpolate({
                      inputRange: [0, 100],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
              />
            </View>
            {retryNotice ? (
              <View style={styles.retryNoticePill}>
                <Ionicons name="refresh" size={13} color={accent} style={{ marginRight: 6 }} />
                <Text style={[styles.retryNoticeText, { color: accent }]}>{retryNotice}</Text>
              </View>
            ) : null}
          </View>

          <LoadingBubbles size={32} />

          <Animated.Text style={[styles.quote, { color: colors.textTertiary, opacity: fadeAnim }]}>
            {ROTATING_QUOTES[quoteIndex]}
          </Animated.Text>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradientFill: {
    flex: 1,
  },
  safe: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingBottom: 24,
  },
  stageRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    marginBottom: 36,
  },
  stageDotWrap: {
    paddingHorizontal: 2,
  },
  stageDot: {
    width: 10,
    height: 10,
    borderRadius: 4,
  },
  iconWrapper: {
    width: 112,
    height: 112,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    marginBottom: 28,
  },
  headline: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
    opacity: 0.85,
  },
  stageTitle: {
    fontSize: 24,
    fontFamily: 'Montserrat_700Bold',
    textAlign: 'center',
    marginBottom: 12,
  },
  stageHint: {
    fontSize: 15,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 12,
    paddingHorizontal: 8,
  },
  summaryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: 340,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginBottom: 16,
  },
  summaryText: {
    flexShrink: 1,
    fontSize: 12.5,
    fontFamily: 'Montserrat_600SemiBold',
    textAlign: 'center',
  },
  takeAMoment: {
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    textAlign: 'center',
    letterSpacing: 0.4,
    marginBottom: 28,
    opacity: 0.85,
  },
  progressBlock: {
    width: '100%',
    maxWidth: 340,
    marginBottom: 28,
  },
  progressTrack: {
    height: 6,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressLabel: {
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
    textAlign: 'center',
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  progressLabelLg: {
    fontSize: 28,
    fontFamily: 'Montserrat_700Bold',
    letterSpacing: -0.5,
  },
  progressCaption: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  retryNoticePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    marginTop: 16,
  },
  retryNoticeText: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
  },
  quote: {
    fontSize: 15,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    marginTop: 36,
    fontStyle: 'italic',
    paddingHorizontal: 16,
    lineHeight: 22,
  },
  errorCenter: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorGlass: {
    borderRadius: 24,
    borderWidth: 1,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  errorIconRing: {
    width: 76,
    height: 76,
    borderRadius: 999,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  errorTitle: {
    fontSize: 22,
    fontFamily: 'Montserrat_700Bold',
    textAlign: 'center',
    marginBottom: 12,
  },
  errorBody: {
    fontSize: 15,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 12,
  },
  errorHint: {
    fontSize: 13,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 28,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 999,
    minWidth: 220,
    gap: 8,
  },
  primaryBtnText: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
  },
  btnIcon: {
    marginLeft: 4,
  },
  secondaryBtn: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 15,
    fontFamily: 'Montserrat_600SemiBold',
  },
});
