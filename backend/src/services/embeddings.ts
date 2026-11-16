/**
 * Embeddings service.
 *
 * Thin wrapper around OpenAI's embeddings endpoint, used for:
 *   - Backfilling `exercises.embedding` so similarity search works.
 *   - Embedding ad-hoc query strings at runtime (e.g. find_similar_exercises).
 *
 * Design choices:
 *   - Model is env-driven (`EMBEDDING_MODEL`), default `text-embedding-3-small`
 *     to match the migration's pgvector dimension (1536). If you switch to
 *     -large you must rebuild the column with vector(3072).
 *   - Cost accrual flows through `model_pricing` (migration 018 seeds rows).
 *     We record cost manually after each call rather than via callbacks
 *     because the embeddings endpoint isn't a chat model.
 *   - Rate limiting / retry is intentionally minimal here. For the backfill
 *     job, use the `embedExerciseLibrary` helper which batches in groups of
 *     100 (OpenAI's per-request limit) and sleeps between batches.
 */

import { supabase } from "./db";
import { buildExerciseEmbeddingText } from "./exerciseEnrichment";

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

interface EmbedOptions {
    /** When set, accrues cost against this user's daily budget. */
    userId?: string;
}

interface OpenAIEmbeddingResponse {
    data: { embedding: number[]; index: number }[];
    usage: { prompt_tokens: number; total_tokens: number };
}

/** Hard wall per embeddings request — a hung call must not stall a chat turn. */
const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 10_000);

async function callOpenAIEmbeddings(
    inputs: string[]
): Promise<{ embeddings: number[][]; tokens: number }> {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("[embeddings] OPENAI_API_KEY is not set");
    }
    const attempt = () =>
        fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
            // Without this the fetch can hang indefinitely and the SSE
            // heartbeat keeps the chat stream open until the app's 5-minute
            // client timeout. Timeout + one retry bounds the worst case.
            signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
        });
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
        res = await attempt();
    } catch (firstErr) {
        console.warn(
            "[embeddings] request failed once, retrying:",
            firstErr instanceof Error ? firstErr.message : firstErr
        );
        res = await attempt();
    }
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`[embeddings] OpenAI ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    if (!Array.isArray(json.data) || json.data.length === 0) {
        throw new Error("[embeddings] empty response from OpenAI");
    }
    // Sort by index — OpenAI promises order but we double-check.
    const embeddings = [...json.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    return { embeddings, tokens: json.usage?.prompt_tokens ?? 0 };
}

async function accrueEmbeddingCost(userId: string | undefined, tokens: number): Promise<void> {
    if (!userId || tokens <= 0) return;
    try {
        const { data: pricing } = await supabase
            .from("model_pricing")
            .select("input_price_per_million")
            .eq("model_name", EMBEDDING_MODEL)
            .maybeSingle();
        const rate = (pricing as { input_price_per_million?: number } | null)?.input_price_per_million;
        if (!rate || rate <= 0) return;
        const cost = (tokens / 1_000_000) * rate;
        if (cost <= 0) return;
        await supabase.rpc("record_ai_cost", { p_cost_usd: cost, p_user_id: userId });
    } catch (err) {
        console.warn("[embeddings] cost accrual failed (non-fatal):", err);
    }
}

/**
 * Embed a single string. Use for runtime queries (e.g. similarity search from
 * a chat tool). Cost is accrued against the user when `userId` is provided.
 */
export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("[embeddings] empty text");
    const { embeddings, tokens } = await callOpenAIEmbeddings([trimmed]);
    await accrueEmbeddingCost(opts.userId, tokens);
    if (embeddings[0].length !== EMBEDDING_DIM) {
        throw new Error(
            `[embeddings] expected dim=${EMBEDDING_DIM}, got ${embeddings[0].length}. ` +
                `If you changed EMBEDDING_MODEL, also resize the exercises.embedding column.`
        );
    }
    return embeddings[0];
}

/**
 * Backfill `exercises.embedding` for any rows that don't have one (or that
 * were embedded with a different model). Idempotent — safe to run any time
 * a new exercise is added or the model changes.
 *
 * Usage:
 *   tsx -e "import('./src/services/embeddings').then(m => m.backfillExerciseEmbeddings())"
 */
export async function backfillExerciseEmbeddings(opts: { batchSize?: number; sleepMs?: number } = {}): Promise<{
    embedded: number;
    skipped: number;
}> {
    const batchSize = opts.batchSize ?? 64;
    const sleepMs = opts.sleepMs ?? 250;

    // Page through all exercises that either lack an embedding or were
    // embedded with a stale model. Limit to library rows that actually have
    // a gif (the same filter every search uses).
    let embedded = 0;
    let skipped = 0;
    let cursor: string | null = null;
    // We page by id, ascending, to avoid OFFSET cost on large libraries.
    while (true) {
        let q = supabase
            .from("exercises")
            .select(
                "id, name, target_muscle, body_part, equipment, secondary_muscles, instructions, description, equipment_canonical, equipment_display, enrichment, embedding_model"
            )
            .order("id", { ascending: true })
            .limit(batchSize);
        if (cursor) q = q.gt("id", cursor);
        const { data, error } = await q;
        if (error) throw new Error(`[embeddings] backfill query failed: ${error.message}`);
        if (!data || data.length === 0) break;

        const needs = data.filter(
            (row: any) =>
                !row.embedding_model || row.embedding_model !== EMBEDDING_MODEL
        );
        skipped += data.length - needs.length;

        if (needs.length > 0) {
            // Rich document: name + muscles + (clean) equipment + enrichment +
            // description + instructions. The previous builder dropped
            // description entirely and never reached instructions (it's a
            // text[], so the `typeof === "string"` branch was always false).
            const inputs = needs.map((row: any) => buildExerciseEmbeddingText(row));
            const { embeddings } = await callOpenAIEmbeddings(inputs);
            const now = new Date().toISOString();
            for (let i = 0; i < needs.length; i++) {
                const row: any = needs[i];
                const vec = embeddings[i];
                const { error: updErr } = await supabase
                    .from("exercises")
                    .update({
                        // pgvector accepts the literal `[1,2,3]` text form — Supabase
                        // serializes a number[] correctly via the JSON body.
                        embedding: vec as unknown as string,
                        embedding_model: EMBEDDING_MODEL,
                        embedding_updated_at: now,
                    })
                    .eq("id", row.id);
                if (updErr) {
                    console.warn(`[embeddings] update failed for ${row.id}: ${updErr.message}`);
                    skipped++;
                } else {
                    embedded++;
                }
            }
        }

        cursor = String(data[data.length - 1].id);
        if (data.length < batchSize) break;
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    }

    console.log(`[embeddings] backfill done: embedded=${embedded} skipped=${skipped}`);
    return { embedded, skipped };
}

/**
 * Similarity search wrapper — embed the query, call the pgvector RPC, return
 * scored matches. This is the building block for the
 * `find_similar_exercises` LangChain tool (added in Phase 3).
 */
export async function findSimilarExercises(query: {
    text: string;
    matchCount?: number;
    equipment?: string[];
    avoidBodyParts?: string[];
    userId?: string;
}): Promise<
    Array<{
        id: string;
        name: string;
        equipment: string | null;
        equipment_canonical?: string | null;
        equipment_display?: string | null;
        enrichment?: Record<string, unknown> | null;
        target_muscle: string | null;
        body_part: string | null;
        gif_path: string | null;
        similarity: number;
    }>
> {
    const vec = await embedText(query.text, { userId: query.userId });
    const { data, error } = await supabase.rpc("match_similar_exercises", {
        query_embedding: vec as unknown as string,
        match_count: query.matchCount ?? 8,
        equipment_filter:
            query.equipment && query.equipment.length > 0 ? query.equipment : null,
        avoid_body_parts:
            query.avoidBodyParts && query.avoidBodyParts.length > 0
                ? query.avoidBodyParts
                : null,
    });
    if (error) {
        throw new Error(`[embeddings] match_similar_exercises failed: ${error.message}`);
    }
    return (data ?? []) as any[];
}
