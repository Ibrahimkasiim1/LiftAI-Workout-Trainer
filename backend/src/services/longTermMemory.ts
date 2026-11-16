/**
 * Long-term coach memory service.
 *
 * Lives alongside (does NOT replace, yet) the existing flat
 * `user_profiles.coach_memory` JSONB array. The new `coach_memories` table
 * adds:
 *   - structured categories (preferences, goals, training_phase, body_change, …)
 *   - confidence scores
 *   - expiry timestamps (so a goal tied to a wedding date archives itself)
 *   - source tracking (extractor vs manual vs voice)
 *   - soft-delete via `archived_at`
 *
 * Two-stage migration so we don't break running clients:
 *   Stage 1 (this file): write to BOTH the new table and the legacy column.
 *                        Reads union both sources.
 *   Stage 2 (future):    stop writing to the legacy column once we're confident
 *                        the table covers every read site.
 *
 * Naming: facts are deduped by (user_id, category, normalized fact text). A
 * duplicate "save" bumps `last_seen_at` + `confidence` rather than inserting
 * a second row, so heavy users don't accumulate near-duplicate clutter.
 */

import { supabase } from "./db";

export type MemoryCategory =
    | "preference"
    | "goal"
    | "injury"
    | "body_change"
    | "training_phase"
    | "life_context"
    | "equipment"
    | "food_pattern";

export interface CoachMemoryRecord {
    id: string;
    userId: string;
    category: MemoryCategory;
    fact: string;
    confidence: number;
    expiresAt: string | null;
    source: string;
    createdAt: string;
    lastSeenAt: string;
}

export interface MemoryUpsertInput {
    category: MemoryCategory;
    fact: string;
    confidence?: number; // default 0.7
    expiresAt?: string | null;
    source?: string; // default 'memory_extractor'
}

function normalizeFact(fact: string): string {
    return fact.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Upsert a memory by (user_id, category, normalized fact). Existing rows have
 * `last_seen_at` bumped and `confidence` averaged with the new score so a
 * fact mentioned twice gets stronger over time.
 */
export async function upsertCoachMemory(
    userId: string,
    input: MemoryUpsertInput
): Promise<{ inserted: boolean; id: string } | null> {
    const fact = input.fact.trim();
    if (!fact) return null;
    const normalized = normalizeFact(fact);
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));
    const source = input.source ?? "memory_extractor";

    // Look for an existing matching row. We compare on lower(fact) to dedupe
    // across capitalisation differences.
    const { data: existing, error: lookupErr } = await supabase
        .from("coach_memories")
        .select("id, confidence")
        .eq("user_id", userId)
        .eq("category", input.category)
        .is("archived_at", null)
        .ilike("fact", normalized)
        .limit(1)
        .maybeSingle();

    if (lookupErr) {
        console.warn(`[longTermMemory] upsert lookup failed: ${lookupErr.message}`);
        return null;
    }

    if (existing) {
        const blended = Math.min(1, ((existing.confidence as number) + confidence) / 2 + 0.05);
        const { error: updErr } = await supabase
            .from("coach_memories")
            .update({
                last_seen_at: new Date().toISOString(),
                confidence: blended,
                expires_at: input.expiresAt ?? null,
            })
            .eq("id", existing.id);
        if (updErr) {
            console.warn(`[longTermMemory] upsert update failed: ${updErr.message}`);
            return null;
        }
        return { inserted: false, id: existing.id as string };
    }

    const { data: inserted, error: insErr } = await supabase
        .from("coach_memories")
        .insert({
            user_id: userId,
            category: input.category,
            fact,
            confidence,
            expires_at: input.expiresAt ?? null,
            source,
        })
        .select("id")
        .single();

    if (insErr || !inserted) {
        console.warn(`[longTermMemory] upsert insert failed: ${insErr?.message}`);
        return null;
    }

    return { inserted: true, id: inserted.id as string };
}

/**
 * Soft-archive a memory. Use when the user explicitly retracts a fact
 * ("forget that I dislike cardio").
 */
export async function archiveCoachMemory(
    userId: string,
    opts: { id?: string; category?: MemoryCategory; factSubstring?: string }
): Promise<number> {
    let q = supabase
        .from("coach_memories")
        .update({ archived_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("archived_at", null);
    if (opts.id) q = q.eq("id", opts.id);
    if (opts.category) q = q.eq("category", opts.category);
    if (opts.factSubstring) q = q.ilike("fact", `%${opts.factSubstring.trim()}%`);
    // .select() after update returns the rows that were updated; we use length
    // as the archive count. Supabase update doesn't accept a separate count
    // option in this client version.
    const { data, error } = await q.select("id");
    if (error) {
        console.warn(`[longTermMemory] archive failed: ${error.message}`);
        return 0;
    }
    return Array.isArray(data) ? data.length : 0;
}

/**
 * Fetch a compact, agent-prompt-ready slice of a user's active memories,
 * grouped by category. Each category returns up to `perCategory` rows
 * sorted by recency × confidence. Backed by the SQL function defined in
 * migration 018 so this is a single round-trip.
 */
export async function getActiveCoachMemories(
    userId: string,
    perCategory = 5
): Promise<Record<MemoryCategory, string[]>> {
    const empty: Record<MemoryCategory, string[]> = {
        preference: [],
        goal: [],
        injury: [],
        body_change: [],
        training_phase: [],
        life_context: [],
        equipment: [],
        food_pattern: [],
    };

    const { data, error } = await supabase.rpc("get_active_coach_memories", {
        p_user_id: userId,
        p_per_category: perCategory,
    });

    if (error) {
        console.warn(`[longTermMemory] getActiveCoachMemories failed: ${error.message}`);
        return empty;
    }

    for (const row of (data ?? []) as { category: MemoryCategory; fact: string }[]) {
        if (row.category in empty) {
            empty[row.category].push(row.fact);
        }
    }
    return empty;
}

/**
 * Format the categorized memory map into a compact prompt block. Used by
 * `loadPromptUserContext` (chat route) once long-term memory replaces the
 * flat `coach_memory` array.
 */
export function formatMemoriesForPrompt(map: Record<MemoryCategory, string[]>): string {
    const sections: string[] = [];
    const labels: Record<MemoryCategory, string> = {
        preference: "Preferences",
        goal: "Goals",
        injury: "Injuries / pain patterns",
        body_change: "Body changes",
        training_phase: "Training phase",
        life_context: "Life context",
        equipment: "Equipment notes",
        food_pattern: "Food patterns",
    };
    for (const [category, facts] of Object.entries(map) as [MemoryCategory, string[]][]) {
        if (facts.length === 0) continue;
        const rendered = facts.map((f) => `  - ${f}`).join("\n");
        sections.push(`${labels[category]}:\n${rendered}`);
    }
    return sections.length === 0 ? "" : sections.join("\n\n");
}
