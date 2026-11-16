/**
 * Model factory.
 *
 * Single place that decides which LLM each role uses. Env-driven so we can
 * tune per-agent without redeploying:
 *
 *   SUPERVISOR_MODEL    (default: gpt-4.1-mini)
 *   PLANNER_MODEL       (default: gpt-4.1)
 *   EDITOR_MODEL        (default: gpt-4.1)
 *   ANALYST_MODEL       (default: gpt-4.1)
 *   MEMORY_MODEL        (default: gpt-4.1-mini)
 *   NUTRITION_MODEL     (default: gpt-4.1-mini)
 *   PLANNER_BATCH_MODEL (default: gpt-4.1-mini — onboarding plan gen; OpenAI's strict json_schema avoids OUTPUT_PARSING_FAILURE)
 *
 * Chat roles run on OpenAI: gpt-4.1 follows the structured decision contract
 * more reliably on follow-up turns than claude-haiku-4-5 did. Keep
 * model_pricing rows in sync when changing these — models without a pricing
 * row accrue $0 against the daily quota gate.
 *
 * Provider is inferred from the model name prefix (`claude-` → Anthropic,
 * `gpt-` → OpenAI). The returned model is wrapped in a thin caching layer so
 * repeated calls with the same role + temperature reuse the same instance.
 *
 * The `record_ai_cost` RPC pipeline (usageTracking.ts) keys cost on the
 * `model_name` field returned by LangChain at LLM start. Both ChatAnthropic
 * and ChatOpenAI populate that field, so cost accrual works unchanged — we
 * only need pricing rows for the new model names (see migration 018).
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export type AgentRole =
    | "supervisor"
    | "planner"
    | "editor"
    | "analyst"
    | "memory"
    | "nutrition"
    | "planner_batch";

export type Provider = "anthropic" | "openai";

// Decision agents (planner/editor/analyst): strongest non-reasoning OpenAI
// model — instruction-following quality on multi-turn tool decisions is the
// product here. Reasoning models (gpt-5 family / o-series) are deliberately
// NOT defaults: they reject the `temperature` param this factory always sets
// and add latency to every chat turn.
const DEFAULT_DECISION = "gpt-4.1";
// Small structured-output roles (routing decision, fact extraction, macro
// JSON, onboarding batch): gpt-4.1-mini is fast, cheap, and follows strict
// json_schema reliably.
const DEFAULT_SMALL = "gpt-4.1-mini";
const DEFAULT_PLANNER_BATCH = DEFAULT_SMALL;

// Per-role output ceilings: billing is per actual token, so these don't cut
// average cost — they bound the worst case (a runaway/looping generation).
// Roles with tiny structured outputs (routing decision, fact extraction,
// macro JSON) get tight caps; decision agents keep headroom for tool args.
// Decision agents (planner/editor/analyst) emit ONE JSON object that must
// carry a batched toolCalls array (STEP 1b tells the model to put every
// search in a single turn) PLUS thought + responseToUser. At 2048 max output
// tokens those turns TRUNCATE, the JSON fails to parse, and the user gets the
// generic "could you rephrase?" fallback — the exact bug users report as
// "chat randomly says it can't respond". 4096 gives batched turns headroom;
// billing is per actual token so the ceiling only bounds runaway generations.
const ROLE_DEFAULTS: Record<
    AgentRole,
    { model: string; envKey: string; temperature: number; maxTokens: number }
> = {
    supervisor:    { model: DEFAULT_SMALL,         envKey: "SUPERVISOR_MODEL",    temperature: 0,   maxTokens: 512 },
    planner:       { model: DEFAULT_DECISION,      envKey: "PLANNER_MODEL",       temperature: 0.4, maxTokens: 4096 },
    editor:        { model: DEFAULT_DECISION,      envKey: "EDITOR_MODEL",        temperature: 0.5, maxTokens: 4096 },
    analyst:       { model: DEFAULT_DECISION,      envKey: "ANALYST_MODEL",       temperature: 0.3, maxTokens: 4096 },
    memory:        { model: DEFAULT_SMALL,         envKey: "MEMORY_MODEL",        temperature: 0,   maxTokens: 512 },
    nutrition:     { model: DEFAULT_SMALL,         envKey: "NUTRITION_MODEL",     temperature: 0,   maxTokens: 768 },
    planner_batch: { model: DEFAULT_PLANNER_BATCH, envKey: "PLANNER_BATCH_MODEL", temperature: 0.4, maxTokens: 4096 },
};

export function detectProvider(model: string): Provider {
    if (model.startsWith("claude-")) return "anthropic";
    return "openai";
}

export function resolveModelName(role: AgentRole): string {
    const cfg = ROLE_DEFAULTS[role];
    const fromEnv = process.env[cfg.envKey];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    return cfg.model;
}

interface BuildOptions {
    /** Override role default temperature. */
    temperature?: number;
    /** Max output tokens (Anthropic requires it; we set a sane default). */
    maxTokens?: number;
    /** Explicit model override (mini-first policy). Beats role default AND env. */
    model?: string;
}

/**
 * Mini-first policy for the decision agents (editor/analyst).
 *
 * Most coach turns — a single swap, a schedule shift, "what's my workout
 * today?" — don't need the full decision model. The supervisor classifies
 * each turn's complexity alongside its routing decision; simple turns run on
 * the small model (~5x cheaper, faster first token), and anything complex,
 * unclassified, or on a validation retry escalates to the role's full model.
 *
 * The planner is exempt: whole-plan builds are the highest-stakes output in
 * the product and always run the full decision model.
 *
 * AGENT_SIMPLE_MODEL overrides the small model choice without a redeploy.
 */
export function resolveDecisionModel(
    role: AgentRole,
    complexity: "simple" | "complex" | null | undefined,
    escalated: boolean
): string {
    const fullModel = resolveModelName(role);
    if (role !== "editor" && role !== "analyst") return fullModel;
    if (escalated || complexity !== "simple") return fullModel;
    const simple = process.env.AGENT_SIMPLE_MODEL;
    return simple && simple.trim().length > 0 ? simple.trim() : DEFAULT_SMALL;
}

const cache = new Map<string, BaseChatModel>();

export function getAgentModel(role: AgentRole, opts: BuildOptions = {}): BaseChatModel {
    const cfg = ROLE_DEFAULTS[role];
    const model = opts.model?.trim() || resolveModelName(role);
    const provider = detectProvider(model);
    const temperature = opts.temperature ?? cfg.temperature;
    const maxTokens = opts.maxTokens ?? cfg.maxTokens;

    // Chat-side roles stream tokens so LangGraph's "messages" stream mode can
    // forward incremental text to the SSE route (final responses are still
    // aggregated for withStructuredOutput, and usage_metadata survives —
    // Anthropic stream_usage / OpenAI streamUsage are on by default, so cost
    // accrual in usageTracking keeps working). planner_batch (onboarding) is
    // a non-interactive batch call; leave it unstreamed.
    const streaming = role !== "planner_batch";

    const cacheKey = `${role}|${model}|${temperature}|${maxTokens}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let instance: BaseChatModel;
    if (provider === "anthropic") {
        // Lazy require so OpenAI-only deployments don't need the dep installed.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ChatAnthropic } = require("@langchain/anthropic");
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error(
                `[modelFactory] ANTHROPIC_API_KEY not set, but role "${role}" resolved to Anthropic model "${model}". ` +
                    `Set ANTHROPIC_API_KEY or override ${cfg.envKey} with an OpenAI model.`
            );
        }
        instance = new ChatAnthropic({
            model,
            temperature,
            maxTokens,
            streaming,
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
    } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ChatOpenAI } = require("@langchain/openai");
        instance = new ChatOpenAI({
            model,
            temperature,
            maxTokens,
            streaming,
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    cache.set(cacheKey, instance);
    return instance;
}

/**
 * Returns whether the model bound to a role currently supports Anthropic
 * prompt caching (cache_control breakpoints). Used by message helpers.
 */
export function roleSupportsPromptCaching(role: AgentRole): boolean {
    return detectProvider(resolveModelName(role)) === "anthropic";
}
