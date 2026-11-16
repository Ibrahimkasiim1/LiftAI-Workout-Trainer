import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

/**
 * Agent identifiers used by the supervisor router. Adding new agents requires
 * updating both this union and the supervisor's structured-output schema.
 */
export type AgentName = "planner" | "editor" | "analyst" | "supervisor";

export type SupervisorDecision = "planner" | "editor" | "analyst" | "finish";

/**
 * Tools that durably change user-facing state. Once one of these succeeds in a
 * turn, the deterministic duplicate-mutation guard (see agentRuntime +
 * toolExecutionNode) forbids a second mutation in the same turn so the LLM can
 * never accidentally build/apply a thing twice (e.g. duplicate workouts).
 *
 * Lives here (dependency-free module) so both the runtime and the graph nodes
 * can import it without a circular dependency.
 */
export const CORE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
    "add_to_todays_workout",
    "create_one_off_workout",
    "extend_one_off_workout",
    "swap_session_exercise",
    "swap_permanent_exercise",
    "modify_plan_permanently",
    "create_temporary_override",
    "shift_workout_schedule",
    "approve_and_publish_plan",
    "log_workout_completion",
    "log_exercise_set",
    "update_user_profile",
    "log_nutrition_entry",
    "edit_nutrition_entry",
    "delete_nutrition_entry",
    "log_body_weight",
    "set_daily_macro_goals",
]);

/**
 * Mutations that may legitimately appear MULTIPLE times in one turn with
 * different args ("log my bench AND my squat", "log breakfast and lunch").
 * The duplicate-mutation guard keeps every distinct call to these tools but
 * still drops byte-identical repeats (same tool + same args), so an LLM echo
 * can't double-log the same set or meal.
 */
export const REPEATABLE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
    "log_exercise_set",
    "log_nutrition_entry",
    "log_body_weight",
]);

/**
 * Simple, self-describing mutations whose post-tool recap is templated from
 * the tool result instead of paying a second full LLM round-trip. Each of
 * these tools returns a human-readable `message` ("Logged 80 kg (176.4 lbs).")
 * that IS the recap. Workout/plan builders stay on the LLM recap path — the
 * coaching briefing there is the product.
 */
export const DETERMINISTIC_RECAP_TOOLS: ReadonlySet<string> = new Set([
    "log_nutrition_entry",
    "edit_nutrition_entry",
    "delete_nutrition_entry",
    "log_body_weight",
    "log_exercise_set",
    "set_daily_macro_goals",
    "shift_workout_schedule",
    // Session swaps and plan-day additions return user-facing messages
    // ("Swapped X → Y for today's session.", "Added X, Y to monday's
    // workout.") — the second LLM round-trip added 1.5-3s to the most common
    // mutation turns just to restate them. Whole-workout/plan builders stay
    // on the LLM recap path (the coaching briefing there is the product).
    "swap_session_exercise",
    "add_to_todays_workout",
]);

/**
 * Read-only tools that are safe to execute concurrently. Anything not in this
 * set is treated as a mutation and runs serially, in decision order.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    "search_exercises",
    "find_similar_exercises",
    "get_active_user_context",
    "get_todays_workout",
    "get_performance_history",
    "calculate_volume_trend",
    "get_daily_macro_goals",
    "get_body_weight_history",
    "parse_nutrition_string",
    "list_saved_workouts",
    "fetch_user_context",
]);

/**
 * Marker on `additional_kwargs` of the FIRST message in a `messages` state
 * update that tells the reducer to REPLACE the whole history instead of
 * concatenating. Used by the end-of-turn checkpoint compaction in the memory
 * node so long threads don't grow the conversation_state blob forever.
 */
export const HISTORY_COMPACTION_FLAG = "__liftai_history_compaction__";

export const GraphState = Annotation.Root({
    // User context
    userId: Annotation<string>,
    userProfile: Annotation<any>,
    currentPlan: Annotation<any>,
    /** Conversation/thread id — needed by planner draft tools (one draft per conversation). */
    conversationId: Annotation<string>({
        reducer: (current, update) => (update === undefined ? current ?? "default" : update),
        default: () => "default",
    }),
    /** Durable prompt context string composed from coach_memory + user_contexts. */
    userContext: Annotation<string>({
        reducer: (current, update) => (update === undefined ? current ?? "" : update),
        default: () => "",
    }),
    /**
     * User's IANA timezone (from user_quotas.timezone). Drives every "today"
     * computation in prompts and tools — the server runs in UTC, so using the
     * server clock puts evening users on the wrong day.
     */
    userTimezone: Annotation<string>({
        reducer: (current, update) => (update === undefined ? current ?? "UTC" : update),
        default: () => "UTC",
    }),

    // Conversation history. Default behavior is append; an update whose first
    // message carries HISTORY_COMPACTION_FLAG replaces the whole history (see
    // compactHistoryForCheckpoint in messageHelpers + the memory node).
    messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => {
            if (
                Array.isArray(y) &&
                y.length > 0 &&
                (y[0] as BaseMessage | undefined)?.additional_kwargs?.[HISTORY_COMPACTION_FLAG] === true
            ) {
                return y;
            }
            return x.concat(y);
        },
        default: () => [],
    }),

    // Agent decision tracking (simpler)
    shouldCallTool: Annotation<boolean>,
    toolCalls: Annotation<any[]>, // Simplified from toolsToCall
    responseToUser: Annotation<string | null>,

    // Results
    workout: Annotation<any | null>,
    planUpdate: Annotation<any | null>,

    // Flow control
    completed: Annotation<boolean>,
    error: Annotation<string | null>,
    retryCount: Annotation<number>,

    /**
     * Set true once a CORE_MUTATION_TOOLS call has durably succeeded this turn.
     * Deterministically blocks any further mutation tool calls for the rest of
     * the turn (the agent may still produce a text recap). Reset per request by
     * the route initializer in routes/chat.ts.
     */
    turnMutationDone: Annotation<boolean>({
        reducer: (current, update) => (update === undefined ? current ?? false : update),
        default: () => false,
    }),

    /**
     * Short, one-line "here's what I'm about to do" message emitted on a tool
     * turn (e.g. "Sure — a 40-min push workout coming up"). Streamed to the user
     * before tool execution. Distinct from `responseToUser`, which carries the
     * post-success recap.
     */
    preamble: Annotation<string | null>({
        reducer: (current, update) => (update === undefined ? current ?? null : update),
        default: () => null,
    }),
    /** Populated by execute_tools for SSE tool_error; cleared by trainer each turn. */
    toolFailureNotices: Annotation<
        { toolName: string; message: string }[] | null
    >({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    // ------------------------------------------------------------------
    // Supervisor routing fields
    // ------------------------------------------------------------------

    /** The agent currently in control of the conversation turn. */
    activeAgent: Annotation<AgentName | null>({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    /** Routing target chosen by the supervisor for the next step. */
    nextAgent: Annotation<SupervisorDecision | null>({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    /**
     * The agent that handled the PREVIOUS user turn. Unlike `activeAgent`
     * (reset by the route initializer every request), this survives across
     * requests via the checkpointer so the supervisor can route short
     * confirmations ("yes", "do it", "ok") back to the agent that asked the
     * question — e.g. the analyst waiting on a calorie-goal confirmation.
     */
    lastAgent: Annotation<AgentName | null>({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    /**
     * Turn complexity classified by the supervisor alongside its routing
     * decision. Drives the mini-first model policy in agentRuntime: "simple"
     * turns (single swaps, logging, quick questions) run editor/analyst on the
     * small model; "complex" turns (plan builds, multi-part requests, nuanced
     * programming) and validation retries escalate to the full decision model.
     * null (fast-paths that skip the LLM router, legacy requests) is treated
     * as "complex" — correctness over cost when unclassified.
     */
    modelComplexity: Annotation<"simple" | "complex" | null>({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    /**
     * Up to 3 short replies the USER might tap to send next, produced by the
     * agent on its final text/recap turn. Streamed to capable clients as the
     * `suggestions` SSE event. Reset per request by the route initializer.
     */
    suggestedReplies: Annotation<string[] | null>({
        reducer: (current, update) => (update === undefined ? current : update),
        default: () => null,
    }),

    /**
     * Count of agent (planner/editor/analyst) decision invocations in THIS
     * request. The graph loops `agent -> execute_tools -> agent` on every
     * read-only tool call (search_exercises, draft staging, etc.), which the
     * duplicate-mutation guard does NOT block — so a model that keeps searching
     * without converging would spin until LangGraph's recursionLimit throws
     * ("Recursion limit reached"). The agent runtime increments this each turn
     * and forces a clean closing reply once a per-turn budget is exhausted.
     * Reset to 0 per request by the route initializer in routes/chat.ts.
     */
    agentTurns: Annotation<number>({
        reducer: (current, update) => (update === undefined ? current ?? 0 : update),
        default: () => 0,
    }),

    /**
     * Prompt-ready RAG block populated by the planner subgraph
     * (fetchAllowedExercises). Optional — only present once the planner has run.
     * Exposed on the global GraphState so non-planner agents (editor, analyst,
     * supervisor) can reuse the same vetted dictionary if needed without
     * re-fetching from Supabase.
     */
    allowedExercises: Annotation<string>({
        reducer: (current, update) => (update === undefined ? current ?? "" : update),
        default: () => "",
    }),
});

export type GraphStateType = typeof GraphState.State;
