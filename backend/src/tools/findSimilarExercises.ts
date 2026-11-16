/**
 * find_similar_exercises — pgvector-backed semantic similarity search.
 *
 * Where this beats the existing keyword `search_exercises`:
 *   - "Find me something like dumbbell bench press" returns biomechanically
 *     similar movements, not just lexical matches.
 *   - Equipment swaps that preserve stimulus: barbell bench → dumbbell bench,
 *     floor press, push-up — ranked by cosine similarity rather than name match.
 *   - Honors equipment + injury filters at the SQL level (see migration 018).
 *
 * Use when the user's intent is "give me an alternative to X" or "what's the
 * closest variation if I only have Y." For literal name lookup
 * ("add crunches"), `search_exercises` is still the right tool.
 *
 * Falls back gracefully: if pgvector returns nothing (e.g. embedding column
 * not yet backfilled), we emit a clear error the agent can act on rather
 * than silently returning [].
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { findSimilarExercises } from "../services/embeddings";

export const findSimilarExercisesTool = tool(
    async ({ query, equipment, avoidBodyParts, count, userId }) => {
        try {
            const matches = await findSimilarExercises({
                text: query,
                matchCount: count ?? 6,
                equipment: equipment && equipment.length > 0 ? equipment : undefined,
                avoidBodyParts:
                    avoidBodyParts && avoidBodyParts.length > 0 ? avoidBodyParts : undefined,
                userId,
            });

            if (matches.length === 0) {
                return {
                    success: false,
                    error:
                        "no_similar_exercises_found — embeddings may not be backfilled, or constraints (equipment / injuries) excluded everything",
                    exercises: [],
                };
            }

            return {
                success: true,
                count: matches.length,
                exercises: matches.map((m) => ({
                    id: m.id,
                    name: m.name,
                    equipment: m.equipment_display || m.equipment,
                    equipment_canonical: m.equipment_canonical ?? null,
                    target_muscle: m.target_muscle,
                    body_part: m.body_part,
                    movement_pattern: (m.enrichment as { movement_pattern?: string } | null)?.movement_pattern,
                    gif_path: m.gif_path,
                    similarity: Math.round(m.similarity * 1000) / 1000,
                })),
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                error: `find_similar_exercises failed: ${message}`,
                exercises: [],
            };
        }
    },
    {
        name: "find_similar_exercises",
        description:
            "Semantic similarity search for exercises using pgvector embeddings. Use when the user wants an alternative or variant of a known movement — e.g. 'something like bench press', 'what's similar to deadlift but easier on my back'. Honors equipment + injury filters. NOT for literal name lookup (use search_exercises for that).",
        schema: z.object({
            userId: z.string().describe("User ID — used for cost accrual on the embedding call"),
            query: z
                .string()
                .min(2)
                .describe(
                    "Free-form description. Examples: 'dumbbell bench press alternative', 'horizontal pushing without barbell', 'lower-back-friendly hip hinge'"
                ),
            equipment: z
                .array(z.string())
                .optional()
                .describe("Restrict results to these equipment types (canonical strings)"),
            avoidBodyParts: z
                .array(z.string())
                .optional()
                .describe("Skip exercises whose target_muscle or body_part matches any of these"),
            count: z
                .number()
                .int()
                .min(1)
                .max(20)
                .optional()
                .describe("Max matches to return (default 6)"),
        }),
    }
);
