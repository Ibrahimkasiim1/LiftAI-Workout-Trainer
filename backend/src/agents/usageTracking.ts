/**
 * LangChain callback that tallies LLM token cost and writes it to
 * `user_quotas.daily_cost_usd` via the `record_ai_cost` RPC.
 *
 * How the cost cap works (paired with `quotaGate`):
 *   - The pre-flight check in `quotaGate` blocks once `daily_cost_usd` >= the
 *     configured cap (`limits.cost_cap_usd`).
 *   - This callback runs post-flight: tokens are only known after the model
 *     responds, so the request that PUSHED the user over the cap is allowed
 *     to finish — the NEXT request is what gets blocked.
 *   - That tradeoff is intentional. Aborting mid-stream produces a worse UX
 *     than letting one request slip past, and the daily cap (configured at
 *     $0.05 for the free tier) limits the blast radius.
 *
 * Pricing source: the `model_pricing` table (per-million-token rates per
 * model_name). Models without a row are charged $0 (logged once per process).
 *
 * Implementation note: handleLLMEnd doesn't carry the `llm` Serialized object,
 * so we capture the model name in handleLLM/ChatModelStart keyed by runId.
 *
 * The callback is intentionally fault-tolerant: a missing model row, an RPC
 * failure, or a malformed `usage_metadata` payload must NOT break the user's
 * chat. We log and skip.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { supabase } from "../services/db";

interface PricingRow {
    input_price_per_million: number;
    output_price_per_million: number;
    /**
     * Anthropic prompt caching adds two extra token classes that are billed
     * differently from fresh input:
     *   - cache_read_input_tokens   ≈ 10% of fresh input (cheaper)
     *   - cache_creation_input_tokens ≈ 125% of fresh input (slightly pricier)
     * Both columns are nullable; if absent, we fall back to standard input rate.
     */
    cache_read_price_per_million?: number | null;
    cache_creation_price_per_million?: number | null;
}

const pricingCache = new Map<string, PricingRow | null>();
const warnedModels = new Set<string>();

async function getPricing(modelName: string): Promise<PricingRow | null> {
    if (pricingCache.has(modelName)) return pricingCache.get(modelName)!;

    const { data, error } = await supabase
        .from("model_pricing")
        .select(
            "input_price_per_million, output_price_per_million, cache_read_price_per_million, cache_creation_price_per_million"
        )
        .eq("model_name", modelName)
        .maybeSingle();

    if (error) {
        console.warn(`[usageTracking] pricing lookup failed for "${modelName}": ${error.message}`);
        pricingCache.set(modelName, null);
        return null;
    }

    pricingCache.set(modelName, (data as PricingRow | null) ?? null);
    return (data as PricingRow | null) ?? null;
}

/**
 * Walk LangChain's `Serialized` shape to find the underlying model name.
 * Different providers stash it in different places; we try the common ones.
 */
function extractModelName(
    llm: Serialized | undefined,
    extraParams?: Record<string, unknown>
): string | null {
    const fromExtra = extraParams?.invocation_params as Record<string, unknown> | undefined;
    if (fromExtra) {
        const candidate = (fromExtra.model ?? fromExtra.model_name ?? fromExtra.modelName) as
            | string
            | undefined;
        if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }

    const kwargs = (llm as { kwargs?: Record<string, unknown> } | undefined)?.kwargs;
    if (kwargs) {
        const candidate = (kwargs.model ?? kwargs.modelName ?? kwargs.model_name) as
            | string
            | undefined;
        if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }

    return null;
}

interface TokenUsage {
    /** "Fresh" input tokens — billed at standard input rate. */
    input: number;
    /** Output tokens. */
    output: number;
    /** Anthropic prompt-cache hit tokens — billed at ~10% rate. */
    cacheRead: number;
    /** Anthropic prompt-cache write tokens — billed at ~125% rate. */
    cacheCreation: number;
}

/**
 * Pull token counts out of the LLMResult. LangChain v1 exposes
 * `usage_metadata` on individual generations; some providers also stash totals
 * on `llmOutput.tokenUsage`. We sum across all generations to be safe.
 *
 * Anthropic surfaces cache stats as `input_token_details.cache_read` and
 * `cache_creation` in v1 — those are subtracted from the headline `input_tokens`
 * cost so we don't double-charge the same bytes.
 */
function extractTokenUsage(output: LLMResult): TokenUsage | null {
    let input = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let found = false;

    for (const batch of output.generations ?? []) {
        for (const gen of batch ?? []) {
            const meta = (gen as {
                message?: {
                    usage_metadata?: {
                        input_tokens?: number;
                        output_tokens?: number;
                        input_token_details?: {
                            cache_read?: number;
                            cache_creation?: number;
                        };
                    };
                };
            }).message?.usage_metadata;
            if (meta) {
                input += meta.input_tokens ?? 0;
                outputTokens += meta.output_tokens ?? 0;
                cacheRead += meta.input_token_details?.cache_read ?? 0;
                cacheCreation += meta.input_token_details?.cache_creation ?? 0;
                found = true;
            }
        }
    }

    if (!found) {
        const tu = (output.llmOutput as { tokenUsage?: { promptTokens?: number; completionTokens?: number } } | undefined)
            ?.tokenUsage;
        if (tu) {
            input = tu.promptTokens ?? 0;
            outputTokens = tu.completionTokens ?? 0;
            found = true;
        }
    }

    return found ? { input, output: outputTokens, cacheRead, cacheCreation } : null;
}

export class UsageTrackingCallbackHandler extends BaseCallbackHandler {
    name = "UsageTrackingCallbackHandler";

    private readonly runModelNames = new Map<string, string>();

    constructor(private readonly userId: string) {
        super();
    }

    handleLLMStart(
        llm: Serialized,
        _prompts: string[],
        runId: string,
        _parentRunId?: string,
        extraParams?: Record<string, unknown>
    ): void {
        const name = extractModelName(llm, extraParams);
        if (name) this.runModelNames.set(runId, name);
    }

    handleChatModelStart(
        llm: Serialized,
        _messages: unknown,
        runId: string,
        _parentRunId?: string,
        extraParams?: Record<string, unknown>
    ): void {
        const name = extractModelName(llm, extraParams);
        if (name) this.runModelNames.set(runId, name);
    }

    async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
        try {
            const modelName = this.runModelNames.get(runId);
            this.runModelNames.delete(runId);

            const usage = extractTokenUsage(output);
            if (
                !usage ||
                (usage.input === 0 &&
                    usage.output === 0 &&
                    usage.cacheRead === 0 &&
                    usage.cacheCreation === 0)
            ) {
                return;
            }

            if (!modelName) {
                if (!warnedModels.has("__unknown__")) {
                    warnedModels.add("__unknown__");
                    console.warn("[usageTracking] LLM call had no resolvable model_name; skipping cost accrual");
                }
                return;
            }

            const pricing = await getPricing(modelName);
            if (!pricing) {
                if (!warnedModels.has(modelName)) {
                    warnedModels.add(modelName);
                    console.warn(`[usageTracking] no model_pricing row for "${modelName}"; cost not accrued`);
                }
                return;
            }

            // Anthropic's `input_tokens` already excludes cache_read and
            // cache_creation, so we bill them as separate rate buckets. If a
            // pricing row doesn't supply cache rates (e.g. OpenAI), fall back
            // to the standard input rate so the cost still accrues correctly.
            const cacheReadRate =
                pricing.cache_read_price_per_million ?? pricing.input_price_per_million;
            const cacheCreationRate =
                pricing.cache_creation_price_per_million ?? pricing.input_price_per_million;

            const cost =
                (usage.input / 1_000_000) * pricing.input_price_per_million +
                (usage.output / 1_000_000) * pricing.output_price_per_million +
                (usage.cacheRead / 1_000_000) * cacheReadRate +
                (usage.cacheCreation / 1_000_000) * cacheCreationRate;

            if (cost <= 0) return;

            const { error } = await supabase.rpc("record_ai_cost", {
                p_cost_usd: cost,
                p_user_id: this.userId,
            });

            if (error) {
                console.warn(`[usageTracking] record_ai_cost failed for ${this.userId}: ${error.message}`);
            }
        } catch (err) {
            console.warn("[usageTracking] handleLLMEnd error (non-fatal):", err);
        }
    }
}

export function makeUsageTracker(userId: string): UsageTrackingCallbackHandler {
    return new UsageTrackingCallbackHandler(userId);
}

// ============================================================================
// REALTIME / AUDIO COST ACCRUAL
// ============================================================================
//
// OpenAI Realtime models bill per-minute of input/output audio rather than
// per-token. Token-based callbacks won't fire for those, so callers must
// accrue cost manually after each Realtime session ends (e.g. from the
// /voice route's session-end webhook).

interface AudioPricingRow {
    audio_input_price_per_minute: number;
    audio_output_price_per_minute: number;
}

const audioPricingCache = new Map<string, AudioPricingRow | null>();

async function getAudioPricing(modelName: string): Promise<AudioPricingRow | null> {
    if (audioPricingCache.has(modelName)) return audioPricingCache.get(modelName)!;

    const { data, error } = await supabase
        .from("model_pricing")
        .select("audio_input_price_per_minute, audio_output_price_per_minute")
        .eq("model_name", modelName)
        .maybeSingle();

    if (error) {
        console.warn(`[usageTracking] audio pricing lookup failed for "${modelName}": ${error.message}`);
        audioPricingCache.set(modelName, null);
        return null;
    }

    audioPricingCache.set(modelName, (data as AudioPricingRow | null) ?? null);
    return (data as AudioPricingRow | null) ?? null;
}

/**
 * Record cost for a Realtime / audio session. Call this from the voice route
 * after a session closes with the audio durations the provider reported.
 *
 * Behaviour mirrors the per-token tracker: missing pricing row → silent skip
 * (logged once), RPC failure → warn (non-fatal).
 */
export async function recordAudioSessionCost(opts: {
    userId: string;
    modelName: string;
    inputAudioMinutes: number;
    outputAudioMinutes: number;
}): Promise<void> {
    try {
        const pricing = await getAudioPricing(opts.modelName);
        if (!pricing) {
            if (!warnedModels.has(opts.modelName)) {
                warnedModels.add(opts.modelName);
                console.warn(
                    `[usageTracking] no audio pricing row for "${opts.modelName}"; audio cost not accrued`
                );
            }
            return;
        }
        const cost =
            opts.inputAudioMinutes * pricing.audio_input_price_per_minute +
            opts.outputAudioMinutes * pricing.audio_output_price_per_minute;
        if (cost <= 0) return;
        const { error } = await supabase.rpc("record_ai_cost", {
            p_cost_usd: cost,
            p_user_id: opts.userId,
        });
        if (error) {
            console.warn(`[usageTracking] record_ai_cost (audio) failed for ${opts.userId}: ${error.message}`);
        }
    } catch (err) {
        console.warn("[usageTracking] recordAudioSessionCost error (non-fatal):", err);
    }
}
