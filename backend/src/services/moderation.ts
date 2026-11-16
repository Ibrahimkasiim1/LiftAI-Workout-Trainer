/**
 * Content moderation for chat input.
 *
 * A health/fitness app is a magnet for self-harm-adjacent and disordered-eating
 * content, and the coach must respond with care rather than a canned refusal —
 * or worse, comply (e.g. "give me a 500-calorie diet and a 3-hour daily cardio
 * plan to punish myself"). This runs OpenAI's moderation endpoint (free, ~100ms)
 * on the raw user message before the agent graph spends any tokens.
 *
 * Behavior:
 *  - self-harm signals  → skip the graph, return a supportive message with
 *    crisis resources, refund the chat count (never charge for this).
 *  - sexual/minors      → skip the graph with a brief decline.
 *  - everything else    → pass through; the coach prompts handle tone.
 *  - API error/timeout  → FAIL OPEN (never let a moderation outage kill chat).
 *
 * Kill switch: MODERATION_ENABLED=false.
 */

const MODERATION_TIMEOUT_MS = Number(process.env.MODERATION_TIMEOUT_MS ?? 3_000);
const MODERATION_MODEL = process.env.MODERATION_MODEL ?? "omni-moderation-latest";

export type ModerationAction = "allow" | "support_self_harm" | "decline";

export interface ModerationVerdict {
    action: ModerationAction;
    /** Flagged category names (for logging/analytics only). */
    categories: string[];
}

export const SELF_HARM_SUPPORT_MESSAGE =
    "Thank you for trusting me with that — it sounds like you're carrying something heavy right now. " +
    "I'm a fitness coach, so I'm not the right support for this, but you deserve real support: " +
    "if you're in the US, you can call or text 988 (Suicide & Crisis Lifeline) any time, day or night. " +
    "Outside the US, findahelpline.com lists free, confidential helplines for your country. " +
    "Please reach out to one of them, or to someone you trust, today. I'll be here whenever you want to talk training.";

export const DECLINE_MESSAGE =
    "That's not something I can help with — I'm your training and nutrition coach. " +
    "Ask me anything about workouts, form, recovery, or food and I'm on it.";

export async function moderateChatMessage(text: string): Promise<ModerationVerdict> {
    if (process.env.MODERATION_ENABLED === "false") return { action: "allow", categories: [] };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !text.trim()) return { action: "allow", categories: [] };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MODERATION_TIMEOUT_MS);
    try {
        const resp = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: MODERATION_MODEL, input: text.slice(0, 4_000) }),
            signal: abort.signal,
        });
        if (!resp.ok) {
            console.warn(`[moderation] API returned ${resp.status} — failing open`);
            return { action: "allow", categories: [] };
        }
        const payload = (await resp.json()) as {
            results?: { flagged: boolean; categories?: Record<string, boolean> }[];
        };
        const result = payload.results?.[0];
        if (!result?.flagged) return { action: "allow", categories: [] };

        const categories = Object.entries(result.categories ?? {})
            .filter(([, v]) => v)
            .map(([k]) => k);

        if (categories.some((c) => c.startsWith("self-harm"))) {
            return { action: "support_self_harm", categories };
        }
        if (categories.includes("sexual/minors")) {
            return { action: "decline", categories };
        }
        // Other flags (e.g. mild harassment/violence in venting about a gym
        // rival) pass through — the coach prompts keep the reply grounded.
        return { action: "allow", categories };
    } catch (err) {
        // Timeouts and network errors fail open by design.
        console.warn(
            "[moderation] check failed — failing open:",
            err instanceof Error ? err.message : err
        );
        return { action: "allow", categories: [] };
    } finally {
        clearTimeout(timer);
    }
}
