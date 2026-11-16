/**
 * Warmup / Cooldown suggestions (client)
 *
 * Surfaces the `mobility` and `stretching` rows that already live in the
 * exercise library but were never shown. Given the body parts a workout trains,
 * returns a small region-matched block (dynamic mobility to warm up, static
 * stretches to cool down), topping up from the wider category when a region is
 * thin so the block is never empty.
 *
 * Read-only suggestions — these are NOT logged sets, so they stay out of the
 * set-logging player and don't count toward volume/PRs.
 */

import { supabase } from './supabase';

export interface PhaseExercise {
  id: string;
  name: string;
  gif_path: string | null;
  target_muscle: string | null;
  body_part: string | null;
  instructions: string[] | null;
}

const COLS = 'id, name, gif_path, target_muscle, body_part, instructions';

async function fetchPhase(
  category: 'mobility' | 'stretching',
  bodyParts: string[],
  limit: number,
): Promise<PhaseExercise[]> {
  const base = () =>
    (supabase as any)
      .from('exercises')
      .select(COLS)
      .eq('category', category)
      .not('gif_path', 'is', null)
      .neq('gif_path', '');

  let rows: PhaseExercise[] = [];
  if (bodyParts.length) {
    const { data } = await base().in('body_part', bodyParts).limit(limit * 2);
    rows = (data ?? []) as PhaseExercise[];
  }

  if (rows.length < limit) {
    const { data } = await base().limit(limit * 3);
    const seen = new Set(rows.map((r) => r.id));
    for (const r of (data ?? []) as PhaseExercise[]) {
      if (rows.length >= limit) break;
      if (!seen.has(r.id)) {
        rows.push(r);
        seen.add(r.id);
      }
    }
  }

  return rows.slice(0, limit);
}

/** Distinct body parts an exercise list trains, mapped to the DB taxonomy. */
export function bodyPartsFromExercises(
  exercises: Array<{ body_part?: string | null }>,
): string[] {
  const set = new Set<string>();
  for (const ex of exercises) {
    const bp = (ex.body_part || '').trim().toLowerCase();
    if (bp) set.add(bp);
  }
  return [...set];
}

export function fetchWarmup(bodyParts: string[], limit = 3): Promise<PhaseExercise[]> {
  return fetchPhase('mobility', bodyParts, limit);
}

export function fetchCooldown(bodyParts: string[], limit = 3): Promise<PhaseExercise[]> {
  return fetchPhase('stretching', bodyParts, limit);
}
