/**
 * Memory sub-agent (silent / background).
 *
 * Runs at the tail of every supervisor-routed turn. Its job is to inspect the
 * last user/assistant exchange and quietly extract durable facts (injuries,
 * preferences, goals, pain patterns) into the Supabase profile via
 * `mutate_user_memory`.
 *
 * Design constraints:
 * - MUST emit zero user-visible SSE events. The chat stream emitter already
 *   handles this naturally because the node never sets `responseToUser`,
 *   `workout`, or `planUpdate` (its only state update is history compaction).
 * - MUST NOT add latency to the user response. We fire the LLM extraction +
 *   tool call as a detached promise (`void runMemoryExtraction(...)`) and
 *   return state immediately.
 * - Failures are logged but never propagated.
 */

import crypto from "crypto";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { archiveCoachMemory, upsertCoachMemory } from "../services/longTermMemory";
import {
    buildCompactionUpdate,
    buildRollingSummary,
    cacheableSystemMessage,
    splitForCompaction,
} from "./messageHelpers";
import { getAgentModel } from "./modelFactory";
import { mutateUserMemoryTool } from "./tools";
import type { GraphStateType } from "./state";

export const MEMORY_NODE_ID = "memory";

/** Lazy resolution so tests / env tweaks at process start are honored. */
const getExtractorLLM = () => getAgentModel("memory");

/**
 * Heuristic gate to skip the LLM extraction call entirely when nothing the
 * user said could plausibly produce a durable fact. Conservative — false
 * negatives are fine (we'd just miss a fact and can re-extract on a later
 * turn), but every short greeting that bypasses an LLM call is a saved cost.
 */
const DURABLE_SIGNALS = [
    /\b(injur|hurt|hurts|pain|painful|tweak|sore|sprain|strain|tear|tendon|knee|shoulder|elbow|wrist|ankle|back|hip|neck)\b/i,
    /\b(remember|forget|always|never|prefer|hate|love|dislike|allergic|cant|can't|cannot|can not)\b/i,
    // Natural preference / aversion phrasings the old gate missed.
    /\b(don'?t like|do not like|not a fan|can'?t do|cannot do|no access|don'?t have|do not have|doesn'?t have|don'?t enjoy|stop (doing|giving)|too (hard|easy)|again)\b/i,
    /\bmy gym (doesn'?t|does not|don'?t) have\b/i,
    /\b(goal|want to|trying to|aim|target|deadline|wedding|vacation|competition|meet)\b/i,
    /\b(diagnos|surgery|chronic|condition|medical|doctor|physical therap|pt session)\b/i,
];

function lastUserText(state: GraphStateType): string {
    for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i] as BaseMessage;
        if (m instanceof HumanMessage) return String(m.content);
    }
    return "";
}

function hasDurableSignal(text: string): boolean {
    if (!text || text.trim().length < 6) return false;
    return DURABLE_SIGNALS.some((re) => re.test(text));
}

const extractionSchema = z.object({
    facts: z.array(
        z.discriminatedUnion("kind", [
            z.object({
                kind: z.literal("add_injury"),
                label: z.string().min(2).describe("Short injury label, e.g. 'left shoulder — overhead pain'"),
            }),
            z.object({
                kind: z.literal("remove_injury"),
                label: z.string().min(2).describe("Injury to remove (case-insensitive)"),
            }),
            z.object({
                kind: z.literal("add_coach_fact"),
                fact: z.string().min(3).describe("Stable preference / context fact"),
            }),
            z.object({
                kind: z.literal("remove_coach_fact"),
                fact: z.string().min(3),
            }),
        ])
    ),
});

const extractionJsonSchema = {
    type: "object",
    properties: {
        facts: {
            type: "array",
            items: {
                type: "object",
                // anyOf, not oneOf: OpenAI's strict structured-output subset
                // supports anyOf only — oneOf hard-errors the request the day
                // anyone flips this call to strict mode. The branches are
                // mutually exclusive anyway (disjoint `kind` enums), so anyOf
                // validates identically.
                anyOf: [
                    {
                        type: "object",
                        properties: {
                            kind: { type: "string", enum: ["add_injury", "remove_injury"] },
                            label: { type: "string" },
                        },
                        required: ["kind", "label"],
                        additionalProperties: false,
                    },
                    {
                        type: "object",
                        properties: {
                            kind: { type: "string", enum: ["add_coach_fact", "remove_coach_fact"] },
                            fact: { type: "string" },
                        },
                        required: ["kind", "fact"],
                        additionalProperties: false,
                    },
                ],
            },
        },
    },
    required: ["facts"],
    additionalProperties: false,
} as const;

type ExtractedFact = z.infer<typeof extractionSchema>["facts"][number];

const EXTRACTION_PROMPT = [
    "You are a quiet long-term memory extractor for a fitness coach.",
    "Read the latest user/assistant exchange and decide whether the user shared any DURABLE fact worth saving across sessions:",
    "- new injury or pain pattern (add_injury)",
    "- recovery / resolution of a prior injury (remove_injury)",
    "- stable preference, dislike, goal, or life context (add_coach_fact)",
    "- explicit retraction of a previously stored fact (remove_coach_fact)",
    "Return STRICT JSON: { facts: [...] }. Empty array if nothing durable was said.",
    "Do NOT include fleeting requests (today's workout, single-session swaps) as facts.",
].join("\n");

function lastTwoExchanges(state: GraphStateType): string {
    const tail = state.messages.slice(-4);
    if (tail.length === 0) return "(no messages)";
    return tail
        .map((m) => `${m._getType()}: ${String(m.content).slice(0, 600)}`)
        .join("\n");
}

// ============================================================================
// CHECKPOINT COMPACTION SUMMARY (LLM-upgraded)
// ============================================================================

/** Compaction is rare (once per ~36 messages past the threshold); a short,
 *  bounded LLM call buys a summary that actually preserves decisions instead
 *  of the truncated line-concat digest. Hard timeout + deterministic fallback:
 *  compaction must never fail or stall the end of a turn. */
const SUMMARY_TIMEOUT_MS = Number(process.env.COMPACTION_SUMMARY_TIMEOUT_MS ?? 6_000);

const SUMMARY_PROMPT = [
    "You compress older fitness-coach chat turns into a compact memory digest.",
    "Write 5-10 short bullet lines capturing ONLY what still matters for future coaching:",
    "- durable facts (injuries, equipment, preferences, goals, schedule constraints)",
    "- decisions and changes that were APPLIED (swaps, plan edits, logged data, goal updates)",
    "- anything the coach promised or the user is still waiting on",
    "Omit greetings, small talk, and superseded back-and-forth. No preamble, bullets only.",
].join("\n");

async function summarizeOlderTurns(older: BaseMessage[]): Promise<string> {
    const fallback = buildRollingSummary(older);
    try {
        const transcript = older
            .map((m) => `${m._getType()}: ${String(m.content).replace(/\s+/g, " ").slice(0, 500)}`)
            .join("\n")
            // Model context guard — older windows are bounded (~36 msgs) but
            // workout JSON blobs can be long.
            .slice(0, 24_000);
        const result = await Promise.race([
            getExtractorLLM().invoke([
                cacheableSystemMessage(SUMMARY_PROMPT),
                new HumanMessage(transcript),
            ]),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("summary timeout")), SUMMARY_TIMEOUT_MS)
            ),
        ]);
        const text = typeof result.content === "string" ? result.content.trim() : "";
        return text.length > 0 ? text : fallback;
    } catch (err) {
        console.warn(
            "[memory] LLM compaction summary failed — using deterministic digest:",
            err instanceof Error ? err.message : err
        );
        return fallback;
    }
}

async function runMemoryExtraction(state: GraphStateType, taskId: string): Promise<void> {
    try {
        const structured = getExtractorLLM().withStructuredOutput(extractionJsonSchema, {
            name: "memory_extraction",
        });
        const result = (await structured.invoke([
            cacheableSystemMessage(EXTRACTION_PROMPT),
            new HumanMessage(lastTwoExchanges(state)),
        ])) as { facts: ExtractedFact[] };

        const facts = Array.isArray(result?.facts) ? result.facts : [];
        if (facts.length === 0) {
            console.log(`[memory:${taskId}] no durable facts detected`);
            return;
        }

        // Injuries are load-bearing on user_profiles.injuries (workout
        // generation and context both read it), so injury mutations still go
        // through the profile tool. Free-form coach facts live ONLY in the
        // categorized coach_memories table — the legacy JSONB dual-write was
        // retired once every read site moved to coach_memories.
        const injuryMutations = facts.filter(
            (f) => f.kind === "add_injury" || f.kind === "remove_injury"
        );
        if (injuryMutations.length > 0) {
            await mutateUserMemoryTool.invoke({
                userId: state.userId,
                mutations: injuryMutations,
            });
        }

        for (const f of facts) {
            try {
                if (f.kind === "add_injury") {
                    await upsertCoachMemory(state.userId, {
                        category: "injury",
                        fact: f.label,
                        confidence: 0.8,
                        source: "memory_extractor",
                    });
                } else if (f.kind === "remove_injury") {
                    await archiveCoachMemory(state.userId, {
                        category: "injury",
                        factSubstring: f.label,
                    });
                } else if (f.kind === "add_coach_fact") {
                    // Default new free-form facts to 'preference' — the
                    // extractor can't categorize precisely without more
                    // context. A future pass can re-classify into goal /
                    // life_context / training_phase using a tiny LLM call.
                    await upsertCoachMemory(state.userId, {
                        category: "preference",
                        fact: f.fact,
                        confidence: 0.7,
                        source: "memory_extractor",
                    });
                } else if (f.kind === "remove_coach_fact") {
                    await archiveCoachMemory(state.userId, { factSubstring: f.fact });
                }
            } catch (err) {
                console.warn(
                    `[memory:${taskId}] dual-write failed for ${f.kind} (non-fatal):`,
                    err instanceof Error ? err.message : err
                );
            }
        }

        console.log(`[memory:${taskId}] persisted ${facts.length} fact(s) for ${state.userId}`);
    } catch (err) {
        console.warn(
            `[memory:${taskId}] extraction/save failed (silent):`,
            err instanceof Error ? err.message : err
        );
    }
}

/**
 * Synchronous part of the memory node. Returns IMMEDIATELY without awaiting
 * the LLM extraction so the chat stream can close without delay.
 *
 * Cost gate: if the latest user message has no durable-fact signals
 * (greeting, "what's my plan today?", small-talk, etc.), we skip the LLM
 * call entirely. The original implementation fired extraction every turn —
 * this saves the bulk of memory-extraction spend on chat-heavy users.
 *
 * This node also runs end-of-turn CHECKPOINT COMPACTION: once the thread's
 * stored history exceeds the threshold, the older portion is collapsed into a
 * single summary message so the conversation_state blob stays bounded.
 */
export async function memoryNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
    if (!state.userId) {
        return {};
    }

    const userText = lastUserText(state);
    // Extract on explicit swap/replace turns (a swap is itself a preference
    // signal) or when the durable-signal gate trips. Deliberately NOT keyed on
    // activeAgent: the editor is the default agent for greetings and small
    // talk, so an activeAgent==="editor" bypass fired the extraction LLM on
    // nearly every casual message — pure spend with nothing to extract.
    const isEditTurn = /\b(swap|replace|change|sub(stitute)?)\b/i.test(userText);
    if (isEditTurn || hasDurableSignal(userText)) {
        const taskId = `mem-${crypto.randomBytes(4).toString("hex")}`;
        // Fire-and-forget: never await. If this throws, we swallow the error inside.
        void runMemoryExtraction(state, taskId);
    }

    const split = splitForCompaction(state.messages, {
        threshold: 60,
        keepRecent: 24,
    });
    if (split) {
        // LLM digest (bounded, rare) with deterministic fallback — the old
        // concat-and-truncate summary lost decisions on long threads.
        const summary = await summarizeOlderTurns(split.older);
        const compacted = buildCompactionUpdate(split.recent, summary);
        console.log(
            `[memory] compacted checkpoint history ${state.messages.length} → ${compacted.length} messages`
        );
        return { messages: compacted };
    }
    return {};
}
