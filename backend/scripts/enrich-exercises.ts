/**
 * Enrich + re-embed the exercise library.
 *
 * For every exercise that needs it, this:
 *   1. Calls the LLM to produce clean equipment (canonical + display) and
 *      biomechanics metadata (see exerciseEnrichment.ts).
 *   2. Composes a rich embedding document from raw fields + the enrichment
 *      (this is what fixes the old, under-fed vectors).
 *   3. Re-embeds with OpenAI text-embedding-3-small (1536-dim, matches the
 *      column) and writes enrichment + embedding back in one update.
 *
 * Idempotent: rows whose `enrichment_model` already matches are skipped unless
 * --force is passed.
 *
 * Usage:
 *   npm run enrich:exercises -- --limit 5 --dry     # preview 5, no writes
 *   npm run enrich:exercises -- --limit 25          # write 25
 *   npm run enrich:exercises                          # full library
 *   npm run enrich:exercises -- --force              # re-enrich everything
 *
 * Flags:
 *   --limit N     process at most N exercises (default: all)
 *   --batch N     embedding batch size (default 64)
 *   --concurrency N  parallel LLM calls (default 6)
 *   --dry         do everything except write to the DB; prints samples
 *   --force       re-enrich rows even if already enriched by this model
 */

import "dotenv/config";
import { OpenAIEmbeddings } from "@langchain/openai";
import { supabase } from "../src/services/db";
import {
    buildExerciseEmbeddingText,
    enrichExercise,
    getEnrichmentModelName,
    type ExerciseEnrichment,
    type ExerciseRow,
} from "../src/services/exerciseEnrichment";

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const LIMIT = arg("limit") ? parseInt(arg("limit")!, 10) : Infinity;
const PAGE = parseInt(arg("batch") ?? "64", 10);
const CONCURRENCY = parseInt(arg("concurrency") ?? "6", 10);
const DRY = flag("dry");
const FORCE = flag("force");

const embedder = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: EMBEDDING_MODEL,
});

const SELECT =
    "id, name, target_muscle, body_part, equipment, secondary_muscles, instructions, description, enrichment_model";

/** Map an array through an async fn with bounded concurrency. */
async function mapPool<T, R>(
    items: T[],
    n: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

async function main() {
    const enrichmentModel = getEnrichmentModelName();
    console.log(
        `[enrich] model=${enrichmentModel} embed=${EMBEDDING_MODEL} ` +
            `limit=${LIMIT === Infinity ? "all" : LIMIT} dry=${DRY} force=${FORCE}`
    );

    let processed = 0;
    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let cursor: string | null = null;

    while (processed < LIMIT) {
        let q = supabase.from("exercises").select(SELECT).order("id", { ascending: true }).limit(PAGE);
        if (cursor) q = q.gt("id", cursor);
        const { data, error } = await q;
        if (error) throw new Error(`[enrich] query failed: ${error.message}`);
        if (!data || data.length === 0) break;
        cursor = String(data[data.length - 1].id);

        const todo = (data as any[]).filter(
            (r) => FORCE || !r.enrichment_model || r.enrichment_model !== enrichmentModel
        );
        skipped += data.length - todo.length;

        const slice = todo.slice(0, Math.max(0, LIMIT - processed));
        if (slice.length === 0) {
            if (data.length < PAGE) break;
            continue;
        }

        // 1) Enrich (bounded concurrency).
        const results = await mapPool(slice, CONCURRENCY, async (row: ExerciseRow) => {
            try {
                const enrichment = await enrichExercise(row);
                return { row, enrichment, ok: true as const };
            } catch (err) {
                console.warn(`[enrich] FAILED ${row.id} (${row.name}): ${(err as Error).message}`);
                return { row, ok: false as const };
            }
        });
        const good = results.filter(
            (r): r is { row: ExerciseRow; enrichment: ExerciseEnrichment; ok: true } => r.ok
        );
        failed += results.length - good.length;

        // 2) Compose rich text + 3) embed the whole batch in one OpenAI call.
        const texts = good.map((g) =>
            buildExerciseEmbeddingText({ ...g.row, enrichment: g.enrichment })
        );
        const vectors = texts.length ? await embedder.embedDocuments(texts) : [];

        if (DRY) {
            for (let i = 0; i < Math.min(2, good.length); i++) {
                console.log("\n──────────", good[i].row.name, "──────────");
                console.log("equipment_raw   :", good[i].row.equipment);
                console.log("equipment_canon :", good[i].enrichment.equipment_canonical);
                console.log("equipment_display:", good[i].enrichment.equipment_display);
                console.log("enrichment      :", JSON.stringify(good[i].enrichment));
                console.log("embed_text      :\n" + texts[i]);
                console.log("embed_dim       :", vectors[i]?.length);
            }
        } else {
            const now = new Date().toISOString();
            await mapPool(good, CONCURRENCY, async (g, idx) => {
                const vec = vectors[idx];
                if (!vec || vec.length !== EMBEDDING_DIM) {
                    console.warn(`[enrich] bad vector dim for ${g.row.id}; skipping write`);
                    failed++;
                    return;
                }
                const { error: updErr } = await supabase
                    .from("exercises")
                    .update({
                        equipment_canonical: g.enrichment.equipment_canonical,
                        equipment_display: g.enrichment.equipment_display,
                        enrichment: g.enrichment as unknown as Record<string, unknown>,
                        enriched_at: now,
                        enrichment_model: enrichmentModel,
                        embedding: vec as unknown as string,
                        embedding_model: EMBEDDING_MODEL,
                        embedding_updated_at: now,
                    })
                    .eq("id", g.row.id);
                if (updErr) {
                    console.warn(`[enrich] write failed ${g.row.id}: ${updErr.message}`);
                    failed++;
                } else {
                    enriched++;
                }
            });
        }

        processed += slice.length;
        console.log(
            `[enrich] processed=${processed} enriched=${enriched} skipped=${skipped} failed=${failed}`
        );
        if (data.length < PAGE) break;
    }

    console.log(
        `\n[enrich] DONE — processed=${processed} enriched=${enriched} skipped=${skipped} failed=${failed}${
            DRY ? " (dry run, nothing written)" : ""
        }`
    );
    process.exit(0);
}

main().catch((err) => {
    console.error("[enrich] fatal:", err);
    process.exit(1);
});
