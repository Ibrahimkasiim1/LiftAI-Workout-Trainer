/**
 * Exercise Name Formatting
 *
 * The exercise DB stores raw ExerciseDB names: all lowercase, frequently with a
 * parenthetical qualifier ("cable rear delt row (with rope)") and occasional
 * version suffixes ("cable pushdown (straight arm) v. 2"). Those raw strings are
 * the matching key for the backend + exercise_performance history, so they must
 * NEVER be mutated in payloads — only at render time.
 *
 * This module is the single canonical place that turns a raw name into something
 * premium-looking for display. Use `formatExerciseName` for a one-line label, or
 * `formatExerciseNameParts` when the UI can show a title + a smaller qualifier.
 */

// Tokens that should render in fixed casing rather than naive Title Case.
const ACRONYMS: Record<string, string> = {
  ez: 'EZ',
  'v-bar': 'V-Bar',
  vbar: 'V-Bar',
  rdl: 'RDL',
  ohp: 'OHP',
  emom: 'EMOM',
  amrap: 'AMRAP',
  iso: 'ISO',
  ii: 'II',
  iii: 'III',
};

// Small words stay lowercase unless they lead the phrase.
const MINOR_WORDS = new Set(['with', 'and', 'to', 'on', 'the', 'of', 'a', 'in', 'for', 'per', 'or']);

/** Remove "v. 2" / "version 2" / "v2" style suffixes the source data carries. */
function stripVersion(s: string): string {
  return s
    .replace(/\bv(?:er(?:sion)?)?\.?\s*\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface ExerciseNameParts {
  /** Main label, e.g. "Cable Rear Delt Row". */
  title: string;
  /** Qualifier pulled from parentheses, e.g. "With Rope" — or null. */
  modifier: string | null;
}

/**
 * Split a raw name into its base phrase and the first parenthetical qualifier.
 * Any additional parentheticals are dropped (the source rarely has more than one
 * meaningful one, and stacking them reads cluttered).
 */
function splitName(raw: string): { base: string; modifier: string | null } {
  let s = stripVersion((raw ?? '').trim());
  const m = s.match(/\(([^)]*)\)/);
  let modifier: string | null = null;
  if (m) {
    modifier = m[1].trim() || null;
    s = s.replace(/\s*\([^)]*\)/g, '').trim();
  }
  return { base: s, modifier };
}

/** Title-case a phrase, honoring acronyms, minor words, and hyphenated tokens. */
export function titleCase(phrase: string): string {
  const words = (phrase ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return words
    .map((word, i) => {
      const key = word.replace(/[^a-z0-9-]/g, '');
      if (ACRONYMS[key]) return ACRONYMS[key];
      if (i > 0 && MINOR_WORDS.has(key)) return key;
      // Capitalize each hyphen-separated segment ("sit-up" -> "Sit-Up").
      return word
        .split('-')
        .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join('-');
    })
    .join(' ');
}

/** Premium one-line label for an exercise name. */
export function formatExerciseName(raw: string | null | undefined): string {
  const { base } = splitName(raw ?? '');
  return titleCase(base) || 'Exercise';
}

/** Title + optional qualifier, for UIs that can show a secondary line. */
export function formatExerciseNameParts(raw: string | null | undefined): ExerciseNameParts {
  const { base, modifier } = splitName(raw ?? '');
  return {
    title: titleCase(base) || 'Exercise',
    modifier: modifier ? titleCase(modifier) : null,
  };
}
