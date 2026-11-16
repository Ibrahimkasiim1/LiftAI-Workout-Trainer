/**
 * Nutrition cache for free-tier food logging.
 *
 * Caches `(raw_text → macros)` and `(raw_text + clarification choice → macros)`
 * so repeat logs skip the paid LLM parser. See migrations/019_nutrition_cache.sql.
 *
 * Only `high`-confidence parses (and post-clarification finals) are cached:
 * persisting an ambiguous result would suppress the clarification pill for
 * every future user with the same input.
 */

import { supabase } from "./db";

export type LookupSource = "usda" | "off" | "llm" | "heur";

export interface LookupResult {
  source: LookupSource;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  vitamin_a_mcg?: number;
  vitamin_c_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
}

/**
 * Normalize free-text into a stable cache key. Lowercase, punctuation-stripped,
 * whitespace-collapsed. Word order is preserved — different phrasings stay
 * distinct cache rows, which is harmless (the second one just populates on
 * first hit).
 */
export function normalizeQueryKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getCachedLookup(queryKey: string): Promise<LookupResult | null> {
  const { data, error } = await supabase
    .from("nutrition_cache")
    .select("*")
    .eq("query_key", queryKey)
    .maybeSingle();

  if (error || !data) return null;

  // Best-effort hit-count bump; failure is non-fatal (the read already succeeded).
  supabase
    .from("nutrition_cache")
    .update({ hit_count: (data.hit_count ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: bumpErr }) => {
      if (bumpErr) console.warn("nutrition_cache hit_count bump failed:", bumpErr.message);
    });

  return {
    source: data.source as LookupSource,
    calories: data.calories,
    protein: data.protein,
    carbs: data.carbs,
    fats: data.fats,
    vitamin_a_mcg: data.vitamin_a_mcg ?? undefined,
    vitamin_c_mg: data.vitamin_c_mg ?? undefined,
    calcium_mg: data.calcium_mg ?? undefined,
    iron_mg: data.iron_mg ?? undefined,
  };
}

export async function setCachedLookup(
  queryKey: string,
  rawText: string,
  result: LookupResult
): Promise<void> {
  const { error } = await supabase.from("nutrition_cache").upsert(
    {
      query_key: queryKey,
      raw_text: rawText,
      source: result.source,
      calories: result.calories,
      protein: result.protein,
      carbs: result.carbs,
      fats: result.fats,
      vitamin_a_mcg: result.vitamin_a_mcg ?? null,
      vitamin_c_mg: result.vitamin_c_mg ?? null,
      calcium_mg: result.calcium_mg ?? null,
      iron_mg: result.iron_mg ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "query_key" }
  );
  if (error) console.warn("nutrition_cache upsert failed:", error.message);
}
