/**
 * Supabase Exercise Search Service
 *
 * Provides vector search capabilities using Supabase RPC exclusively.
 * Query embeddings use OpenAI text-embedding-3-small to match DB vector(1536).
 */

import { OpenAIEmbeddings } from "@langchain/openai";
import { supabase } from "../services/db";
import { ExerciseDetail } from "../types";
import { prescriptionForGoal } from "./workoutPrescription";

// ============================================================================
// EMBEDDINGS CLIENT
// ============================================================================

const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: "text-embedding-3-small",
    // A hung embeddings call stalls the whole tool turn (the SSE heartbeat
    // keeps the stream open until the app's 5-minute timeout). Bound it.
    timeout: 10_000,
    maxRetries: 1,
});

// ============================================================================
// QUERY EMBEDDING CACHE
// ============================================================================
//
// Exercise-search queries repeat constantly ("chest", "biceps", "dumbbell back
// exercises", and the fixed regional queries in oneOffWorkoutSearch), and each
// one paid a fresh OpenAI round-trip (~100-300ms + cost) per call. Queries are
// case/whitespace-normalized, the vocabulary is small, and embeddings are
// deterministic for a given model — a simple in-process LRU removes the
// network hop from nearly every search after warm-up.

const EMBEDDING_CACHE_MAX = Number(process.env.QUERY_EMBEDDING_CACHE_MAX ?? 500);
const embeddingCache = new Map<string, number[]>();

function cacheKeyFor(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheGet(query: string): number[] | undefined {
    const key = cacheKeyFor(query);
    const hit = embeddingCache.get(key);
    if (hit) {
        // Refresh recency (Map preserves insertion order → delete+set = LRU touch).
        embeddingCache.delete(key);
        embeddingCache.set(key, hit);
    }
    return hit;
}

function cacheSet(query: string, vector: number[]): void {
    const key = cacheKeyFor(query);
    if (!key) return;
    embeddingCache.delete(key);
    embeddingCache.set(key, vector);
    while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
        const oldest = embeddingCache.keys().next().value;
        if (oldest === undefined) break;
        embeddingCache.delete(oldest);
    }
}

/** Embed one query through the cache. */
async function embedQueryCached(query: string): Promise<number[]> {
    const hit = cacheGet(query);
    if (hit) return hit;
    const vector = await embeddings.embedQuery(query);
    cacheSet(query, vector);
    return vector;
}

/**
 * Embed many queries: cached ones are served locally, the misses go to OpenAI
 * in ONE embedDocuments call, and results are reassembled in input order.
 */
async function embedDocumentsCached(queries: string[]): Promise<number[][]> {
    const out: (number[] | null)[] = queries.map((q) => cacheGet(q) ?? null);
    const missIdx = out.flatMap((v, i) => (v === null ? [i] : []));
    if (missIdx.length > 0) {
        const fresh = await embeddings.embedDocuments(missIdx.map((i) => queries[i]));
        missIdx.forEach((qi, fi) => {
            out[qi] = fresh[fi];
            cacheSet(queries[qi], fresh[fi]);
        });
    }
    return out as number[][];
}

// ============================================================================
// LOCAL TYPE DEFINITIONS
// ============================================================================

interface DatabaseExerciseResult {
    id: string;
    name: string;
    target_muscle?: string;
    body_part?: string;
    equipment?: string;
    equipment_canonical?: string | null;
    equipment_display?: string | null;
    enrichment?: Record<string, unknown> | null;
    difficulty?: string;
    gif_path?: string;
    instructions?: string[];
    similarity?: number;
}

/**
 * Convert database result to ExerciseDetail.
 *
 * The default set/rep/rest prescription is goal-aware when a `goal` is supplied
 * (swaps, quick workouts, search fallbacks). Callers that don't know the goal
 * keep the historical `3 × 8-12 @ 90s` shape — `prescriptionForGoal(undefined)`
 * returns exactly that.
 */
function toExerciseDetail(
    row: DatabaseExerciseResult,
    goal?: string | null,
    fitnessLevel?: string | null
): ExerciseDetail {
    const rx = prescriptionForGoal(goal, fitnessLevel);
    return {
        id: row.id,
        name: row.name,
        // REQUIRED: gif_path must be string (empty string if missing, will be filtered by validation)
        gif_path: row.gif_path || '',
        target_muscle: row.target_muscle || null,
        body_part: row.body_part || null,
        equipment: row.equipment || null,
        // Clean equipment for display + enrichment metadata. Fall back to raw
        // equipment so unenriched rows still render something sensible.
        equipment_canonical: row.equipment_canonical || null,
        equipment_display: row.equipment_display || row.equipment || null,
        enrichment: (row.enrichment as ExerciseDetail["enrichment"]) || null,
        difficulty: row.difficulty || null,
        instructions: row.instructions || null,
        sets: rx.sets,
        reps: rx.reps,
        rest_seconds: rx.rest_seconds,
    };
}

// ============================================================================
// CORE SEARCH FUNCTION - SUPABASE RPC
// ============================================================================

export interface SearchExercisesParams {
    query: string;
    matchCount?: number;
    /**
     * Minimum hybrid similarity score (0..1, the `similarity` column returned
     * by the search_exercises RPC) a row must reach to be returned. Applied
     * client-side after the RPC. Omit for no floor.
     */
    matchThreshold?: number;
    filterEquipment?: string[];
    /** When set, returned exercises get a goal-appropriate sets/reps/rest default. */
    goal?: string | null;
    /** Used with `goal` to keep beginner volume conservative. */
    fitnessLevel?: string | null;
}

/** Drop rows below the requested hybrid-score floor (no-op when unset). */
function applyMatchThreshold(
    rows: DatabaseExerciseResult[],
    matchThreshold?: number
): DatabaseExerciseResult[] {
    if (typeof matchThreshold !== "number" || matchThreshold <= 0) return rows;
    return rows.filter((r) => (r.similarity ?? 0) >= matchThreshold);
}

/**
 * Map common user / model phrasing to values stored in exercises.equipment
 * (see trainer system prompt DATABASE EQUIPMENT VALUES).
 */
export function expandEquipmentFilters(filterEquipment?: string[]): string[] | undefined {
    if (!filterEquipment || filterEquipment.length === 0) {
        return undefined;
    }
    const out = new Set<string>();
    for (const raw of filterEquipment) {
        const s = raw.trim();
        if (!s) continue;
        const low = s.toLowerCase();
        const onlyMatch = low.match(/^(.+?)\s+only$/);
        const normalizedInput = onlyMatch ? onlyMatch[1].trim() : low;
        // Emit CANONICAL buckets (exercises.equipment_canonical). The search
        // RPC matches the filter against equipment_canonical OR raw equipment,
        // so a single "machine" now covers every leverage/assisted/sled variant.
        if (
            normalizedInput === "bodyweight" ||
            normalizedInput === "body weight" ||
            normalizedInput === "no equipment" ||
            normalizedInput === "home" ||
            normalizedInput === "weighted"
        ) {
            out.add("body weight");
        } else if (normalizedInput === "dumbbells" || normalizedInput === "dumbbell" || normalizedInput === "db" || normalizedInput === "dbs") {
            out.add("dumbbell");
        } else if (normalizedInput === "bands" || normalizedInput === "band" || normalizedInput === "resistance bands" || normalizedInput === "resistance band") {
            out.add("band");
        } else if (normalizedInput === "kettlebells" || normalizedInput === "kettlebell") {
            out.add("kettlebell");
        } else if (normalizedInput === "barbells" || normalizedInput === "barbell" || normalizedInput === "olympic barbell" || normalizedInput === "trap bar") {
            out.add("barbell");
        } else if (normalizedInput === "cables" || normalizedInput === "cable" || normalizedInput === "rope") {
            out.add("cable");
        } else if (
            normalizedInput === "machine" ||
            normalizedInput === "machines" ||
            normalizedInput === "leverage machine" ||
            normalizedInput === "assisted" ||
            normalizedInput === "sled machine"
        ) {
            out.add("machine");
        } else if (normalizedInput === "smith machine" || normalizedInput === "smith") {
            out.add("smith machine");
        } else if (normalizedInput === "ez bar" || normalizedInput === "ez-bar" || normalizedInput === "ez curl bar" || normalizedInput === "ez barbell") {
            out.add("ez barbell");
        } else if (normalizedInput === "pull-up bar" || normalizedInput === "pull up bar" || normalizedInput === "chin-up bar") {
            // Pull-up/chin-up bar = bodyweight movements; assisted versions are machines.
            out.add("body weight");
            out.add("machine");
        } else if (
            normalizedInput === "ball" ||
            normalizedInput === "exercise ball" ||
            normalizedInput === "stability ball" ||
            normalizedInput === "medicine ball" ||
            normalizedInput === "bosu ball" ||
            normalizedInput === "swiss ball"
        ) {
            out.add("ball");
        } else if (normalizedInput === "bench") {
            out.add("bench");
        } else {
            out.add(normalizedInput);
        }
    }
    return out.size > 0 ? [...out] : undefined;
}

export interface SearchExercisesResult {
    success: boolean;
    exercises: ExerciseDetail[];
    error?: string;
}

export function serializeSearchResultsForLlm(exercises: ExerciseDetail[]): string {
    const mappedResults = exercises
        .filter((ex) => Boolean(ex.id))
        .map((ex) => {
            const e = ex.enrichment;
            return {
                id: String(ex.id),
                name: ex.name,
                // Clean, disambiguated equipment (e.g. "Chest Press Machine")
                // plus the canonical bucket the user may have filtered on.
                equipment: ex.equipment_display || ex.equipment || "unknown",
                equipment_canonical: ex.equipment_canonical || ex.equipment || "unknown",
                target_muscle: ex.target_muscle || "unknown",
                // Enrichment so the model can pick by movement quality, not just name.
                movement_pattern: e?.movement_pattern,
                mechanics: e?.mechanics,
                unilateral: e?.unilateral,
                primary_goal: e?.primary_goal,
                joint_friendly: e?.joint_friendly?.length ? e.joint_friendly : undefined,
                aliases: e?.aliases?.length ? e.aliases : undefined,
            };
        });

    return JSON.stringify(mappedResults, null, 2);
}

/**
 * Batch-search many queries in parallel.
 *
 * Generates all query embeddings in ONE OpenAI call (`embedDocuments`) and then
 * fans out the Supabase RPC calls with `Promise.all`. This collapses what was
 * previously N sequential network round-trips (one embedQuery + one RPC per
 * query) into 1 embedding call + N parallel RPCs, which is the dominant
 * latency win for initial workout generation.
 */
export async function searchExercisesBatch(
    paramsList: SearchExercisesParams[]
): Promise<SearchExercisesResult[]> {
    if (paramsList.length === 0) return [];

    const queries = paramsList.map((p) => p.query);
    let embeddingsList: number[][];
    try {
        embeddingsList = await embedDocumentsCached(queries);
    } catch (error) {
        console.error("Batched embedDocuments failed:", error);
        return paramsList.map(() => ({
            success: false,
            exercises: [],
            error: error instanceof Error ? error.message : "Embedding failed",
        }));
    }

    return Promise.all(
        paramsList.map(async (params, idx) => {
            const {
                query,
                matchCount = 12,
                matchThreshold,
                filterEquipment: rawFilter,
                goal,
                fitnessLevel,
            } = params;
            const filterEquipment = expandEquipmentFilters(rawFilter);
            const embeddingString = `[${embeddingsList[idx].join(",")}]`;
            try {
                const { data, error } = await supabase.rpc("search_exercises", {
                    query_text: query,
                    query_embedding: embeddingString,
                    match_count: matchCount,
                    equipment_filter: filterEquipment || null,
                });
                if (error) {
                    return { success: false, exercises: [], error: error.message };
                }
                if (!data || data.length === 0) {
                    return { success: true, exercises: [] };
                }
                const exercises: ExerciseDetail[] = applyMatchThreshold(
                    data as DatabaseExerciseResult[],
                    matchThreshold
                ).map((result: DatabaseExerciseResult) => toExerciseDetail(result, goal, fitnessLevel));
                return { success: true, exercises };
            } catch (error) {
                return {
                    success: false,
                    exercises: [],
                    error: error instanceof Error ? error.message : "Search failed",
                };
            }
        })
    );
}

/**
 * Search for exercises using Supabase vector search RPC
 * This is the ONLY vector search method - no Pinecone fallback
 */
export async function searchExercises(
    params: SearchExercisesParams
): Promise<SearchExercisesResult> {
    const {
        query,
        matchCount = 12,
        matchThreshold,
        filterEquipment: rawFilter,
        goal,
        fitnessLevel,
    } = params;

    const filterEquipment = expandEquipmentFilters(rawFilter);

    try {
        // Generate embedding for query (in-process LRU absorbs repeats)
        const queryEmbedding = await embedQueryCached(query);

        // Convert to string format for Supabase
        const embeddingString = `[${queryEmbedding.join(",")}]`;

        // Call Supabase RPC
        const { data, error } = await supabase.rpc("search_exercises", {
            query_text: query,
            query_embedding: embeddingString,
            match_count: matchCount,
            equipment_filter: filterEquipment || null,
        });

        if (error) {
            console.error("Supabase search_exercises RPC error:", error);
            return {
                success: false,
                exercises: [],
                error: error.message,
            };
        }

        if (!data || data.length === 0) {
            return { success: true, exercises: [] };
        }

        // Convert to ExerciseDetail format
        const exercises: ExerciseDetail[] = applyMatchThreshold(
            data as DatabaseExerciseResult[],
            matchThreshold
        ).map((result: DatabaseExerciseResult) => toExerciseDetail(result, goal, fitnessLevel));

        console.log(`Found ${exercises.length} exercises via Supabase vector search`);
        return { success: true, exercises };
    } catch (error) {
        console.error("Error in searchExercises:", error);
        return {
            success: false,
            exercises: [],
            error: error instanceof Error ? error.message : "Search failed",
        };
    }
}

// ============================================================================
// SPECIALIZED SEARCH FUNCTIONS
// ============================================================================

/**
 * Find exercises for a specific muscle group with equipment filter
 */
export async function findExercisesForMuscle(
    muscleGroup: string,
    equipment: string[],
    limit: number = 6
): Promise<ExerciseDetail[]> {
    const result = await searchExercises({
        query: `${muscleGroup} strength training exercises`,
        matchCount: limit,
        filterEquipment: equipment.length > 0 ? equipment : undefined,
    });

    return result.exercises;
}

/**
 * Find similar exercises (for substitutions)
 */
export async function findSimilarExercises(
    exerciseName: string,
    availableEquipment: string[],
    limit: number = 5
): Promise<ExerciseDetail[]> {
    const result = await searchExercises({
        query: `exercises similar to ${exerciseName}`,
        matchCount: limit,
        filterEquipment: availableEquipment.length > 0 ? availableEquipment : undefined,
    });

    // Filter out the original exercise
    return result.exercises.filter(
        (ex) => ex.name.toLowerCase() !== exerciseName.toLowerCase()
    );
}

/**
 * Find equipment alternatives for an exercise
 */
export async function findEquipmentAlternatives(
    exerciseName: string,
    targetEquipment: string[],
    limit: number = 5
): Promise<ExerciseDetail[]> {
    // First, search for the original exercise to get its target muscle
    const { data: originalExercise } = await supabase
        .from("exercises")
        .select("target_muscle, body_part")
        .eq("name", exerciseName)
        .single();

    if (!originalExercise) {
        // If not found, do a general similar exercise search
        return findSimilarExercises(exerciseName, targetEquipment, limit);
    }

    // Search for exercises targeting the same muscle with allowed equipment
    const result = await searchExercises({
        query: `${originalExercise.target_muscle || originalExercise.body_part} exercises`,
        matchCount: limit + 1,
        filterEquipment: targetEquipment,
    });

    // Filter out the original exercise
    return result.exercises.filter(
        (ex) => ex.name.toLowerCase() !== exerciseName.toLowerCase()
    );
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate that exercises exist in the database
 * Returns validated exercises, replacing invalid ones with alternatives
 */
export async function validateExercises(
    exercises: ExerciseDetail[],
    availableEquipment: string[]
): Promise<ExerciseDetail[]> {
    const validatedExercises: ExerciseDetail[] = [];

    for (const exercise of exercises) {
        // Check if exercise exists
        const { data: existing } = await supabase
            .from("exercises")
            .select("id, name, target_muscle, body_part, equipment, gif_path")
            .ilike("name", exercise.name)
            .limit(1)
            .single();

        if (existing) {
            // Exercise exists, merge with workout params
            validatedExercises.push({
                ...exercise,
                id: existing.id,
                target_muscle: existing.target_muscle,
                body_part: existing.body_part,
                equipment: existing.equipment,
                gif_path: existing.gif_path,
            });
        } else {
            // Exercise not found, find alternative
            console.log(`Exercise not found: "${exercise.name}", finding alternative`);

            const alternatives = await findSimilarExercises(
                exercise.name,
                availableEquipment,
                1
            );

            if (alternatives.length > 0) {
                const alt = alternatives[0];
                validatedExercises.push({
                    ...alt,
                    sets: exercise.sets,
                    reps: exercise.reps,
                    rest_seconds: exercise.rest_seconds,
                });
                console.log(`Replaced with: "${alt.name}"`);
            } else {
                // No alternative found, skip this exercise
                console.log(`Could not find alternative for: "${exercise.name}"`);
            }
        }
    }

    return validatedExercises;
}

/**
 * Get exercise by exact name
 */
export async function getExerciseByName(
    name: string
): Promise<ExerciseDetail | null> {
    const { data, error } = await supabase
        .from("exercises")
        .select("*")
        .ilike("name", name)
        .limit(1)
        .single();

    if (error || !data) {
        return null;
    }

    return toExerciseDetail(data);
}

/**
 * Get exercise by ID
 */
export async function getExerciseById(id: string): Promise<ExerciseDetail | null> {
    const { data, error } = await supabase
        .from("exercises")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) {
        return null;
    }

    return toExerciseDetail(data);
}
