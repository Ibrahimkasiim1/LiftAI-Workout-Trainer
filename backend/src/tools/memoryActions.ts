/**
 * Memory Action Tools
 *
 * DynamicStructuredTool implementations for the Memory subgraph and any other
 * agent that needs to durably store or retrieve user-level context. Both
 * tools target the dedicated `coach_memory` table introduced in migration
 * `011_create_coach_memory_table.sql`.
 *
 * - `save_core_memory` upserts ONE durable fact row.
 * - `fetch_user_context` reads from `coach_memory` and `user_contexts`
 *   together and renders a concise context blob suitable for LLM prompts.
 *
 * The legacy `mutate_user_memory` tool in `agents/tools.ts` stays in place;
 * these new tools are the canonical write path for the new architecture.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
    formatMemoriesForPrompt,
    getActiveCoachMemories,
    upsertCoachMemory,
} from "../services/longTermMemory";

// ============================================================================
// SHARED HELPERS
// ============================================================================

const MEMORY_CATEGORIES = [
    "injury",
    "preference",
    "equipment",
    "goal",
    "lifestyle",
    "note",
] as const;

function describeError(error: unknown, context: string): string {
    if (error instanceof Error) return `${context}: ${error.message}`;
    if (typeof error === "object" && error && "message" in error) {
        return `${context}: ${String((error as { message: unknown }).message)}`;
    }
    return `${context}: ${String(error)}`;
}

interface CoachMemoryRow {
    id: string;
    category: string;
    memory_text: string;
    confidence: number | null;
    source: string | null;
    created_at: string;
    updated_at: string;
}

interface UserContextRow {
    id: string;
    context_type: string;
    context_data: Record<string, unknown> | null;
    expires_at: string | null;
    created_at: string;
}

export interface FormattedUserContextResult {
    success: boolean;
    formattedContext: string;
    coachMemory: CoachMemoryRow[];
    userContexts: UserContextRow[];
    counts: {
        coachMemory: number;
        userContexts: number;
    };
    error?: string;
}

function summarizeMemoryRows(rows: CoachMemoryRow[]): string[] {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
        const list = grouped.get(row.category) ?? [];
        list.push(row.memory_text);
        grouped.set(row.category, list);
    }
    const lines: string[] = [];
    for (const category of MEMORY_CATEGORIES) {
        const items = grouped.get(category);
        if (!items || items.length === 0) continue;
        lines.push(`- ${category}: ${items.join(" | ")}`);
    }
    return lines;
}

function summarizeContextRows(rows: UserContextRow[]): string[] {
    if (rows.length === 0) return [];
    const lines: string[] = [];
    for (const row of rows) {
        const data = row.context_data ?? {};
        const summary = Object.entries(data)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
        const expires = row.expires_at ? ` (expires ${row.expires_at})` : "";
        lines.push(`- ${row.context_type}${expires}: ${summary || "no details"}`);
    }
    return lines;
}

// ============================================================================
// PURE CONTEXT FETCH LOGIC (shared by route + tool)
// ============================================================================

export async function getFormattedUserContext(
    userId: string,
    options?: {
        categories?: ReadonlyArray<(typeof MEMORY_CATEGORIES)[number]>;
        maxRows?: number;
    }
): Promise<FormattedUserContextResult> {
    try {
        // Single source of truth: the categorized coach_memories table (via
        // the get_active_coach_memories RPC). The legacy `coach_memory` table
        // (0 rows) and the never-created `user_contexts` table are retired —
        // querying them cost a round-trip per chat turn for nothing.
        const memoryList: CoachMemoryRow[] = [];
        const contextList: UserContextRow[] = [];

        let categorizedSection = "";
        try {
            const map = await getActiveCoachMemories(userId, 5);
            categorizedSection = formatMemoriesForPrompt(map);
        } catch (err) {
            console.warn(
                "[memoryActions] getActiveCoachMemories failed (non-fatal):",
                err instanceof Error ? err.message : err
            );
        }

        const memoryLines = summarizeMemoryRows(memoryList);
        const contextLines = summarizeContextRows(contextList);

        const sections: string[] = [];
        if (categorizedSection.length > 0) {
            sections.push("Long-term Coach Memory (categorized):\n" + categorizedSection);
        }
        if (memoryLines.length > 0) {
            sections.push("Coach Memory (legacy flat):\n" + memoryLines.join("\n"));
        }
        if (contextLines.length > 0) {
            sections.push("Active User Contexts:\n" + contextLines.join("\n"));
        }

        const formattedContext =
            sections.length > 0
                ? sections.join("\n\n")
                : "No durable coach memory or active user contexts on file.";

        return {
            success: true,
            formattedContext,
            coachMemory: memoryList,
            userContexts: contextList,
            counts: {
                coachMemory: memoryList.length,
                userContexts: contextList.length,
            },
        };
    } catch (err) {
        return {
            success: false,
            error: describeError(err, "getFormattedUserContext threw"),
            formattedContext: "",
            coachMemory: [],
            userContexts: [],
            counts: {
                coachMemory: 0,
                userContexts: 0,
            },
        };
    }
}

// ============================================================================
// save_core_memory
// ============================================================================

export const saveCoreMemoryTool = new DynamicStructuredTool({
    name: "save_core_memory",
    description:
        "Persist ONE durable fact about the user into `coach_memory`. " +
        "Use for content that should outlive the current chat (injuries, equipment access, training preferences, lifestyle, goals). " +
        "Each call inserts (or updates if a near-duplicate already exists) a single row keyed by (user_id, category, lowercased text). " +
        "Do NOT use for transient session state — that belongs in `user_contexts` via the existing temporary-override flow.",
    schema: z
        .object({
            user_id: z.string(),
            category: z
                .enum(MEMORY_CATEGORIES)
                .describe(
                    "Coarse bucket: injury | preference | equipment | goal | lifestyle | note"
                ),
            memory_text: z
                .string()
                .min(2)
                .max(1000)
                .describe(
                    "Short factual statement, e.g. 'left shoulder — overhead pressing irritates' or 'prefers full-body workouts on weekends'."
                ),
            confidence: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe(
                    "Optional 0..1 score representing extraction confidence. Helpful when called from background subgraphs."
                ),
            source: z
                .string()
                .max(120)
                .optional()
                .describe(
                    "Optional provenance tag, e.g. 'memory_subgraph' or 'user_explicit'."
                ),
        })
        .strict(),
    func: async ({ user_id, category, memory_text, confidence, source }) => {
        try {
            const trimmed = memory_text.trim();
            if (!trimmed) {
                return {
                    success: false,
                    error: "memory_text was empty after trimming.",
                };
            }

            // Canonical store is the categorized coach_memories table (the
            // legacy `coach_memory` table is retired). upsertCoachMemory
            // dedupes on (user, category, normalized fact) and blends
            // confidence upward on repeat mentions.
            const categoryMap: Record<string, "injury" | "preference" | "equipment" | "goal" | "life_context"> = {
                injury: "injury",
                preference: "preference",
                equipment: "equipment",
                goal: "goal",
                lifestyle: "life_context",
                note: "life_context",
            };
            const mapped = categoryMap[category] ?? "preference";

            const result = await upsertCoachMemory(user_id, {
                category: mapped,
                fact: trimmed,
                confidence: confidence ?? 0.7,
                source: source ?? "save_core_memory",
            });

            if (!result) {
                return {
                    success: false,
                    error: "Failed to save memory to coach_memories.",
                };
            }

            return {
                success: true,
                memoryId: result.id,
                category: mapped,
                deduplicated: !result.inserted,
                message: result.inserted
                    ? `Saved new ${mapped} memory.`
                    : `Reinforced existing ${mapped} memory.`,
            };
        } catch (err) {
            return {
                success: false,
                error: describeError(err, "save_core_memory threw"),
            };
        }
    },
});

// ============================================================================
// fetch_user_context
// ============================================================================

export const fetchUserContextTool = new DynamicStructuredTool({
    name: "fetch_user_context",
    description:
        "Read durable user context for system-prompt injection. Pulls non-archived rows from `coach_memory` " +
        "(grouped by category) and active rows from `user_contexts` (non-expired). Returns both a structured " +
        "object and a pre-rendered `formattedContext` string suitable for direct inclusion in an LLM prompt. " +
        "Read-only: never mutates anything.",
    schema: z
        .object({
            user_id: z.string(),
            categories: z
                .array(z.enum(MEMORY_CATEGORIES))
                .optional()
                .describe(
                    "Optional category filter. When omitted, all categories are returned."
                ),
            max_rows: z
                .number()
                .int()
                .min(1)
                .max(200)
                .default(50)
                .describe("Cap on coach_memory rows returned (default 50)."),
        })
        .strict(),
    func: async ({ user_id, categories, max_rows }) => {
        return getFormattedUserContext(user_id, {
            categories,
            maxRows: max_rows,
        });
    },
});

// ============================================================================
// EXPORT BUNDLE
// ============================================================================

export const memoryActionTools = [saveCoreMemoryTool, fetchUserContextTool];
