/**
 * Chat routes — supervisor-routed LangGraph agent system.
 *
 * Streaming contract highlights:
 * - Assistant text is token-streamed: `text` SSE events carry incremental
 *   chunks decoded live from the structured-output JSON (responseToUser).
 * - Workout/plan payloads are emitted ONLY after the validator passes them;
 *   execute_tools never delivers a validatable build directly.
 * - Client disconnects abort the graph run (no orphaned token spend), and a
 *   heartbeat comment keeps proxies from killing long tool turns.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { LangChainCallbackHandler } from "@posthog/ai";
import { deleteChatThread, getChatGraphAsync } from "../agents/langgraphRuntime";
import { makeUsageTracker } from "../agents/usageTracking";
import { JsonStringFieldStreamer } from "../agents/streamingExtractor";
import {
    AGENT_NODE_IDS,
    EXECUTE_TOOLS_NODE_ID,
    GRAPH_RECURSION_LIMIT,
    SUPERVISOR_NODE_ID,
    VALIDATOR_NODE_ID,
} from "../agents/supervisorGraph";
import type { AuthedRequest } from "../middleware/auth";
import { refundChatAllowance } from "../middleware/quotaGate";
import {
    getChatTurnContext,
    getLatestPlan,
    getUserProfile,
    persistChatBuiltWorkout,
} from "../services/db";
import { formatMemoriesForPrompt, type MemoryCategory } from "../services/longTermMemory";
import { phClient } from "../services/posthog";
import { getUserTimezone } from "../services/userTimezone";
import { getFormattedUserContext } from "../tools/memoryActions";
import { SSEEvent, sseEventSchema } from "../types/sse";
import { maybeGenerateConversationTitle } from "../services/conversationTitles";
import { captureException } from "../services/errorTracking";
import {
    DECLINE_MESSAGE,
    moderateChatMessage,
    SELF_HARM_SUPPORT_MESSAGE,
} from "../services/moderation";
import { detectPromptInjection } from "../services/promptSafety";

const router = Router();

/**
 * Hard wall on a single chat invocation. The graph itself has per-node timeouts
 * (see agentRuntime.ts), but this is the outermost guard so a runaway tool +
 * retry loop can't pin an HTTP connection forever.
 */
const CHAT_INVOKE_TIMEOUT_MS = Number(process.env.CHAT_INVOKE_TIMEOUT_MS ?? 90_000);

/**
 * Wall clock for a single STREAMING turn. The non-streaming route already has
 * CHAT_INVOKE_TIMEOUT_MS; the stream had none, so a hung tool (e.g. a stalled
 * embeddings call) kept the SSE open — heartbeats and all — until the app's
 * 5-minute XHR timeout. Streams legitimately run longer than a bare invoke
 * (validation retries + recap turns), hence the higher default.
 */
const CHAT_STREAM_DEADLINE_MS = Number(process.env.CHAT_STREAM_DEADLINE_MS ?? 150_000);

/** SSE heartbeat cadence — keeps proxies from closing idle long tool turns. */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * Public stage tokens for the SSE graph_node event. Raw internal node ids
 * (planner_agent, supervisor, …) must not go over the wire — the coach's
 * multi-agent structure is private (see the no-leak rule in the agent
 * prompts). The app maps these tokens to thinking copy.
 */
const PUBLIC_GRAPH_STAGE: Record<string, string> = {
    [SUPERVISOR_NODE_ID]: "thinking",
    planner_agent: "planning",
    editor_agent: "editing",
    analyst_agent: "analyzing",
    [EXECUTE_TOOLS_NODE_ID]: "working",
    [VALIDATOR_NODE_ID]: "checking",
    memory: "finishing",
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            }
        );
    });
}

// ============================================================================
// IDEMPOTENCY (client retries must not double-apply mutations)
// ============================================================================

const DEDUPE_TTL_MS = 10 * 60_000;
const recentRequestIds = new Map<string, number>();

/**
 * Returns true when this (userId, clientRequestId) pair was already accepted
 * within the TTL. A client that retries after a timeout resends the SAME id,
 * so the retry is rejected instead of re-running mutations.
 */
function isDuplicateRequest(userId: string, clientRequestId?: string): boolean {
    if (!clientRequestId) return false;
    const now = Date.now();
    for (const [key, ts] of recentRequestIds) {
        if (now - ts > DEDUPE_TTL_MS) recentRequestIds.delete(key);
    }
    const key = `${userId}:${clientRequestId}`;
    if (recentRequestIds.has(key)) return true;
    recentRequestIds.set(key, now);
    return false;
}

// ============================================================================
// TOOL ACTIVITY LABELS
// ============================================================================

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
    // Shared / legacy tool surface
    search_exercises: "Searching the exercise library…",
    add_to_todays_workout: "Updating your scheduled workout…",
    create_one_off_workout: "Building your workout…",
    extend_one_off_workout: "Adding that to your workout…",
    create_temporary_override: "Adjusting your plan for this period…",
    modify_plan_permanently: "Updating your program…",
    get_active_user_context: "Loading your training context…",
    log_workout_completion: "Logging your session…",
    mutate_user_memory: "Saving what to remember for next time…",
    parse_nutrition_string: "Parsing your nutrition log…",

    // Analyst registry tools
    get_performance_history: "Checking your recent sessions…",
    calculate_volume_trend: "Calculating your training volume…",
    get_todays_workout: "Looking at your plan…",

    // Planner registry tools
    generate_draft_plan: "Drafting your new plan…",
    modify_draft_plan: "Refining your draft plan…",
    approve_and_publish_plan: "Publishing your plan…",

    // Editor registry tools
    swap_session_exercise: "Swapping that exercise for today…",
    swap_permanent_exercise: "Swapping that exercise in your program…",
    shift_workout_schedule: "Shifting your upcoming workouts…",

    // Memory registry tools
    save_core_memory: "Remembering that for future sessions…",
    fetch_user_context: "Reviewing what we know about you…",
};

/**
 * Request-specific activity label from the tool's actual args (e.g.
 * "Building your 35-min legs workout…" rather than a static "Building your
 * workout…"). Falls back to the static map for tools without useful args.
 */
function labelForTool(name: string, args: unknown): string {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "create_one_off_workout") {
        const muscle = typeof a.targetMuscle === "string" ? a.targetMuscle.trim() : "";
        const mins = typeof a.durationMinutes === "number" ? a.durationMinutes : undefined;
        if (muscle && mins) return `Building your ${mins}-min ${muscle} workout…`;
        if (muscle) return `Building your ${muscle} workout…`;
    }
    if (name === "add_to_todays_workout" && typeof a.targetDay === "string" && a.targetDay.trim()) {
        return `Adding that to ${a.targetDay.trim()}'s workout…`;
    }
    return TOOL_ACTIVITY_LABELS[name] ?? "Coach is updating your data…";
}

function toolsActivityLabel(
    toolCalls: { toolName: string; args?: unknown }[]
): { label: string; toolNames: string[] } {
    const toolNames = (toolCalls || []).map((t) => t.toolName).filter(Boolean);
    if (toolNames.length === 0) {
        return { label: "Coach is working on that…", toolNames: [] };
    }
    if (toolNames.length === 1) {
        return {
            label: labelForTool(toolNames[0], toolCalls[0]?.args),
            toolNames,
        };
    }
    return {
        label: `Coach is running ${toolNames.length} actions…`,
        toolNames,
    };
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

function writeSseEvent(res: Response, event: SSEEvent) {
    const parsed = sseEventSchema.parse(event);
    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
}

function chatThreadId(userId: string, conversationId: string | undefined): string {
    const cid = (conversationId || "default").replace(/[^a-zA-Z0-9:_-]/g, "_");
    return `${userId}:${cid}`;
}

async function loadPromptUserContext(userId: string): Promise<string> {
    try {
        const result = await getFormattedUserContext(userId, { maxRows: 50 });
        if (!result.success) {
            return "";
        }

        const formatted =
            typeof result.formattedContext === "string" ? result.formattedContext.trim() : "";

        if (!formatted || formatted === "No durable coach memory or active user contexts on file.") {
            return "";
        }

        return formatted;
    } catch (err) {
        console.warn(
            "Failed to prefetch prompt user context (continuing with empty context):",
            err instanceof Error ? err.message : err
        );
        return "";
    }
}

/**
 * Render coach-memory rows from the get_chat_turn_context bundle into the same
 * prompt block loadPromptUserContext produces, so the agents see byte-similar
 * context regardless of which load path ran.
 */
function formatBundleMemories(rows: { category: string; fact: string }[]): string {
    if (rows.length === 0) return "";
    const map: Record<MemoryCategory, string[]> = {
        preference: [],
        goal: [],
        injury: [],
        body_change: [],
        training_phase: [],
        life_context: [],
        equipment: [],
        food_pattern: [],
    };
    for (const row of rows) {
        if (row.category in map) {
            map[row.category as MemoryCategory].push(row.fact);
        }
    }
    const rendered = formatMemoriesForPrompt(map);
    return rendered ? `Long-term Coach Memory (categorized):\n${rendered}` : "";
}

async function resolveTurnMessages(
    graph: Awaited<ReturnType<typeof getChatGraphAsync>>,
    threadId: string,
    conversationHistory: { role: string; content: string }[] | undefined,
    userMessage: string
): Promise<{ messages: BaseMessage[] }> {
    let priorCount = 0;
    try {
        const snap = await graph.getState({ configurable: { thread_id: threadId } });
        const prev = snap?.values?.messages;
        priorCount = Array.isArray(prev) ? prev.length : 0;
    } catch (e: unknown) {
        console.warn(
            "getState(thread) failed; bootstrapping from client history:",
            e instanceof Error ? e.message : e
        );
    }
    if (priorCount > 0) {
        return { messages: [new HumanMessage(userMessage)] };
    }
    // The client includes the message it is currently sending at the tail of
    // conversationHistory — drop it so the bootstrap doesn't store the user's
    // first message twice (we append it ourselves below).
    const rawHistory = [...(conversationHistory || [])];
    while (
        rawHistory.length > 0 &&
        rawHistory[rawHistory.length - 1].role === "user" &&
        rawHistory[rawHistory.length - 1].content.trim() === userMessage.trim()
    ) {
        rawHistory.pop();
    }
    const hist = rawHistory.map((m) =>
        m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
    );
    return { messages: [...hist, new HumanMessage(userMessage)] };
}

interface ChatTurnContext {
    graph: Awaited<ReturnType<typeof getChatGraphAsync>>;
    threadId: string;
    initialState: Record<string, unknown>;
}

/**
 * Shared per-request setup for /chat and /chat/stream: graph, thread id,
 * parallel context loads, and the initial graph state (ephemeral decision
 * fields reset each turn; messages merge via the checkpointer).
 */
async function prepareChatTurn(
    userId: string,
    conversationId: string | undefined,
    conversationHistory: { role: string; content: string }[] | undefined,
    message: string
): Promise<ChatTurnContext> {
    const graph = await getChatGraphAsync();
    const threadId = chatThreadId(userId, conversationId);

    // Preferred path: ONE RPC bundles profile + plan + memories + timezone
    // (get_chat_turn_context, migration 20260713010000), running in parallel
    // with the checkpointer read — 2 round-trips per message instead of 5.
    // Falls back to the legacy parallel loads until the RPC is deployed.
    const [bundle, turn] = await Promise.all([
        getChatTurnContext(userId),
        resolveTurnMessages(graph, threadId, conversationHistory, message),
    ]);

    let profile: unknown;
    let currentPlan: unknown;
    let userContext: string;
    let userTimezone: string;
    if (bundle) {
        profile = bundle.profile;
        currentPlan = bundle.plan;
        userContext = formatBundleMemories(bundle.memories);
        userTimezone = bundle.timezone;
    } else {
        [profile, currentPlan, userContext, userTimezone] = await Promise.all([
            getUserProfile(userId),
            getLatestPlan(userId),
            loadPromptUserContext(userId),
            getUserTimezone(userId),
        ]);
    }

    const initialState = {
        userId,
        conversationId: threadId,
        userProfile: profile,
        currentPlan,
        userContext,
        userTimezone,
        messages: turn.messages,
        // NOTE: `lastAgent` is deliberately NOT set here — the checkpointer
        // carries it across turns so the supervisor can route confirmations
        // back to the agent that asked the question. Setting it (even to the
        // value we just read) would clobber it to null when getState fails.
        shouldCallTool: false,
        toolCalls: [],
        responseToUser: null,
        workout: null,
        planUpdate: null,
        completed: false,
        retryCount: 0,
        error: null,
        // Reset the per-turn duplicate-mutation lock + preamble every request;
        // the checkpointer would otherwise carry them over and block all
        // future mutations on this thread.
        turnMutationDone: false,
        // Reset the per-turn agent-step counter so the loop guard starts fresh
        // each request (the checkpointer would otherwise carry it across turns
        // and trip the budget prematurely).
        agentTurns: 0,
        preamble: null as string | null,
        toolFailureNotices: null as { toolName: string; message: string }[] | null,
        // Supervisor routing fields (defaults; supervisor sets nextAgent on first hop)
        activeAgent: null as "planner" | "editor" | "analyst" | "supervisor" | null,
        nextAgent: null as "planner" | "editor" | "analyst" | "finish" | null,
        // Per-turn complexity classification (mini-first model policy) — must
        // reset each request or the checkpointer carries the previous turn's
        // label onto an unrelated message.
        modelComplexity: null as "simple" | "complex" | null,
        // Follow-up chips are per-reply; never carry them across requests.
        suggestedReplies: null as string[] | null,
    };

    return { graph, threadId, initialState };
}

function normalizeWorkoutForClient(workout: any) {
    return {
        workout_name: workout.focus || "Quick Workout",
        exercises: (workout.exercises ?? []).map((ex: any) => ex.name),
        exercises_structured: workout.exercises,
        estimated_time: workout.estimatedTime,
        difficulty: workout.difficulty || "intermediate",
        workout_type: workout.workoutType || "replacement_workout",
        id: workout.id,
    };
}

/** A plan update with rebuilt days must pass the validator before delivery. */
function planUpdateNeedsValidation(planUpdate: any): boolean {
    return Boolean(planUpdate && Array.isArray(planUpdate.days) && planUpdate.days.length > 0);
}

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

const chatRequestSchema = z.object({
    message: z.string().min(1, "message is required"),
    conversationId: z.string().optional(),
    /**
     * Client-generated id for this send attempt. Retries of the same logical
     * message MUST reuse the id so the server can reject the duplicate
     * instead of double-applying mutations.
     */
    clientRequestId: z.string().max(128).optional(),
    conversationHistory: z.array(z.object({
        role: z.string(),
        content: z.string(),
    })).optional(),
    /**
     * Client capability flag: only app builds that understand the
     * `suggestions` SSE event set this. Older clients treat unknown event
     * types as raw text, so the server must never emit it unsolicited.
     */
    supportsSuggestions: z.boolean().optional(),
    context: z.object({
        hasPlan: z.boolean().optional(),
        todaysWorkout: z.any().optional(),
        weeklySchedule: z.any().optional(),
        dayIndex: z.number().optional(),
    }).optional(),
});

// ============================================================================
// MAIN CHAT ENDPOINT (Non-streaming)
// ============================================================================

router.post("/chat", async (req: Request, res: Response) => {
    let userIdForRefund: string | null = null;
    try {
        const userId = (req as AuthedRequest).user.id;
        userIdForRefund = userId;
        const body = chatRequestSchema.parse(req.body);
        const { message, conversationHistory, conversationId, clientRequestId } = body;

        if (isDuplicateRequest(userId, clientRequestId)) {
            // The duplicate consumed its own pre-flight count in the quota
            // gate; only the original request should cost the user a message.
            void refundChatAllowance(userId);
            return res.status(409).json({
                success: false,
                error: "duplicate_request",
                message: "This message is already being processed.",
            });
        }

        console.log(`Chat from ${userId}: "${message.substring(0, 50)}..."`);
        const turnStart = Date.now();

        // Content moderation: the coach never engages with self-harm or
        // minors-sexual content — supportive/decline canned replies instead,
        // with the chat count refunded (these turns are never charged).
        const moderation = await moderateChatMessage(message);
        if (moderation.action !== "allow") {
            void refundChatAllowance(userId);
            phClient.capture({
                distinctId: userId,
                event: "chat_moderation_blocked",
                properties: { action: moderation.action, categories: moderation.categories, streaming: false },
            });
            return res.status(200).json({
                success: true,
                message:
                    moderation.action === "support_self_harm"
                        ? SELF_HARM_SUPPORT_MESSAGE
                        : DECLINE_MESSAGE,
            });
        }

        const { graph, threadId, initialState } = await prepareChatTurn(
            userId,
            conversationId,
            conversationHistory as { role: string; content: string }[] | undefined,
            message
        );

        // Prompt-injection tripwire: flagged turns still get a coach reply,
        // but run with the turn-level mutation lock engaged so no durable
        // write (plan edits, logs, profile changes) can fire.
        const injection = detectPromptInjection(message);
        if (injection.flagged) {
            console.warn(`Prompt-injection heuristics matched (${injection.matched.join(", ")}) — mutation lock engaged`);
            phClient.capture({
                distinctId: userId,
                event: "chat_prompt_injection_flagged",
                properties: { patterns: injection.matched, streaming: false },
            });
            initialState.turnMutationDone = true;
        }

        console.log("Running supervisor-routed agent…");

        const callbackHandler = new LangChainCallbackHandler({
            client: phClient,
            distinctId: userId,
            properties: { conversationId: conversationId ?? threadId },
        });
        const usageTracker = makeUsageTracker(userId);
        const result = await withTimeout(
            graph.invoke(initialState, {
                recursionLimit: GRAPH_RECURSION_LIMIT,
                configurable: {
                    thread_id: threadId,
                },
                callbacks: [callbackHandler, usageTracker],
            }),
            CHAT_INVOKE_TIMEOUT_MS,
            "chat graph invoke"
        );

        console.log(`Agent completed`);

        // Deliver/save the workout only when the turn ended clean — the
        // validator nulls invalid builds, and an errored turn must never ship
        // an unvalidated artifact.
        const validatedWorkout = !result.error && result.workout?.exercises ? result.workout : null;
        if (validatedWorkout) {
            await persistChatBuiltWorkout(userId, validatedWorkout, initialState.currentPlan);
        }

        const response: any = {
            success: !result.error,
            message: result.responseToUser || "I processed your request.",
        };

        if (validatedWorkout) {
            response.workout = normalizeWorkoutForClient(validatedWorkout);
        }

        if (result.planUpdate && !result.error) {
            response.plan = result.planUpdate;
        }

        if (result.error) {
            response.error = result.error;
            // The turn failed server-side — hand the pre-flight-consumed chat
            // count back so a graph error never costs one of the free tier's
            // 3 daily messages.
            void refundChatAllowance(userId);
        }

        res.status(200).json(response);

        phClient.capture({
            distinctId: userId,
            event: "chat_turn_latency",
            properties: {
                total_ms: Date.now() - turnStart,
                streaming: false,
                errored: Boolean(result.error),
                conversation_id: conversationId ?? null,
            },
        });
        if (!result.error) {
            void maybeGenerateConversationTitle(
                userId,
                conversationId,
                message,
                result.responseToUser || ""
            );
        }

    } catch (err: any) {
        console.error("Chat error:", err);
        captureException(err, { route: "/chat" });
        if (userIdForRefund) void refundChatAllowance(userIdForRefund);
        res.status(err?.name === "ZodError" ? 400 : 500).json({
            success: false,
            error: err?.message ?? "Chat failed"
        });
    }
});

// ============================================================================
// STREAMING CHAT ENDPOINT
// ============================================================================

router.post("/chat/stream", async (req: Request, res: Response) => {
    const abort = new AbortController();
    let heartbeat: NodeJS.Timeout | null = null;
    let deadline: NodeJS.Timeout | null = null;
    let userIdForRefund: string | null = null;
    /** True when WE failed the turn (deadline/graph error) — drives the quota refund. */
    let turnFailed = false;

    try {
        const userId = (req as AuthedRequest).user.id;
        userIdForRefund = userId;
        const body = chatRequestSchema.parse(req.body);
        const { message, conversationHistory, conversationId, clientRequestId, supportsSuggestions } = body;

        if (isDuplicateRequest(userId, clientRequestId)) {
            // The duplicate consumed its own pre-flight count in the quota
            // gate; only the original request should cost the user a message.
            void refundChatAllowance(userId);
            return res.status(409).json({
                success: false,
                error: "duplicate_request",
                message: "This message is already being processed.",
            });
        }

        console.log(`Streaming chat from ${userId}: "${message.substring(0, 50)}..."`);
        const turnStart = Date.now();

        // Moderation runs in parallel with context loading — blocked turns are
        // rare, so the wasted prep cost on those beats adding the moderation
        // round-trip's latency to every normal turn.
        const [moderation, prep] = await Promise.all([
            moderateChatMessage(message),
            prepareChatTurn(
                userId,
                conversationId,
                conversationHistory as { role: string; content: string }[] | undefined,
                message
            ),
        ]);
        const { graph, threadId, initialState } = prep;

        // SSE handshake only after request validation/setup — earlier failures
        // return clean JSON status codes instead of an SSE error frame.
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        // Moderated turns: deliver the canned reply over SSE (this route only
        // speaks SSE once the handshake is out), refund the chat count, and
        // never run the graph.
        if (moderation.action !== "allow") {
            phClient.capture({
                distinctId: userId,
                event: "chat_moderation_blocked",
                properties: { action: moderation.action, categories: moderation.categories, streaming: true },
            });
            const reply =
                moderation.action === "support_self_harm"
                    ? SELF_HARM_SUPPORT_MESSAGE
                    : DECLINE_MESSAGE;
            writeSseEvent(res, { type: "text_start" });
            writeSseEvent(res, { type: "text", content: reply });
            writeSseEvent(res, { type: "text_done" });
            writeSseEvent(res, { type: "complete" });
            res.end();
            void refundChatAllowance(userId);
            return;
        }

        // Prompt-injection tripwire: flagged turns still get a coach reply,
        // but run with the turn-level mutation lock engaged so no durable
        // write (plan edits, logs, profile changes) can fire this turn.
        const injection = detectPromptInjection(message);
        if (injection.flagged) {
            console.warn(`Prompt-injection heuristics matched (${injection.matched.join(", ")}) — mutation lock engaged`);
            phClient.capture({
                distinctId: userId,
                event: "chat_prompt_injection_flagged",
                properties: { patterns: injection.matched, streaming: true },
            });
            initialState.turnMutationDone = true;
        }

        // Latency metrics: time-to-first-token is THE perceived-speed metric
        // for chat. Marked at the first user-visible payload (text or workout).
        let firstTokenAt: number | null = null;
        const markFirstToken = () => {
            if (firstTokenAt === null) firstTokenAt = Date.now();
        };
        /** Assistant text delivered this turn — feeds the auto conversation title. */
        let turnTranscript = "";

        // A client disconnect aborts the graph run so we stop spending tokens
        // on a response nobody will see.
        req.on("close", () => {
            if (!res.writableEnded) abort.abort();
        });
        // Casts: the root tsconfig includes Node + RN libs and resolves the
        // timer functions to the DOM signatures (number return), while the
        // backend tsconfig resolves NodeJS.Timeout. Same convention as server.ts.
        heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(`: hb\n\n`);
        }, SSE_HEARTBEAT_MS) as unknown as NodeJS.Timeout;
        // Server-side wall clock: a hung tool must not pin this stream until
        // the client's 5-minute timeout. Emit an honest error, abort the graph
        // (stops token spend), and refund the chat count below.
        deadline = setTimeout(() => {
            if (res.writableEnded || abort.signal.aborted) return;
            console.error(`Chat stream deadline (${CHAT_STREAM_DEADLINE_MS}ms) hit for ${userId}`);
            turnFailed = true;
            try {
                writeSseEvent(res, {
                    type: "error",
                    message: "That took longer than it should have on my end. Your message was fine — send it again and I'll pick it right up.",
                });
            } catch { /* stream may already be broken */ }
            abort.abort();
        }, CHAT_STREAM_DEADLINE_MS) as unknown as NodeJS.Timeout;

        const streamCallbackHandler = new LangChainCallbackHandler({
            client: phClient,
            distinctId: userId,
            properties: { conversationId: conversationId ?? threadId },
        });
        const streamUsageTracker = makeUsageTracker(userId);

        // Live token streaming of the agent's user-facing reply: the decision
        // is structured JSON, so we decode the `responseToUser` string value
        // incrementally from the streamed tool-call args / JSON content.
        let liveText = {
            streamer: new JsonStringFieldStreamer("responseToUser"),
            started: false,
            text: "",
        };
        const resetLiveText = () => {
            liveText = {
                streamer: new JsonStringFieldStreamer("responseToUser"),
                started: false,
                text: "",
            };
        };

        const stream = await graph.stream(initialState, {
            recursionLimit: GRAPH_RECURSION_LIMIT,
            configurable: {
                thread_id: threadId,
            },
            callbacks: [streamCallbackHandler, streamUsageTracker],
            signal: abort.signal,
            streamMode: ["updates", "messages"],
        } as any);

        for await (const item of stream as AsyncIterable<[string, any]>) {
            if (abort.signal.aborted) break;
            const [mode, payload] = item;

            // ----------------------------------------------------------------
            // Token stream: incremental text from agent LLM calls.
            // ----------------------------------------------------------------
            if (mode === "messages") {
                const [msgChunk, meta] = payload as [any, Record<string, any> | undefined];
                const node = meta?.langgraph_node as string | undefined;
                if (!node || !AGENT_NODE_IDS.has(node)) continue;

                let delta = "";
                const toolChunks = msgChunk?.tool_call_chunks;
                if (Array.isArray(toolChunks) && toolChunks.length > 0) {
                    delta = toolChunks
                        .map((c: any) => (typeof c?.args === "string" ? c.args : ""))
                        .join("");
                } else if (typeof msgChunk?.content === "string") {
                    delta = msgChunk.content;
                }
                if (!delta) continue;

                const text = liveText.streamer.push(delta);
                if (text) {
                    if (!liveText.started) {
                        markFirstToken();
                        writeSseEvent(res, { type: "text_start" });
                        liveText.started = true;
                    }
                    liveText.text += text;
                    turnTranscript += text;
                    writeSseEvent(res, { type: "text", content: text });
                }
                continue;
            }

            // ----------------------------------------------------------------
            // Node updates: same per-node emission contract as before.
            // ----------------------------------------------------------------
            const [nodeName, nodeOutput] = Object.entries(payload)[0] as [string, any];

            console.log(`Node: ${nodeName}`);

            // Public stage token only — never the internal node id.
            writeSseEvent(res, {
                type: "graph_node",
                node: PUBLIC_GRAPH_STAGE[nodeName] ?? "working",
            });

            const isAgentNode = AGENT_NODE_IDS.has(nodeName);
            const agentToolCalls = isAgentNode ? nodeOutput.toolCalls : undefined;

            // Supervisor-authored replies (greeting fast-path, trivial
            // questions, clarifying questions) end the turn without any
            // specialist node running — deliver the text from here. Replies
            // are 1-4 sentences, so a single block is fine (no token stream).
            if (
                nodeName === SUPERVISOR_NODE_ID &&
                nodeOutput.completed &&
                typeof nodeOutput.responseToUser === "string" &&
                nodeOutput.responseToUser.length > 0
            ) {
                markFirstToken();
                turnTranscript += nodeOutput.responseToUser;
                writeSseEvent(res, { type: "text_start" });
                writeSseEvent(res, { type: "text", content: nodeOutput.responseToUser });
                writeSseEvent(res, { type: "text_done" });
            }

            if (isAgentNode) {
                const finalText =
                    typeof nodeOutput.responseToUser === "string" ? nodeOutput.responseToUser : "";

                if (liveText.started) {
                    // Tokens already streamed live. If the final text extends the
                    // streamed prefix (rare — e.g. a deterministic fallback was
                    // appended), ship the remainder, then close.
                    if (finalText.startsWith(liveText.text) && finalText.length > liveText.text.length) {
                        const remainder = finalText.slice(liveText.text.length);
                        turnTranscript += remainder;
                        writeSseEvent(res, { type: "text", content: remainder });
                    }
                    writeSseEvent(res, { type: "text_done" });
                } else if (finalText) {
                    // Nothing streamed (e.g. provider gave no incremental args,
                    // or a fallback replaced an empty reply): emit in one block.
                    markFirstToken();
                    turnTranscript += finalText;
                    writeSseEvent(res, { type: "text_start" });
                    writeSseEvent(res, { type: "text", content: finalText });
                    writeSseEvent(res, { type: "text_done" });
                }
                // Tappable follow-up chips from the agent's final reply. Gated
                // on the client capability flag: older app builds render
                // unknown SSE events as raw text.
                if (
                    supportsSuggestions &&
                    nodeOutput.completed &&
                    Array.isArray(nodeOutput.suggestedReplies) &&
                    nodeOutput.suggestedReplies.length > 0
                ) {
                    writeSseEvent(res, {
                        type: "suggestions",
                        replies: (nodeOutput.suggestedReplies as string[]).slice(0, 3),
                    });
                }
                // Each agent invocation gets a fresh extractor (the node may run
                // again for the recap turn).
                resetLiveText();
            }

            // On a tool turn the agent stays silent in `responseToUser` but emits
            // a short `preamble` ("Sure — a 40-min push workout coming up") — the
            // AI's own request-specific line. Surface it as the live THINKING
            // status (not chat text) so the loading indicator reads like the
            // coach is reasoning about THIS request, then disappears when the
            // result arrives (no stray chat bubble to clean up).
            const preamble =
                isAgentNode && typeof nodeOutput.preamble === "string"
                    ? nodeOutput.preamble.trim()
                    : "";
            if (preamble && nodeOutput.shouldCallTool) {
                writeSseEvent(res, { type: "status", state: preamble });
            }

            // Emit tool activity after text kickoff; tools still execute in graph order.
            if (isAgentNode && nodeOutput.shouldCallTool && agentToolCalls?.length) {
                const { label, toolNames } = toolsActivityLabel(agentToolCalls);
                writeSseEvent(res, {
                    type: "tool_start",
                    label,
                    toolNames,
                });
                if (
                    toolNames.includes("create_one_off_workout") ||
                    toolNames.includes("extend_one_off_workout")
                ) {
                    writeSseEvent(res, { type: "workout_start" });
                }
            }

            if (nodeName === EXECUTE_TOOLS_NODE_ID) {
                writeSseEvent(res, { type: "tool_done" });
                const notices = (nodeOutput as { toolFailureNotices?: { toolName: string; message: string }[] | null })
                    .toolFailureNotices;
                if (Array.isArray(notices) && notices.length > 0) {
                    for (const n of notices) {
                        writeSseEvent(res, {
                            type: "tool_error",
                            toolName: n.toolName,
                            message: n.message,
                        });
                    }
                }

                // Only non-validatable plan updates are delivered straight from
                // tool execution. Workouts and rebuilt plan days are delivered
                // by the validator AFTER they pass — never before.
                if (nodeOutput.planUpdate && !planUpdateNeedsValidation(nodeOutput.planUpdate)) {
                    writeSseEvent(res, { type: "plan", planData: nodeOutput.planUpdate });
                }

                // Deterministic recap (simple logging/shift mutations): the
                // user-facing reply was templated from the tool result — no
                // LLM recap turn follows, so deliver the text from here.
                if (
                    nodeOutput.completed &&
                    typeof nodeOutput.responseToUser === "string" &&
                    nodeOutput.responseToUser.length > 0
                ) {
                    markFirstToken();
                    turnTranscript += nodeOutput.responseToUser;
                    writeSseEvent(res, { type: "text_start" });
                    writeSseEvent(res, { type: "text", content: nodeOutput.responseToUser });
                    writeSseEvent(res, { type: "text_done" });
                }
            }

            // Validated artifacts: emit from the validator's success output.
            if (nodeName === VALIDATOR_NODE_ID && nodeOutput.completed && !nodeOutput.error) {
                if (nodeOutput.workout?.exercises?.length) {
                    markFirstToken();
                    writeSseEvent(res, { type: "workout_start" });
                    writeSseEvent(res, {
                        type: "workout",
                        workoutData: normalizeWorkoutForClient(nodeOutput.workout),
                    });
                    // The streaming path never persisted chat-built workouts —
                    // they existed only inside the chat card, so the home
                    // screen kept saying "rest day". Persist like the
                    // non-streaming route does (rest day → replacement for
                    // today so it surfaces on the home card). Fire-and-forget:
                    // the card is already delivered, and awaiting here held up
                    // the recap turn + `complete` behind two extra DB writes.
                    // (persistChatBuiltWorkout catches its own errors.)
                    void persistChatBuiltWorkout(
                        userId,
                        nodeOutput.workout,
                        initialState.currentPlan
                    );
                }
                if (planUpdateNeedsValidation(nodeOutput.planUpdate)) {
                    writeSseEvent(res, { type: "plan", planData: nodeOutput.planUpdate });
                }
            }
        }

        if (!abort.signal.aborted) {
            writeSseEvent(res, { type: "complete" });
        }
        res.end();
        // Deadline-aborted turns reach here without throwing — refund them.
        if (turnFailed && userIdForRefund) void refundChatAllowance(userIdForRefund);

        phClient.capture({
            distinctId: userId,
            event: "chat_turn_latency",
            properties: {
                ttft_ms: firstTokenAt !== null ? firstTokenAt - turnStart : null,
                total_ms: Date.now() - turnStart,
                streaming: true,
                aborted: abort.signal.aborted,
                deadline_hit: turnFailed,
                conversation_id: conversationId ?? null,
            },
        });
        if (!turnFailed && !abort.signal.aborted) {
            void maybeGenerateConversationTitle(userId, conversationId, message, turnTranscript);
        }

    } catch (err: any) {
        if (abort.signal.aborted) {
            // Deadline aborts are OUR failure — refund. Plain client
            // disconnects are not refunded (the answer was being delivered).
            if (turnFailed && userIdForRefund) void refundChatAllowance(userIdForRefund);
            // Client went away — nothing to report, just release the response.
            try {
                if (!res.writableEnded) res.end();
            } catch { /* noop */ }
            return;
        }
        console.error("Streaming chat error:", err);
        captureException(err, { route: "/chat/stream" });
        if (userIdForRefund) void refundChatAllowance(userIdForRefund);
        if (!res.headersSent) {
            res.status(err?.name === "ZodError" ? 400 : 500).json({
                success: false,
                error: err?.message ?? "Stream failed",
            });
            return;
        }
        try {
            writeSseEvent(res, { type: "error", message: err?.message ?? "Stream failed" });
        } catch { /* noop */ }
        res.end();
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (deadline) clearTimeout(deadline);
    }
});

// ============================================================================
// THREAD DELETION
// ============================================================================

/**
 * Delete the server-side LangGraph thread for a conversation. Called when the
 * user deletes a chat in the app — the client removes chat_messages /
 * chat_conversations itself, but the checkpointed thread in conversation_state
 * lived on forever without this. The thread id is derived from the AUTHED
 * user id, so callers can only ever delete their own threads.
 */
router.delete("/chat/thread/:conversationId", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const conversationId = String(req.params.conversationId ?? "").trim();
        if (!conversationId) {
            return res.status(400).json({ success: false, error: "conversationId is required" });
        }

        const threadId = chatThreadId(userId, conversationId);
        await deleteChatThread(threadId);

        console.log(`Deleted chat thread ${threadId}`);
        res.json({ success: true });
    } catch (err: any) {
        console.error("Thread delete error:", err);
        res.status(500).json({
            success: false,
            error: err?.message ?? "Failed to delete thread",
        });
    }
});

export default router;
