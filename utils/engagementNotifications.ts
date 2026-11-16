// utils/engagementNotifications.ts
/**
 * Engagement & retention notifications (all LOCAL — server pushes for coach
 * check-ins live in the backend, see backend/src/services/pushNotifications).
 *
 * This module owns the growth-loop nudges:
 *
 *   1. App Store review prompt after a genuine "win" (3rd workout or a PR).
 *   2. A daily reminder at the user's best hour (override > learned hour >
 *      9 am), scheduled as a FINITE series of dated notifications with
 *      rotating, data-fed copy — so a lapsed user's phone doesn't buzz with
 *      the same canned line forever.
 *   3. A weekly summary notification ("Last week: 4 workouts, 2 PRs…").
 *   4. A re-engagement nudge if the app goes unopened for 3 days, personalized
 *      with a neglected lift and last week's volume.
 *
 * Cadence is segmented by where the user is in their lifecycle:
 *   - new (first week / never logged): daily, activation-focused copy
 *   - habitual: reminder only at their personal hour, plus the weekly summary
 *   - lapsing (3-13 days quiet): daily comeback copy, capped at 5 days
 *   - lapsed (14+ days): everything backs off to ONE gentle note a week out
 *
 * Because these are local notifications with dynamic copy, we recompute and
 * RE-SCHEDULE them every time the app is foregrounded. The 3-day re-engagement
 * only ever fires if the app stays closed — each foreground pushes it out.
 *
 * IMPORTANT: we only cancel the IDs WE scheduled (tracked in AsyncStorage), so
 * we never wipe reminders scheduled elsewhere (e.g. the rest timer).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as StoreReview from 'expo-store-review';

import { checkNotificationPermissions } from './notifications';
import { supabase } from './supabase';
import { getWeightUnit } from './weightConverter';

const ENGAGEMENT_IDS_KEY = '@engagement_notif_ids_v1';
const REVIEW_PROMPTED_KEY = '@review_prompted_v1';
const LAST_REFRESH_KEY = '@engagement_refresh_at_v1';
const REMINDER_HOUR_KEY = '@reminder_hour_override_v1';

const REVIEW_WORKOUT_THRESHOLD = 3;
const DEFAULT_REMINDER_HOUR = 9;
const WEEKLY_SUMMARY_WEEKDAY = 2; // expo weekday: 1=Sun … 7=Sat → Monday
const WEEKLY_SUMMARY_HOUR = 9;
const REENGAGE_AFTER_DAYS = 3;
const REENGAGE_HOUR = 11;
// Avoid thrashing the OS scheduler — at most one full refresh per ~6h.
const MIN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const LBS_PER_KG = 2.20462;

const localDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d: Date, days: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
};

// ===========================================================================
// Reminder-hour override (settings)
// ===========================================================================

/**
 * The user's explicit reminder hour from settings, or null for "auto"
 * (learned workout hour when available, otherwise 9 am).
 */
export async function getReminderHourOverride(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_HOUR_KEY);
    if (raw == null || raw === 'auto') return null;
    const hour = Number(raw);
    return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
  } catch {
    return null;
  }
}

/** Persist the reminder hour ('auto' clears the override). */
export async function setReminderHourOverride(hour: number | 'auto'): Promise<void> {
  try {
    await AsyncStorage.setItem(REMINDER_HOUR_KEY, String(hour));
  } catch {
    // Best-effort — worst case the picker doesn't stick.
  }
}

// ===========================================================================
// 1. App Store review prompt (after a "win")
// ===========================================================================

/** A moment worth asking for a review — either signal qualifies. */
export interface ReviewWinSignal {
  /** Lifetime completed workouts, including the one just finished. */
  totalWorkouts: number;
  /** True when this session set a new personal record. */
  hitPR?: boolean;
}

/**
 * Ask for a native App Store review after a genuine win — the user's 3rd
 * completed workout or any session that set a PR. Never on launch, never on a
 * button tap (Apple discourages both). The OS itself caps this at 3 prompts /
 * 365 days and silently ignores extras, and we additionally fire at most once
 * per install. Safe to call after every workout completion.
 */
export async function maybeRequestReviewAfterWin(signal: ReviewWinSignal): Promise<void> {
  try {
    const isWin = signal.hitPR === true || signal.totalWorkouts >= REVIEW_WORKOUT_THRESHOLD;
    if (!isWin) return;
    if (await AsyncStorage.getItem(REVIEW_PROMPTED_KEY)) return;
    if (!(await StoreReview.isAvailableAsync())) return;
    if (!(await StoreReview.hasAction())) return;

    // Mark BEFORE prompting so a crash/retry can't double-prompt the user.
    await AsyncStorage.setItem(REVIEW_PROMPTED_KEY, '1');
    // Let the completion celebration land first — the prompt should ride the
    // win, not interrupt the transition into it.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await StoreReview.requestReview();
  } catch (error) {
    console.warn('maybeRequestReviewAfterWin failed:', error);
  }
}

// ===========================================================================
// 1b. First-workout reminder (Day-1 activation push)
// ===========================================================================

/**
 * One-off "your first workout is ready" nudge, scheduled when a brand-new
 * user defers their first session ("remind me later" on the post-plan
 * first-workout screen). Fires ~4 hours later, clamped into waking hours
 * (9:00 if it would land late night / early morning). No-ops without
 * notification permission.
 */
export async function scheduleFirstWorkoutReminder(
  estimatedMinutes?: number | null,
): Promise<void> {
  try {
    if (!(await checkNotificationPermissions())) return;

    const fire = new Date(Date.now() + 4 * 60 * 60 * 1000);
    if (fire.getHours() >= 21) {
      // Would land late evening — push to tomorrow morning instead.
      fire.setDate(fire.getDate() + 1);
      fire.setHours(9, 0, 0, 0);
    } else if (fire.getHours() < 8) {
      // Landed past midnight — same morning at 9.
      fire.setHours(9, 0, 0, 0);
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Your first workout is ready',
        body: estimatedMinutes
          ? `About ${estimatedMinutes} minutes and day one is done. Everything is set up, just press start.`
          : 'Everything is set up. Just press start and day one is done.',
        sound: true,
        data: { type: 'first_workout_reminder', route: '/(tabs)' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fire,
      },
    });
  } catch (error) {
    console.warn('scheduleFirstWorkoutReminder failed:', error);
  }
}

// ===========================================================================
// 2-4. Local engagement notifications
// ===========================================================================

interface WeeklyStats {
  workouts: number;
  sets: number;
  calories: number;
  prs: number;
}

/** Stats for the trailing 7 days, used in the weekly summary copy. */
async function getWeeklyStats(userId: string): Promise<WeeklyStats> {
  const today = new Date();
  const since7 = localDateStr(addDays(today, -7));

  const [completionsRes, setsRes, calRes] = await Promise.all([
    supabase
      .from('workout_completions')
      .select('completion_date')
      .eq('user_id', userId)
      .eq('workout_type', 'workout')
      .gte('completion_date', since7),
    supabase
      .from('exercise_performance')
      .select('exercise_name, weight_used, workout_date')
      .eq('user_id', userId)
      .gte('workout_date', since7),
    supabase
      .from('nutrition_logs')
      .select('calories')
      .eq('user_id', userId)
      .gte('date', since7),
  ]);

  const workouts = new Set((completionsRes.data ?? []).map((r) => r.completion_date)).size;
  const setRows = setsRes.data ?? [];
  const sets = setRows.length;
  const calories = (calRes.data ?? []).reduce(
    (sum, r: { calories: number | null }) => sum + (r.calories ?? 0),
    0,
  );

  // Best-effort PR count: exercises whose top weight last week beat their
  // previous all-time best. Bounded by .in() on last week's exercises.
  let prs = 0;
  try {
    const lastWeekMax = new Map<string, number>();
    for (const row of setRows) {
      const w = row.weight_used ?? 0;
      if (w <= 0) continue;
      lastWeekMax.set(row.exercise_name, Math.max(lastWeekMax.get(row.exercise_name) ?? 0, w));
    }
    const names = [...lastWeekMax.keys()];
    if (names.length > 0) {
      const { data: priorRows } = await supabase
        .from('exercise_performance')
        .select('exercise_name, weight_used')
        .eq('user_id', userId)
        .lt('workout_date', since7)
        .in('exercise_name', names);
      const priorMax = new Map<string, number>();
      for (const row of priorRows ?? []) {
        const w = row.weight_used ?? 0;
        priorMax.set(row.exercise_name, Math.max(priorMax.get(row.exercise_name) ?? 0, w));
      }
      for (const [name, top] of lastWeekMax) {
        const prev = priorMax.get(name);
        if (prev != null && top > prev) prs += 1;
      }
    }
  } catch {
    // PRs are a nice-to-have; never block the summary on them.
  }

  return { workouts, sets, calories, prs };
}

/** The hour of day (0-23) the user most often finishes workouts, or null. */
async function getLearnedWorkoutHour(userId: string): Promise<number | null> {
  const { data } = await supabase
    .from('workout_completions')
    .select('completed_at')
    .eq('user_id', userId)
    .eq('workout_type', 'workout')
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(40);

  const rows = data ?? [];
  if (rows.length < 3) return null; // not enough signal yet

  const histogram = new Array(24).fill(0);
  for (const row of rows) {
    if (!row.completed_at) continue;
    const hour = new Date(row.completed_at).getHours();
    if (hour >= 0 && hour < 24) histogram[hour] += 1;
  }
  let bestHour = -1;
  let bestCount = 0;
  for (let h = 0; h < 24; h++) {
    if (histogram[h] > bestCount) {
      bestCount = histogram[h];
      bestHour = h;
    }
  }
  return bestCount >= 2 ? bestHour : null;
}

/** Personalized 3-day re-engagement copy from real recent training data. */
async function getReengagementContent(
  userId: string,
  firstName: string | null,
): Promise<{ title: string; body: string }> {
  const hey = firstName ? `${firstName}, ` : '';
  const fallback = {
    title: 'Your plan is waiting',
    body: `${hey}it's been a few days. Your next session is ready when you are.`,
  };
  try {
    const today = new Date();
    const since30 = localDateStr(addDays(today, -30));
    const since7 = localDateStr(addDays(today, -7));

    const { data } = await supabase
      .from('exercise_performance')
      .select('exercise_name, workout_date')
      .eq('user_id', userId)
      .gte('workout_date', since30);

    const rows = data ?? [];
    const recent = new Set<string>();
    const counts = new Map<string, number>();
    let weekSets = 0;
    for (const row of rows) {
      const date = row.workout_date ?? '';
      counts.set(row.exercise_name, (counts.get(row.exercise_name) ?? 0) + 1);
      if (date >= since7) {
        recent.add(row.exercise_name);
        weekSets += 1;
      }
    }

    // A lift trained over the last month but NOT in the last week = "due".
    let neglected: string | null = null;
    let neglectedCount = 0;
    for (const [name, count] of counts) {
      if (!recent.has(name) && count > neglectedCount) {
        neglected = name;
        neglectedCount = count;
      }
    }

    if (neglected) {
      return {
        title: `Your ${neglected} is due`,
        body:
          weekSets > 0
            ? `${hey}only ${weekSets} set${weekSets === 1 ? '' : 's'} last week. Let's hit ${neglected} today.`
            : `${hey}it's been a while since you trained ${neglected}. Let's get back to it today.`,
      };
    }
    if (weekSets > 0) {
      return {
        title: "Don't lose the rhythm",
        body: `${hey}you logged ${weekSets} set${weekSets === 1 ? '' : 's'} last week. Keep it going today.`,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// ===========================================================================
// Daily reminder copy + lifecycle segmentation
// ===========================================================================

type Segment = 'new' | 'habitual' | 'lapsing' | 'lapsed';

interface ReminderContext {
  firstName: string | null;
  everLogged: boolean;
  daysSinceLast: number; // Infinity when never logged
  workoutsThisWeek: number;
  topLift: { name: string; weight: number } | null; // heaviest set of last session, kg
  unit: 'kg' | 'lbs';
}

function displayWeight(kg: number, unit: 'kg' | 'lbs'): string {
  if (unit === 'lbs') return `${Math.round(kg * LBS_PER_KG)} lbs`;
  const rounded = Math.round(kg * 2) / 2;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} kg`;
}

/**
 * Where the user is in their lifecycle. Decides both cadence and voice:
 * activation for new users, light-touch for habitual ones, a warmer comeback
 * tone while lapsing, and near-silence once fully lapsed.
 */
function computeSegment(ctx: ReminderContext, accountAgeDays: number): Segment {
  if (!ctx.everLogged || accountAgeDays <= 7) return 'new';
  if (ctx.daysSinceLast >= 14) return 'lapsed';
  if (ctx.daysSinceLast >= 3) return 'lapsing';
  return 'habitual';
}

interface ReminderCopy {
  title: string;
  body: string;
}

/**
 * Rotating, data-fed daily reminder copy. `rotation` (day-of-month + offset)
 * walks the variant pool so two consecutive days never repeat a line. Voice:
 * a coach texting you, short and plain.
 */
function buildDailyReminder(ctx: ReminderContext, segment: Segment, rotation: number): ReminderCopy {
  const hey = ctx.firstName ? `${ctx.firstName}, ` : '';
  const pool: ReminderCopy[] = [];

  if (segment === 'new' && !ctx.everLogged) {
    pool.push(
      {
        title: 'Your first workout is waiting',
        body: `${hey}day one takes about 20 minutes. Press start and I'll walk you through every set.`,
      },
      {
        title: 'Ready when you are',
        body: `${hey}your plan is built. The first session is the hardest part, so we keep it short.`,
      },
      {
        title: 'Twenty minutes today',
        body: `${hey}that's all day one takes. You don't need to feel ready, you just need to start.`,
      },
    );
  } else if (segment === 'lapsing') {
    const days = Math.min(13, Math.max(3, Math.floor(ctx.daysSinceLast)));
    pool.push(
      {
        title: `It's been ${days} days`,
        body: `${hey}no stress. A short session today gets you back in. I can keep it light.`,
      },
      {
        title: 'Pick it back up',
        body: `${hey}one easy workout today and you're back on track. That's all it takes.`,
      },
    );
  } else {
    // 'new but active' and 'habitual' share a pool of data-fed variants.
    if (ctx.workoutsThisWeek > 0) {
      pool.push({
        title: `${ctx.workoutsThisWeek} down this week`,
        body: `${hey}nice work. One more today keeps it moving.`,
      });
    }
    if (ctx.topLift) {
      pool.push({
        title: `Build on ${ctx.topLift.name}`,
        body:
          ctx.topLift.weight > 0
            ? `${hey}you hit ${displayWeight(ctx.topLift.weight, ctx.unit)} on ${ctx.topLift.name} last session. Small jumps add up.`
            : `${hey}${ctx.topLift.name} went well last session. Let's build on it today.`,
      });
    }
    pool.push({
      title: 'Your session is ready',
      body: `${hey}today's workout is set. Thirty focused minutes and you're done.`,
    });
    if (segment === 'new') {
      pool.push({
        title: 'Keep it rolling',
        body: `${hey}your next session is ready. The first week is where the habit forms.`,
      });
    }
  }

  return pool[Math.abs(rotation) % pool.length];
}

/** Profile bits the scheduler needs; one query. */
async function getProfileForReminders(userId: string): Promise<{
  firstName: string | null;
  accountAgeDays: number;
  notificationsEnabled: boolean;
}> {
  const { data } = await supabase
    .from('user_profiles')
    .select('name, created_at, notifications_enabled')
    .eq('id', userId)
    .maybeSingle();
  const firstName =
    typeof data?.name === 'string' && data.name.trim() ? data.name.trim().split(/\s+/)[0] : null;
  const created = data?.created_at ? new Date(data.created_at).getTime() : Date.now();
  return {
    firstName,
    accountAgeDays: Math.max(0, (Date.now() - created) / 86400000),
    // Only an explicit false is an opt-out — older accounts may have null.
    notificationsEnabled: data?.notifications_enabled !== false,
  };
}

/** Recent-training snapshot for segmentation + copy; two queries. */
async function getTrainingSnapshot(
  userId: string,
): Promise<Pick<ReminderContext, 'everLogged' | 'daysSinceLast' | 'workoutsThisWeek' | 'topLift'>> {
  const today = new Date();
  const since30 = localDateStr(addDays(today, -30));
  const since7 = localDateStr(addDays(today, -7));

  const [{ data: recentRows }, { data: anyRow }] = await Promise.all([
    supabase
      .from('exercise_performance')
      .select('exercise_name, weight_used, workout_date')
      .eq('user_id', userId)
      .gte('workout_date', since30)
      .order('workout_date', { ascending: false })
      .limit(400),
    supabase.from('exercise_performance').select('id').eq('user_id', userId).limit(1),
  ]);

  const rows = recentRows ?? [];
  const everLogged = (anyRow ?? []).length > 0;
  if (rows.length === 0) {
    return { everLogged, daysSinceLast: everLogged ? 30 : Infinity, workoutsThisWeek: 0, topLift: null };
  }

  const todayStr = localDateStr(today);
  const lastDay = String(rows[0].workout_date).slice(0, 10);
  const daysSinceLast = Math.max(
    0,
    Math.round((Date.parse(todayStr) - Date.parse(lastDay)) / 86400000),
  );
  const workoutsThisWeek = new Set(
    rows
      .map((r) => String(r.workout_date).slice(0, 10))
      .filter((day) => day >= since7),
  ).size;

  let topLift: ReminderContext['topLift'] = null;
  for (const row of rows) {
    if (String(row.workout_date).slice(0, 10) !== lastDay) break;
    const weight = Number(row.weight_used) || 0;
    if (!topLift || weight > topLift.weight) {
      topLift = { name: row.exercise_name, weight };
    }
  }

  return { everLogged, daysSinceLast, workoutsThisWeek, topLift };
}

/** Cancel only the engagement notifications we previously scheduled. */
async function cancelTrackedEngagement(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ENGAGEMENT_IDS_KEY);
    if (!raw) return;
    const ids: string[] = JSON.parse(raw);
    await Promise.all(
      ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})),
    );
  } catch {
    // ignore — worst case the OS keeps a stale notification until next refresh
  }
}

/**
 * Recompute and (re)schedule all local engagement notifications. Call on app
 * foreground and after login. No-ops without notification permission, and
 * cancels everything when the user turned notifications off in settings.
 */
export async function refreshEngagementNotifications(
  userId: string,
  options?: { force?: boolean },
): Promise<void> {
  try {
    if (!userId) return;
    if (!(await checkNotificationPermissions())) return;

    if (!options?.force) {
      const lastRaw = await AsyncStorage.getItem(LAST_REFRESH_KEY);
      if (lastRaw && Date.now() - Number(lastRaw) < MIN_REFRESH_INTERVAL_MS) return;
    }

    const profile = await getProfileForReminders(userId);
    if (!profile.notificationsEnabled) {
      // The in-app toggle is a real promise: nothing scheduled while it's off.
      await cancelTrackedEngagement();
      await AsyncStorage.multiSet([
        [ENGAGEMENT_IDS_KEY, '[]'],
        [LAST_REFRESH_KEY, String(Date.now())],
      ]);
      return;
    }

    const [snapshot, learnedHour, overrideHour, unit] = await Promise.all([
      getTrainingSnapshot(userId),
      getLearnedWorkoutHour(userId),
      getReminderHourOverride(),
      getWeightUnit(),
    ]);

    const ctx: ReminderContext = { firstName: profile.firstName, unit, ...snapshot };
    const segment = computeSegment(ctx, profile.accountAgeDays);

    // Personal hour wins: explicit setting > learned training hour > 9 am.
    // When a personal hour exists there is exactly ONE daily reminder at that
    // hour — never a second generic morning ping on top.
    const personalHour = overrideHour ?? learnedHour;
    const reminderHour = personalHour ?? DEFAULT_REMINDER_HOUR;

    await cancelTrackedEngagement();
    const ids: string[] = [];

    const scheduleAt = async (fire: Date, copy: ReminderCopy, type: string): Promise<void> => {
      ids.push(
        await Notifications.scheduleNotificationAsync({
          content: {
            title: copy.title,
            body: copy.body,
            sound: true,
            data: { type, route: '/(tabs)' },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fire },
        }),
      );
    };

    // 2. Daily reminders: a finite run of dated notifications with rotating
    //    copy. Finite by design — if the user never reopens the app, the
    //    dailies go quiet on their own instead of nagging forever (the server
    //    coach push owns long-gap re-engagement).
    //    - new: 7 days of activation-focused copy
    //    - habitual: 7 days, but ONLY at a personal hour (stay out of the way)
    //    - lapsing: 5 days of comeback copy
    //    - lapsed: no dailies; one gentle note a week out
    let dailyDays = 0;
    if (segment === 'new') dailyDays = 7;
    else if (segment === 'habitual') dailyDays = personalHour != null ? 7 : 0;
    else if (segment === 'lapsing') dailyDays = 5;

    const now = new Date();
    let scheduled = 0;
    for (let offset = 0; scheduled < dailyDays && offset <= dailyDays + 1; offset++) {
      const fire = addDays(now, offset);
      fire.setHours(reminderHour, 0, 0, 0);
      if (fire.getTime() <= now.getTime() + 5 * 60 * 1000) continue; // today's slot already passed
      const copy = buildDailyReminder(ctx, segment, fire.getDate() + fire.getMonth());
      await scheduleAt(fire, copy, 'daily_reminder');
      scheduled++;
    }

    if (segment === 'lapsed') {
      const fire = addDays(now, 7);
      fire.setHours(reminderHour, 0, 0, 0);
      const hey = ctx.firstName ? `${ctx.firstName}, ` : '';
      await scheduleAt(
        fire,
        {
          title: "Whenever you're ready",
          body: `${hey}your plan is still here. One short session is all it takes to restart. No guilt.`,
        },
        'lapsed_nudge',
      );
    }

    // 3. Weekly summary (Monday morning) with last week's numbers.
    const stats = await getWeeklyStats(userId);
    if (stats.workouts > 0 || stats.sets > 0 || stats.calories > 0) {
      const parts: string[] = [`${stats.workouts} workout${stats.workouts === 1 ? '' : 's'}`];
      if (stats.prs > 0) parts.push(`${stats.prs} PR${stats.prs === 1 ? '' : 's'}`);
      if (stats.calories > 0) parts.push(`${(stats.calories / 1000).toFixed(stats.calories >= 10000 ? 0 : 1)}k cal logged`);
      ids.push(
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Your week in review',
            body: `Last week: ${parts.join(', ')}. Tap to see your progress.`,
            sound: true,
            data: { type: 'weekly_summary', route: '/(tabs)/progress' },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
            weekday: WEEKLY_SUMMARY_WEEKDAY,
            hour: WEEKLY_SUMMARY_HOUR,
            minute: 0,
          },
        }),
      );
    }

    // 4. 3-day re-engagement (only fires if the app stays closed that long).
    //    Lapsed users are excluded — their single gentle note above is the
    //    whole cadence; stacking another ping on top reads as spam.
    if (segment !== 'lapsed') {
      const reEngage = await getReengagementContent(userId, profile.firstName);
      const fireDate = addDays(new Date(), REENGAGE_AFTER_DAYS);
      fireDate.setHours(REENGAGE_HOUR, 0, 0, 0);
      ids.push(
        await Notifications.scheduleNotificationAsync({
          content: {
            title: reEngage.title,
            body: reEngage.body,
            sound: true,
            data: { type: 'reengagement', route: '/(tabs)' },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: fireDate,
          },
        }),
      );
    }

    await AsyncStorage.multiSet([
      [ENGAGEMENT_IDS_KEY, JSON.stringify(ids.filter(Boolean))],
      [LAST_REFRESH_KEY, String(Date.now())],
    ]);
  } catch (error) {
    console.warn('refreshEngagementNotifications failed:', error);
  }
}
