/**
 * Auto-generated conversation titles.
 *
 * The history sidebar used to label conversations with the truncated first
 * user message. After a conversation's first completed turn, this generates a
 * short (≤5 words) title with the mini model and writes it to
 * chat_conversations.title. Fire-and-forget: called with `void` from the chat
 * routes AFTER the reply is delivered, so it never adds user-visible latency,
 * and every failure path is swallowed (a missing title is a cosmetic miss).
 */

import { getAgentModel } from "../agents/modelFactory";
import { supabase } from "./db";

const TITLE_MAX_CHARS = 60;

function sanitizeTitle(raw: string): string {
    const cleaned = raw
        .trim()
        // Models love wrapping titles in quotes / markdown despite instructions.
        .replace(/^["'`#*\s]+|["'`*\s]+$/g, "")
        .replace(/\s+/g, " ");
    if (!cleaned) return "";
    return cleaned.length > TITLE_MAX_CHARS ? `${cleaned.slice(0, TITLE_MAX_CHARS - 1)}…` : cleaned;
}

/**
 * Generate + persist a title for a conversation that doesn't have one yet.
 * `conversationId` is the client's chat_conversations UUID (not the LangGraph
 * thread id). No-ops when the row already has a title or doesn't exist yet.
 */
export async function maybeGenerateConversationTitle(
    userId: string,
    conversationId: string | undefined,
    userMessage: string,
    assistantReply: string
): Promise<void> {
    try {
        if (!conversationId || !userMessage.trim()) return;

        const { data: row, error } = await supabase
            .from("chat_conversations")
            .select("id, title")
            .eq("id", conversationId)
            .eq("user_id", userId)
            .maybeSingle();
        if (error || !row) return; // row is client-created; if it's not there yet, skip quietly
        if (typeof row.title === "string" && row.title.trim().length > 0) return;

        const llm = getAgentModel("memory", { temperature: 0.2, maxTokens: 24 });
        const result = await llm.invoke([
            [
                "system",
                "You title fitness-coach chat conversations. Reply with ONLY a title of at most 5 words. " +
                    "No quotes, no punctuation at the end, no emoji. Capture the user's topic, e.g. " +
                    '"Leg day swap", "Cutting macros plan", "Shoulder pain check".',
            ],
            [
                "user",
                `User's first message: ${userMessage.slice(0, 400)}\n\nCoach's reply (excerpt): ${assistantReply.slice(0, 300)}`,
            ],
        ]);

        const title = sanitizeTitle(
            typeof result.content === "string" ? result.content : JSON.stringify(result.content)
        );
        if (!title) return;

        await supabase
            .from("chat_conversations")
            .update({ title })
            .eq("id", conversationId)
            .eq("user_id", userId)
            .is("title", null);
        console.log(`Titled conversation ${conversationId}: "${title}"`);
    } catch (err) {
        console.warn(
            "[conversationTitles] title generation failed (non-fatal):",
            err instanceof Error ? err.message : err
        );
    }
}
