/**
 * Progressive Overload Recommender
 *
 * Generates smart, per-set weight + rep targets from the user's recent history
 * for an exercise. Used to prefill the inline set logger so the most common
 * case (do what the plan says) is a single tap.
 *
 * Algorithm (RPE-style double-progression, applied per set):
 *   1. Pull the user's most recent same-set performance.
 *   2. If they hit the top of the rep range → bump weight, drop reps to bottom of range.
 *   3. If they hit inside the range → keep weight, target reps+1.
 *   4. If they missed the range twice in a row → deload 10%.
 *   5. If no history → use the plan's target weight (or empty for the user to enter).
 *
 * The recommendation is *advisory only* — the user can always overwrite. Confidence
 * + reasoning are surfaced as a one-line nudge in the UI ("AI: +5 lbs from last week").
 */

import { ExercisePerformanceLog } from './ProgressService';
import { getLocalDateString } from '../../utils/date';
import { toUserUnit } from '../../utils/weightConverter';

export type EquipmentType = 'none' | 'barbell' | 'dumbbell' | 'machine';
export type WeightUnit = 'kg' | 'lbs';
export type RecKind = 'increase' | 'maintain' | 'deload' | 'new';

export interface SetRecommendation {
  setNumber: number;
  weight: number;          // in the user's preferred unit, ready to render
  reps: number;
  kind: RecKind;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;       // short one-liner for the UI ("+5 lbs from last week")
  basedOnDate?: string;    // ISO date of the session this rec was derived from
}

interface RecommendInput {
  history: ExercisePerformanceLog[];   // already filtered to this exercise, newest first
  totalSets: number;
  targetReps: string | number;         // e.g. "8-12", "10", 10
  equipmentType: EquipmentType;
  unit: WeightUnit;
  planWeight?: number | null;          // optional fallback if no history (in user's unit)
}

// Smallest weight increment available per equipment + unit. Exported so the
// coach-reaction copy can suggest CONCRETE next-set weights on the same grid
// the recommendations use.
export const minStep = (eq: EquipmentType, unit: WeightUnit): number => {
  if (unit === 'lbs') {
    if (eq === 'barbell') return 5;
    if (eq === 'dumbbell') return 5;       // dumbbells usually go in 5 lb steps
    if (eq === 'machine') return 5;
    return 0;
  }
  if (eq === 'barbell') return 2.5;
  if (eq === 'dumbbell') return 2;
  if (eq === 'machine') return 2.5;
  return 0;
};

// Round to the nearest representable plate / dumbbell increment.
const roundToStep = (value: number, step: number): number => {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
};

// Parse "8-12" → { min: 8, max: 12 }. A bare "10" → { min: 10, max: 10 }.
const parseRepRange = (target: string | number): { min: number; max: number } => {
  if (typeof target === 'number') return { min: target, max: target };
  const str = target.toString().trim();
  const m = str.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }
  const single = parseInt(str, 10);
  if (!isNaN(single)) return { min: single, max: single };
  return { min: 8, max: 12 };
};

// Group logs by ISO date (newest first) for "session-by-session" reasoning.
const groupByDate = (
  history: ExercisePerformanceLog[],
): Array<{ date: string; sets: ExercisePerformanceLog[] }> => {
  const map = new Map<string, ExercisePerformanceLog[]>();
  for (const entry of history) {
    const key = getLocalDateString(entry.workout_date); // local day, not UTC
    const arr = map.get(key) || [];
    arr.push(entry);
    map.set(key, arr);
  }
  return Array.from(map.entries())
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .map(([date, sets]) => ({ date, sets }));
};

// Human-friendly delta phrasing for the reasoning line.
const phraseDelta = (deltaWeight: number, unit: WeightUnit): string => {
  if (deltaWeight === 0) return '';
  const sign = deltaWeight > 0 ? '+' : '−';
  return `${sign}${Math.abs(deltaWeight)} ${unit}`;
};

const phraseDaysAgo = (iso: string): string => {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 14) return 'last week';
  if (days < 31) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
};

/**
 * Generate per-set recommendations for the upcoming exercise.
 *
 * Returns an array of length `totalSets`; the UI prefills each set with these
 * values until the user overwrites them.
 */
export function recommendSets(input: RecommendInput): SetRecommendation[] {
  const { history, totalSets, targetReps, equipmentType, unit, planWeight } = input;
  const { min: repsMin, max: repsMax } = parseRepRange(targetReps);
  const step = minStep(equipmentType, unit);

  // Convert any kg history values into the user's display unit up-front so the
  // recommender works in a single coordinate system.
  // (ProgressService stores weight_used in kg; the caller may pass converted values.
  // We tolerate both by accepting raw kg logs and converting here.)
  const sessions = groupByDate(history);

  const fallbackWeight = (() => {
    if (planWeight && planWeight > 0) return roundToStep(planWeight, step || 0.5);
    return 0;
  })();

  // For "no history" exercises (bodyweight or first-time lifts), prefill from
  // the plan if available, otherwise leave weight=0 so the user types it once.
  if (sessions.length === 0) {
    return Array.from({ length: totalSets }, (_, i) => ({
      setNumber: i + 1,
      weight: equipmentType === 'none' ? 0 : fallbackWeight,
      reps: repsMin,
      kind: 'new' as RecKind,
      confidence: 'low' as const,
      reasoning:
        equipmentType === 'none'
          ? 'New exercise — log your first set'
          : fallbackWeight > 0
            ? `Plan target: ${fallbackWeight} ${unit}`
            : 'New exercise — enter a starting weight',
    }));
  }

  const lastSession = sessions[0];
  const prevSession = sessions[1];

  // Per-set recommendation, considering the same set number across sessions.
  return Array.from({ length: totalSets }, (_, i) => {
    const setNumber = i + 1;

    // Find the same set number in last session (fallback: highest matching set).
    const findSet = (s: ExercisePerformanceLog[]): ExercisePerformanceLog | null =>
      s.find((entry) => entry.set_number === setNumber) ||
      s.slice().sort((a, b) => b.set_number - a.set_number)[0] ||
      null;

    const lastSet = findSet(lastSession.sets);
    if (!lastSet) {
      return {
        setNumber,
        weight: equipmentType === 'none' ? 0 : fallbackWeight,
        reps: repsMin,
        kind: 'new',
        confidence: 'low',
        reasoning: 'No data for this set yet',
      };
    }

    // ProgressService stores kg; convert to user unit for display.
    const lastWeightUserUnit = roundToStep(
      toUserUnit(lastSet.weight_used, unit),
      step || 0.5,
    );
    const lastReps = lastSet.reps_completed;
    const prevSet = prevSession ? findSet(prevSession.sets) : null;

    // ── Decision tree ──────────────────────────────────────────────────────
    // Hit top of range → increase weight, reset reps to bottom of range.
    if (lastReps >= repsMax && equipmentType !== 'none') {
      const newWeight = roundToStep(lastWeightUserUnit + step, step);
      const delta = newWeight - lastWeightUserUnit;
      return {
        setNumber,
        weight: newWeight,
        reps: repsMin,
        kind: 'increase',
        confidence: sessions.length >= 3 ? 'high' : 'medium',
        reasoning: `${phraseDelta(delta, unit)} from ${phraseDaysAgo(lastSession.date)}`,
        basedOnDate: lastSession.date,
      };
    }

    // Missed range twice in a row → deload 10%.
    const missedTwice =
      lastReps < repsMin && prevSet && prevSet.reps_completed < repsMin;
    if (missedTwice && equipmentType !== 'none') {
      const deload = roundToStep(lastWeightUserUnit * 0.9, step);
      const delta = deload - lastWeightUserUnit;
      return {
        setNumber,
        weight: Math.max(deload, step),
        reps: repsMin,
        kind: 'deload',
        confidence: 'high',
        reasoning: `Deload ${phraseDelta(delta, unit)} — rebuild`,
        basedOnDate: lastSession.date,
      };
    }

    // In range → hold weight, push reps up by 1 (capped at top of range).
    if (lastReps >= repsMin) {
      const nextReps = Math.min(lastReps + 1, repsMax);
      return {
        setNumber,
        weight: equipmentType === 'none' ? 0 : lastWeightUserUnit,
        reps: nextReps,
        kind: 'maintain',
        confidence: sessions.length >= 2 ? 'medium' : 'low',
        reasoning:
          equipmentType === 'none'
            ? `Last: ${lastReps} reps — push 1 more`
            : `Same as ${phraseDaysAgo(lastSession.date)} — push 1 rep`,
        basedOnDate: lastSession.date,
      };
    }

    // Below range but only once → repeat to consolidate.
    return {
      setNumber,
      weight: equipmentType === 'none' ? 0 : lastWeightUserUnit,
      reps: repsMin,
      kind: 'maintain',
      confidence: 'low',
      reasoning: `Retry ${lastWeightUserUnit > 0 ? `${lastWeightUserUnit} ${unit} ` : ''}for ${repsMin}`,
      basedOnDate: lastSession.date,
    };
  });
}

// ============================================================================
// Personalized coach note (one line per exercise, shown on the scroll page)
// ============================================================================

export type CoachNoteTone = 'pr' | 'push' | 'steady' | 'recover' | 'new';

export interface CoachExerciseNote {
  text: string;
  tone: CoachNoteTone;
}

const fmtW = (n: number): string =>
  Number.isInteger(n) ? n.toString() : n.toFixed(1).replace(/\.0$/, '');

/**
 * Build the coach's one-liner for the current exercise. Deterministic but
 * personal: every message cites the user's OWN numbers (last session, all-time
 * best, deload math), so it reads like a coach who actually watched them train.
 * Returns null when there's nothing worth saying (no recs at all).
 */
export function buildCoachNote(args: {
  recs: SetRecommendation[];
  history: ExercisePerformanceLog[]; // raw kg logs (any order)
  unit: WeightUnit;
  exerciseName: string;
  firstName?: string | null;
}): CoachExerciseNote | null {
  const { recs, history, unit, firstName } = args;
  if (!recs || recs.length === 0) return null;

  const rec = recs.find((r) => r.setNumber === 1) ?? recs[0];
  const name = firstName?.trim() ? firstName.trim() : null;

  // All-time heaviest set (in the user's unit) for PR detection.
  const allTimeMax = history.reduce((max, h) => {
    const w = toUserUnit(h.weight_used, unit);
    return w > max ? w : max;
  }, 0);

  // Copy rule (matches coachReactions.ts): plain and short. Numbers first,
  // say exactly what to do, name the reference ("your best is 30 kg").
  if (rec.kind === 'new') {
    return {
      text: 'First time logging this one. Pick a weight you could do 2 more reps with.',
      tone: 'new',
    };
  }

  if (rec.kind === 'deload') {
    return {
      text: `Today: ${fmtW(rec.weight)} ${unit} — lighter on purpose after two hard sessions.`,
      tone: 'recover',
    };
  }

  if (rec.kind === 'increase') {
    // PR territory: the suggested weight meets or beats their all-time best.
    // "Ties" vs "beats" are different sentences — saying "30 is PR territory,
    // your heaviest is 30" read as a contradiction.
    if (allTimeMax > 0 && rec.weight > allTimeMax) {
      return {
        text: `${name ? `${name} — ` : ''}today's target is ${fmtW(rec.weight)} ${unit}. Your heaviest ever is ${fmtW(allTimeMax)}, so this would be a new record.`,
        tone: 'pr',
      };
    }
    if (allTimeMax > 0 && rec.weight >= allTimeMax) {
      return {
        text: `${name ? `${name} — ` : ''}today's target is ${fmtW(rec.weight)} ${unit} — that ties your heaviest ever. Brace hard, full range.`,
        tone: 'pr',
      };
    }
    return {
      text: `You hit the top of the rep range ${rec.basedOnDate ? phraseDaysAgo(rec.basedOnDate) : 'last time'}, so today the weight goes up to ${fmtW(rec.weight)} ${unit}.`,
      tone: 'push',
    };
  }

  // maintain
  return {
    text:
      rec.weight > 0
        ? `Same ${fmtW(rec.weight)} ${unit} as last session. Goal: one more rep than last time.`
        : `Last session you got ${rec.reps - 1 > 0 ? rec.reps - 1 : rec.reps} reps — aim for ${rec.reps} today.`,
    tone: 'steady',
  };
}
