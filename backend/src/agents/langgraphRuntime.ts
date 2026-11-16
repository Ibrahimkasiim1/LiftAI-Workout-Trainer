/**
 * LangGraph runtime: durable checkpoints backed by `conversation_state` (Supabase),
 * with MemorySaver fallback when the saver fails to initialize.
 *
 * PostgresSaver / the langgraph-managed schema are not used. All chat thread memory is persisted strictly to
 * the `conversation_state` table via SupabaseConversationStateCheckpointer.
 *
 * The runtime compiles the multi-agent graph from `./supervisorGraph`.
 */

import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { supabase } from "../services/db";
import { createConversationStateCheckpointer } from "../services/conversationStateCheckpointer";
import { compileSupervisorGraph } from "./supervisorGraph";

type Compiled = ReturnType<typeof compileSupervisorGraph>;

let compiled: Compiled | null = null;
let initPromise: Promise<Compiled> | null = null;
let checkpointerRef: BaseCheckpointSaver | null = null;

async function createCheckpointer(): Promise<BaseCheckpointSaver> {
    try {
        const saver = createConversationStateCheckpointer(supabase);
        console.log(
            "LangGraph checkpointer: SupabaseConversationStateCheckpointer (table: conversation_state)"
        );
        return saver;
    } catch (err) {
        console.warn(
            "LangGraph: failed to initialize conversation_state checkpointer — falling back to MemorySaver:",
            err instanceof Error ? err.message : err
        );
        return new MemorySaver();
    }
}

/**
 * Delete every checkpoint for a chat thread. Called when the user deletes a
 * conversation in the app — without this the client-side delete (chat_messages
 * / chat_conversations) left the server-side thread orphaned forever.
 */
export async function deleteChatThread(threadId: string): Promise<void> {
    if (!checkpointerRef) {
        checkpointerRef = await createCheckpointer();
    }
    const saver = checkpointerRef as BaseCheckpointSaver & {
        deleteThread?: (threadId: string) => Promise<void>;
    };
    if (typeof saver.deleteThread !== "function") {
        throw new Error("Active checkpointer does not support thread deletion");
    }
    await saver.deleteThread(threadId);
}

export async function initLangGraph(): Promise<Compiled> {
    if (compiled) return compiled;
    const checkpointer = await createCheckpointer();
    checkpointerRef = checkpointer;
    compiled = compileSupervisorGraph(checkpointer);
    return compiled;
}

/**
 * Lazy init for first chat request if server bootstrap did not run initLangGraph.
 */
export async function getChatGraphAsync(): Promise<Compiled> {
    if (compiled) return compiled;
    if (!initPromise) {
        initPromise = initLangGraph();
    }
    return initPromise;
}

export function getChatGraph(): Compiled {
    if (!compiled) {
        throw new Error("initLangGraph() must be called before getChatGraph()");
    }
    return compiled;
}

let oneShot: Compiled | null = null;

/**
 * Supervisor graph compiled WITHOUT a checkpointer, for one-shot invocations
 * that should not persist thread state (missed-day handler, studio debugging).
 */
export function getOneShotChatGraph(): Compiled {
    if (!oneShot) {
        oneShot = compileSupervisorGraph(false);
    }
    return oneShot;
}
