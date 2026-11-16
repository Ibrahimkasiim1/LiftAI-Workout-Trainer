/**
 * Shared message helpers — prompt caching, history truncation, safe prompt
 * boundaries.
 *
 * Two concerns live here so every agent can share one implementation:
 *
 * 1. Prompt caching. Anthropic supports cache_control breakpoints — every
 *    cache hit is billed at ~10% of fresh input. Our agent system prompts are
 *    100s of lines and identical across turns, so marking them cacheable is
 *    the single biggest cost lever we have. OpenAI ignores the marker, so
 *    `cacheableSystemMessage` is safe to use unconditionally.
 *
 * 2. History truncation. Right now `state.messages` accumulates indefinitely
 *    via the LangGraph reducer. After 30+ turns we re-send the entire history
 *    every call. `truncateHistory` keeps the last N turns verbatim and emits
 *    a single summary block for everything older. Anchored at the user (it
 *    truncates whole user/assistant pairs to keep tool-call sequencing valid).
 */

import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { HISTORY_COMPACTION_FLAG } from "./state";

/**
 * Build a SystemMessage that Anthropic models will treat as a cacheable
 * breakpoint. OpenAI ignores `cache_control` silently, so this is provider-safe.
 *
 * Use ONLY for stable, large prompts — caching is per-prefix-byte-identical, so
 * if you template per-user values into the prompt, the cache won't hit.
 */
export function cacheableSystemMessage(text: string): SystemMessage {
    return new SystemMessage({
        content: [
            {
                type: "text",
                text,
                cache_control: { type: "ephemeral" },
            },
        ],
    });
}

/**
 * Per-turn dynamic context (user message, recent conversation slice, runtime
 * date) that should NOT live in cache.
 *
 * Anthropic only permits a system message as the FIRST message in the list, so
 * this context is emitted as a HumanMessage rather than a second SystemMessage.
 * The leading cacheable system prompt remains the sole system message; this
 * block carries the volatile context as a user turn. OpenAI handles a leading
 * user context block identically, so this stays provider-safe.
 */
export function dynamicSystemMessage(text: string): HumanMessage {
    return new HumanMessage(text);
}

interface TruncateOptions {
    /** Keep at least this many recent messages verbatim. Default 12. */
    keepRecent?: number;
    /**
     * Hard cap on messages we ever return. Older content is collapsed into a
     * single summary AIMessage. Default 20 (15 recent + 1 summary slot leaves
     * headroom; we don't synthesize summaries inside this helper — the caller
     * supplies one when desired).
     */
    hardCap?: number;
    /** Pre-computed summary string for collapsed content. */
    summary?: string;
}

/**
 * Truncate `messages` to a sliding window of recent turns. Older content is
 * either dropped or collapsed into a synthetic system summary message at the
 * head of the returned array, depending on whether `summary` is provided.
 *
 * The window boundary is anchored at a HumanMessage so we never split a
 * user/assistant/tool sequence in a way that breaks tool-call linkage.
 */
export function truncateHistory(messages: BaseMessage[], opts: TruncateOptions = {}): BaseMessage[] {
    const keepRecent = Math.max(opts.keepRecent ?? 12, 4);
    const hardCap = Math.max(opts.hardCap ?? 20, keepRecent + 1);

    if (messages.length <= hardCap) return messages;

    // Walk backward to find a window of at least `keepRecent` messages that
    // starts on a HumanMessage. This avoids dangling tool messages or
    // assistant-only fragments at the head of the truncated window.
    let cut = Math.max(messages.length - keepRecent, 0);
    while (cut > 0 && !(messages[cut] instanceof HumanMessage)) {
        cut--;
    }
    // If we walked all the way back, fall back to the simple recent-N slice.
    if (cut === 0 && !(messages[0] instanceof HumanMessage)) {
        cut = messages.length - keepRecent;
    }

    const recent = messages.slice(cut);
    if (opts.summary && opts.summary.trim().length > 0) {
        // Carried as a HumanMessage, not a SystemMessage: Anthropic only permits
        // a system message at index 0, and this digest is injected mid-list
        // (after the agent's leading cacheable system prompt). See
        // dynamicSystemMessage for the same constraint.
        return [
            new HumanMessage(`[CONVERSATION SUMMARY — older turns]\n${opts.summary.trim()}`),
            ...recent,
        ];
    }
    return recent;
}

/**
 * Lightweight rolling summary — just concatenates older messages into a short
 * digest. Cheap, deterministic, no LLM call. The supervisor or memory subgraph
 * can later upgrade this to an LLM-summarized digest if needed.
 */
export function buildRollingSummary(older: BaseMessage[]): string {
    if (older.length === 0) return "";
    const lines: string[] = [];
    for (const m of older) {
        const role = m instanceof HumanMessage
            ? "user"
            : m instanceof AIMessage
                ? "assistant"
                : m instanceof ToolMessage
                    ? "tool"
                    : m._getType();
        const txt = String(m.content).replace(/\s+/g, " ").trim();
        if (!txt) continue;
        lines.push(`- ${role}: ${txt.slice(0, 200)}`);
    }
    return lines.slice(-30).join("\n");
}

/**
 * End-of-turn checkpoint compaction. `summarizedTruncate` only trims what we
 * SEND per LLM call — the checkpointed history in `conversation_state` still
 * grows forever. Once a thread exceeds `threshold` messages, collapse the
 * older portion into a single summary message and keep the recent window.
 *
 * The returned array's first message carries HISTORY_COMPACTION_FLAG in
 * `additional_kwargs`, which tells the `messages` reducer in ./state to
 * REPLACE the stored history with this array instead of appending.
 *
 * Returns `null` when no compaction is needed (caller should send no update).
 */
/**
 * Decide the compaction split without building the summary. Returns null when
 * no compaction is needed. Extracted so callers (the memory node) can generate
 * a higher-quality LLM summary for `older` and then assemble the update with
 * `buildCompactionUpdate` — while `compactHistoryForCheckpoint` stays a sync,
 * deterministic wrapper for everything else (including tests).
 */
export function splitForCompaction(
    messages: BaseMessage[],
    opts: { threshold?: number; keepRecent?: number } = {}
): { older: BaseMessage[]; recent: BaseMessage[] } | null {
    const threshold = Math.max(opts.threshold ?? 60, 10);
    const keepRecent = Math.max(opts.keepRecent ?? 24, 4);
    if (messages.length <= threshold) return null;

    // Anchor the kept window on a HumanMessage (same rule as truncateHistory)
    // so we never strand a tool/assistant fragment at the head.
    let cut = Math.max(messages.length - keepRecent, 0);
    while (cut > 0 && !(messages[cut] instanceof HumanMessage)) cut--;
    if (cut <= 0) return null;

    return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

/** Assemble the flagged replacement array from a summary + the kept window. */
export function buildCompactionUpdate(recent: BaseMessage[], summary: string): BaseMessage[] {
    const marker = new HumanMessage({
        content: `[CONVERSATION SUMMARY — older turns]\n${summary || "(no salient details)"}`,
        additional_kwargs: { [HISTORY_COMPACTION_FLAG]: true },
    });
    return [marker, ...recent];
}

export function compactHistoryForCheckpoint(
    messages: BaseMessage[],
    opts: { threshold?: number; keepRecent?: number } = {}
): BaseMessage[] | null {
    const split = splitForCompaction(messages, opts);
    if (!split) return null;
    return buildCompactionUpdate(split.recent, buildRollingSummary(split.older));
}

/**
 * Convenience: split history into (older, recent) and build a summary for the
 * older portion in one shot.
 */
export function summarizedTruncate(
    messages: BaseMessage[],
    opts: { keepRecent?: number; hardCap?: number } = {}
): BaseMessage[] {
    const keepRecent = Math.max(opts.keepRecent ?? 12, 4);
    const hardCap = Math.max(opts.hardCap ?? 20, keepRecent + 1);

    if (messages.length <= hardCap) return messages;

    let cut = Math.max(messages.length - keepRecent, 0);
    while (cut > 0 && !(messages[cut] instanceof HumanMessage)) cut--;
    if (cut === 0 && !(messages[0] instanceof HumanMessage)) {
        cut = messages.length - keepRecent;
    }

    const older = messages.slice(0, cut);
    const recent = messages.slice(cut);
    const summary = buildRollingSummary(older);
    if (!summary) return recent;
    // HumanMessage, not SystemMessage: Anthropic rejects a system message at any
    // index but 0, and this digest sits mid-list after the agent's leading
    // cacheable system prompt.
    return [new HumanMessage(`[CONVERSATION SUMMARY — older turns]\n${summary}`), ...recent];
}
