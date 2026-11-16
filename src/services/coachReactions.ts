/**
 * In-workout coach reactions — short lines the coach "says" after a logged
 * set, but ONLY at moments that warrant a coach's intervention:
 *
 *   • a PR (heavier than last session, or more reps at the same load)
 *   • clearly more in the tank (well over target) → suggest going up
 *   • a meaningful shortfall (2+ reps down, or short twice in a row)
 *     → suggest adjusting the weight, with a sore/tired-aware variant
 *   • a smart stop on a sore/tired day (short by one)
 *   • the first-ever set of a brand-new exercise (baseline)
 *
 * Routine sets — target hit, nothing notable — return null and the coach
 * stays quiet. Reacting to every set reads as noise, not coaching.
 *
 * COPY RULES (plain and short — users found coach-speak confusing):
 *   1. Numbers first, past tense: "You got 6 of 8 reps."
 *   2. Comparisons name their reference: "last session: 67.5 kg × 11".
 *   3. Suggestions name a CONCRETE weight on the user's plate grid
 *      (weightStep) with a short plain reason ("that weight looks heavy
 *      today"). One or two short sentences, no filler — the ⓘ disclaimer
 *      already covers "you decide".
 *
 * No LLM call: everything is computed from numbers already on the device,
 * so reactions are instant and work offline. Variety comes from small
 * template pools picked by a deterministic seed of the set context —
 * phrasing rotates, but the same input always produces the same line
 * (safe across re-renders; Math.random would break that).
 */

export type SessionFeeling = 'fresh' | 'good' | 'tired' | 'sore';

export interface SetReactionInput {
  exerciseName: string;
  setNumber: number;
  totalSets: number;
  /** What the user just logged (weight in display units; 0 for bodyweight). */
  reps: number;
  weight: number;
  unit: 'kg' | 'lbs';
  isBodyweight: boolean;
  /** Planned reps for this set (coach rec, else the plan's low end). */
  targetReps: number | null;
  /** Smallest plate/dumbbell increment in display units (0 = bodyweight or
   *  unknown — suggestions fall back to non-numeric wording). */
  weightStep: number;
  /** Last session's same-numbered set, display units. */
  ghost: { weight: number; reps: number } | null;
  feeling: SessionFeeling | null;
  isLastSetOfExercise: boolean;
  /** The previous set this exercise also came in under target. */
  wasShortLastSetToo?: boolean;
}

export interface SetReaction {
  text: string;
  /** True when the message contains a forward-looking suggestion (shows the ⓘ disclaimer affordance). */
  isSuggestion: boolean;
}

const pick = (pool: string[], seed: number): string => pool[Math.abs(seed) % pool.length];

/** Returns a coach reaction for notable sets, or null when there's nothing worth saying. */
export function buildSetReaction(i: SetReactionInput): SetReaction | null {
  const seed = i.setNumber * 7 + i.reps * 3 + Math.round(i.weight);
  const w = (n: number) => `${n} ${i.unit}`;
  const lowTank = i.feeling === 'tired' || i.feeling === 'sore';
  const target = i.targetReps && i.targetReps > 0 ? i.targetReps : null;
  const ghost = i.ghost && i.ghost.reps > 0 ? i.ghost : null;
  const didLabel = i.isBodyweight || i.weight <= 0 ? `${i.reps} reps` : `${w(i.weight)} × ${i.reps}`;

  // Comparable ghost = same loading style (both weighted or both bodyweight).
  const ghostComparable = ghost && (i.isBodyweight ? ghost.weight <= 0 : ghost.weight > 0);
  const beatWeight =
    !!ghostComparable && !i.isBodyweight && i.weight > ghost!.weight && i.reps >= Math.min(ghost!.reps, target ?? ghost!.reps);
  const beatReps =
    !!ghostComparable && !beatWeight && (i.isBodyweight || i.weight >= ghost!.weight) && i.reps > ghost!.reps;

  let text: string | null = null;
  let isSuggestion = false;

  if (beatWeight) {
    // PR on load — a congratulation about the set JUST completed.
    text = pick(
      [
        `New top weight: ${didLabel}. Last session: ${w(ghost!.weight)} × ${ghost!.reps}. Nice work.`,
        `${didLabel} — heavier than last session (${w(ghost!.weight)}). Nice work.`,
      ],
      seed
    );
    if (lowTank) text += ` On a ${i.feeling} day, too.`;
  } else if (beatReps) {
    const extra = i.reps - ghost!.reps;
    text = pick(
      [
        `${didLabel} — ${extra} more rep${extra === 1 ? '' : 's'} than last session. Progress.`,
        `${didLabel} — last session you got ${ghost!.reps}. Keep this up and we'll add weight.`,
      ],
      seed
    );
  } else if (target && i.reps >= target + 2) {
    isSuggestion = true;
    // Concrete next weight on the user's plate grid; "next session" when this
    // exercise has no next set. Bodyweight/unknown step → non-numeric wording.
    const canSuggestWeight = !i.isBodyweight && i.weight > 0 && i.weightStep > 0;
    const upWeight = canSuggestWeight ? i.weight + i.weightStep : null;
    const when = i.isLastSetOfExercise ? 'next session' : 'next set';
    text = pick(
      upWeight != null
        ? [
            `You got ${i.reps} reps — target was ${target}. That's easy for you now. Try ${w(upWeight)} ${when}.`,
            `${i.reps} reps, target was ${target}. ${w(i.weight)} looks light for you — try ${w(upWeight)} ${when}.`,
          ]
        : [
            `You got ${i.reps} reps — target was ${target}. Too easy — try a harder variation ${when}.`,
          ],
      seed
    );
  } else if (target && i.reps < target) {
    const short = target - i.reps;
    if (short >= 2 || i.wasShortLastSetToo) {
      isSuggestion = true;
      const canSuggestWeight = !i.isBodyweight && i.weight > 0 && i.weightStep > 0 && i.weight - i.weightStep > 0;
      const downWeight = canSuggestWeight ? i.weight - i.weightStep : null;
      const when = i.isLastSetOfExercise ? 'next session' : 'next set';
      const why = i.wasShortLastSetToo ? 'Two short sets in a row' : 'This weight looks heavy today';
      text = pick(
        lowTank
          ? downWeight != null
            ? [
                `You got ${i.reps} of ${target} reps and you're ${i.feeling}. Try ${w(downWeight)} ${when} — lighter and clean.`,
                `${i.reps} of ${target} reps on a ${i.feeling} day. Drop to ${w(downWeight)} ${when}.`,
              ]
            : [
                `You got ${i.reps} of ${target} reps and you're ${i.feeling}. Go a bit easier ${when}.`,
              ]
          : downWeight != null
            ? [
                `You got ${i.reps} of ${target} reps. ${why} — try ${w(downWeight)} ${when} to hit all your reps.`,
                `${i.reps} of ${target} reps. ${why} — drop to ${w(downWeight)} ${when}.`,
              ]
            : [
                `You got ${i.reps} of ${target} reps. ${why} — go a bit easier ${when}.`,
              ],
        seed
      );
    } else if (short === 1 && lowTank) {
      text = pick(
        [
          `${i.reps} of ${target} reps — a good place to stop on a ${i.feeling} day.`,
          `One rep short of ${target} — that's fine today. Clean reps still count.`,
        ],
        seed
      );
    }
    // Short by one on a normal day: stay quiet — the next set will tell us.
  } else if (!ghostComparable && i.setNumber === 1 && target && i.reps >= target) {
    text = pick(
      [
        `First time logging ${i.exerciseName}: ${didLabel} is your baseline. Next session we beat it.`,
        `${didLabel} logged — your starting point on ${i.exerciseName}.`,
      ],
      seed
    );
  }
  // Target hit, nothing notable → null. The coach doesn't narrate routine work.

  if (text && i.isLastSetOfExercise) {
    text += ` ${pick(
      [
        `That's ${i.exerciseName} done.`,
        `That wraps ${i.exerciseName}.`,
        `${i.exerciseName} in the books.`,
      ],
      seed + i.totalSets
    )}`;
  }

  return text ? { text, isSuggestion } : null;
}
