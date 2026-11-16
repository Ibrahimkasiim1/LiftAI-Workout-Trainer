/**
 * Supervisor router + master multi-agent graph.
 *
 * Compatibility contract (do NOT regress without updating routes/chat.ts):
 * - State shape is the same `GraphState` defined in ./state.ts. New fields
 *   (`activeAgent`, `nextAgent`, memory*) are additive and have safe defaults.
 * - Tool execution + validator nodes from ./nodes.ts are reused unchanged so
 *   the SSE stream emitter in routes/chat.ts continues to receive the same
 *   `execute_tools` / `validator` graph_node events with the same payloads.
 * - The set of agent node names that produce trainer-style decisions is
 *   exported as `AGENT_NODE_IDS` so the SSE stream emitter can treat them
 *   uniformly (replacing the old `nodeName === "trainer"` check).
 *
 * Flow:
 *
 *   START -> supervisor
 *   supervisor -> { planner_agent | editor_agent | analyst_agent | memory }
 *   (trivial/ambiguous turns: the supervisor authors the reply itself —
 *    greeting, quick general question, or ONE clarifying question — and goes
 *    straight to memory with `completed` + `responseToUser` set)
 *
 *   <agent> -> execute_tools (if shouldCallTool)
 *           -> memory        (otherwise)
 *
 *   execute_tools -> validator   (if workout || planUpdate)
 *                 -> <agent>     (otherwise — agent recaps)
 *
 *   validator -> <agent>  (retry loop, max 3)
 *             -> memory   (success or final failure)
 *
 *   memory -> END  (fire-and-forget memory tasks already detached)
 */

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { AIMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { analystAgentNode, ANALYST_NODE_ID } from "./analystSubgraph";
import { editorAgentNode, EDITOR_NODE_ID } from "./editorSubgraph";
import { cacheableSystemMessage, dynamicSystemMessage } from "./messageHelpers";
import { memoryNode, MEMORY_NODE_ID } from "./memorySubgraph";
import { getAgentModel } from "./modelFactory";
import { toolExecutionNode, validatorNode } from "./nodes";
import { plannerAgentNode, PLANNER_NODE_ID } from "./plannerSubgraph";
import {
    GraphState,
    type AgentName,
    type GraphStateType,
    type SupervisorDecision,
} from "./state";

export const SUPERVISOR_NODE_ID = "supervisor";
export const EXECUTE_TOOLS_NODE_ID = "execute_tools";
export const VALIDATOR_NODE_ID = "validator";

/**
 * Max LangGraph super-steps per invocation. Each node run (supervisor, agent,
 * execute_tools, validator, memory) is one step, so a legitimate multi-agent
 * flow — supervisor + several batched search/mutate/validate/recap turns, plus
 * the per-turn step budget in agentRuntime — needs far more than the old 15.
 * The deterministic AGENT_STEP_BUDGET guard is what actually bounds runaway
 * loops; this is the hard ceiling beneath that. Env-tunable for safety.
 */
export const GRAPH_RECURSION_LIMIT = Number(process.env.GRAPH_RECURSION_LIMIT ?? 48);

/** Node ids that run the per-turn agent decision LLM (mirrors legacy trainer). */
export const AGENT_NODE_IDS: ReadonlySet<string> = new Set([
    PLANNER_NODE_ID,
    EDITOR_NODE_ID,
    ANALYST_NODE_ID,
]);

// ============================================================================
// SUPERVISOR ROUTER NODE
// ============================================================================

/** Lazy: factory reads env at first call so test runs can override per-test. */
const getSupervisorLLM = () => getAgentModel("supervisor");
const SUPERVISOR_TIMEOUT_MS = Number(process.env.SUPERVISOR_LLM_TIMEOUT_MS ?? 20_000);

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

const supervisorSchema = z.object({
    reasoning: z.string(),
    nextAgent: z.enum(["planner", "editor", "analyst", "respond", "finish"]),
    complexity: z.enum(["simple", "complex"]),
    responseToUser: z.string(),
});

const supervisorJsonSchema = {
    type: "object",
    properties: {
        reasoning: { type: "string" },
        nextAgent: {
            type: "string",
            enum: ["planner", "editor", "analyst", "respond", "finish"],
        },
        complexity: {
            type: "string",
            enum: ["simple", "complex"],
        },
        responseToUser: { type: "string" },
    },
    required: ["reasoning", "nextAgent", "complexity", "responseToUser"],
    additionalProperties: false,
} as const;

const SUPERVISOR_PROMPT = [
    "You are LiftAI, the user's personal, elite fitness & nutrition coach.",
    "(Internal-only: this turn you also act as the router that decides which internal module handles the message. This structure is private — NEVER mention agents, routing, modules, or a supervisor to the user.)",
    "Respect user injuries, physical constraints, and preferences provided in USER CONTEXT.",
    "For the user's latest message, either ANSWER IT DIRECTLY (nextAgent: respond) or hand it to exactly ONE agent.",
    "",
    "RESPOND DIRECTLY (nextAgent: 'respond') when — and only when — the message needs NO tools and NONE of the user's stored data:",
    "- Greetings, thanks, small talk, encouragement, banter.",
    "- Quick general fitness/nutrition questions answerable in 2-4 sentences from expert knowledge (e.g. 'is soreness normal?', 'what does RPE mean?', 'protein before or after training?').",
    "- CLARIFICATION: the request is genuinely ambiguous in a way that changes what you'd do (e.g. can't tell if a change is for today only or forever, or which exercise/day they mean, or the message is empty of intent like 'change it'). Ask ONE short, friendly clarifying question offering the concrete options.",
    "When responding directly, write the reply in `responseToUser`: warm, confident, coach-voiced, 1-4 sentences, no lists unless asked. Address them by first name occasionally if provided. NEVER say you are routing, checking with someone, or limited — you ARE the coach.",
    "Do NOT respond directly when the answer should use their plan, history, macros, or any tool — route instead, and set `responseToUser` to \"\".",
    "",
    "Agents:",
    "- planner: PERMANENT plan-level edits AND full plan rebuilds (split changes, 'rebuild my whole split', 'switch me to PPL', swap an exercise across the whole program, restructure the week, change saved equipment). Pick this for explicit permanence ('forever', 'from now on', 'always', 'permanently') or any whole-program redesign.",
    "- editor: Default for workout actions. Per-session tweaks, one-off workouts to perform now, temporary overrides (injury/travel/equipment for N weeks), reschedule/shift upcoming workouts, today's adjustments, technique/form coaching, motivation, editing profile/settings (name, goal, days per week, units, body metrics), anything ambiguous about whether change is forever or short-term.",
    "- analyst: Progress data + nutrition/weight tracking AND the user's calorie/macro goals. Reads (history, PRs, volume trends, current macro goals, weight history) AND writes (log a meal, edit/delete a meal, set/adjust daily calorie & macro targets, log body weight, log a completed workout, log an ad-hoc set/lift). ANY message about the user's calorie/macro goal — including complaints that it's too high/low or 'I'm not losing weight / just maintaining' — goes here, because the analyst can pull their numbers and adjust the target.",
    "- finish: Socially closing turns after an agent already responded in this loop and no further user-facing content is needed.",
    "",
    "Decision rules:",
    "1. If unsure between planner and editor, choose editor.",
    "2. If the user is asking about THEIR data (history/volume/PR/macros) OR about their calorie/macro goal (including wanting it changed or saying it isn't producing results), choose analyst.",
    "3. Prefer 'respond' over 'editor' for pure conversation; prefer an agent whenever their plan or data is involved.",
    "4. Choose finish ONLY when no agent action is needed and the conversation is socially closing after an agent response in this loop. NEVER choose finish on a user's first message.",
    "5. CONTINUITY: if a PREVIOUS AGENT is provided and the user's message is a follow-up, answer, confirmation, or correction to what that agent said (visible in RECENT CONVERSATION), route back to that SAME agent so the pending action isn't dropped — do NOT respond directly or ask for clarification you can infer from the conversation.",
    "",
    "Also classify `complexity` (drives which model the agent runs on):",
    "- simple: one small action or question — a single swap, one log entry, a schedule shift, 'what's my workout today?', a one-line profile edit.",
    "- complex: anything that builds or rebuilds a workout/plan, multi-part requests, programming or nutrition analysis with judgment, injury-sensitive changes, or a frustrated user recovering from an error.",
    "When nextAgent is 'respond' or 'finish', set complexity to 'simple'.",
    "",
    'Respond with strict JSON: { "reasoning": "...", "nextAgent": "planner" | "editor" | "analyst" | "respond" | "finish", "complexity": "simple" | "complex", "responseToUser": "..." (empty string unless nextAgent is "respond") }.',
].join("\n");

function renderSupervisorUserContext(state: GraphStateType): string {
    const context = state.userContext?.trim();
    return [
        "[USER CONTEXT AND CONSTRAINTS]",
        context && context.length > 0 ? context : "(none)",
        "[END USER CONTEXT]",
        "You must strictly abide by the user's physical constraints, injuries, and preferences listed above.",
    ].join("\n");
}

function lastUserMessage(state: GraphStateType): string {
    const last = state.messages[state.messages.length - 1];
    return last ? String(last.content).slice(0, 1200) : "";
}

function recentExchange(state: GraphStateType): string {
    // 6 messages / 400 chars (was 4 / 240): references like "change that back
    // to what we discussed" routinely point 2-3 exchanges back, and the old
    // window made the router guess. gpt-4.1-mini makes the extra tokens
    // essentially free relative to a mis-route.
    return state.messages
        .slice(-6)
        .map((m) => `${m._getType()}: ${String(m.content).slice(0, 400)}`)
        .join("\n");
}

/**
 * Deterministic fast-path: pure greetings / acknowledgements always route to
 * the editor (the supervisor prompt mandates exactly that), so spending a
 * full LLM round-trip to decide it only adds latency to the most common
 * message in the app. Deliberately conservative — anything with actual
 * content falls through to the LLM router.
 */
const GREETING_FAST_PATH =
    /^(hi+|hii+|hey+|heya|hello+|yo+|sup|wassup|what'?s up|good (morning|afternoon|evening)|morning|evening|thanks?|thank you|thanks a lot|thx|ty|ok(ay)?|cool|nice|great|awesome|perfect|sounds good|got it|lol|haha+)[\s!,.?😊🙏👍💪🔥]*$/i;

export function isGreetingFastPath(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length > 0 && trimmed.length <= 40 && GREETING_FAST_PATH.test(trimmed);
}

/**
 * Deterministic fast-path for unambiguous logging messages — meals, weigh-ins,
 * and ad-hoc sets are all owned by the analyst, so "log …" / "I ate …" never
 * needs an LLM routing decision. High precision over recall: anything that
 * doesn't clearly match falls through to the LLM router.
 */
const LOGGING_FAST_PATHS: ReadonlyArray<RegExp> = [
    /^log\s+(?!in\b|out\b|me\s+(in|out)\b)/i, // "log 2 eggs", "log bench 3x8 @80kg", "log my weight 75"
    /^i\s+(just\s+)?ate\b/i,
    /^i\s+(just\s+)?had\b.*\b(breakfast|lunch|dinner|snack|meal|protein|kcal|cal(orie)?s?)\b/i,
    /^i\s+weighed?\s/i,
    /^my\s+weight\s+is\b/i,
    /^weighed\s+myself\b/i,
];

export function isLoggingFastPath(text: string): boolean {
    const trimmed = text.trim();
    return (
        trimmed.length > 0 &&
        trimmed.length <= 200 &&
        LOGGING_FAST_PATHS.some((re) => re.test(trimmed))
    );
}

/**
 * Deterministic fast-path for "what's my workout today?"-class questions.
 * Every agent receives the ACTIVE PLAN (week at a glance, today expanded) in
 * its dynamic context, so the editor answers these in ONE model call with no
 * tools — spending a supervisor LLM round-trip to route the single most common
 * read question in the app was pure latency. High precision over recall.
 */
const TODAYS_WORKOUT_FAST_PATHS: ReadonlyArray<RegExp> = [
    // "what's my workout today", "what is the workout for today?", "whats my session tomorrow"
    /^what('?s| is)\s+(my|the)\s+(workout|training|session|plan)(\s+(for|like))?(\s+(today|tonight|tomorrow|this week))?\s*\??$/i,
    // "what am I training today", "what do I have today", "what am I doing tomorrow"
    /^what\s+(am\s+i|do\s+i)\s+(train(ing)?|lift(ing)?|do(ing)?|have|hit(ting)?)(\s+(today|tonight|tomorrow))?\s*\??$/i,
    // "today's workout?", "tomorrows session"
    /^(today'?s?|tomorrow'?s?)\s+(workout|session|training|plan)\s*\??$/i,
    // "do I train today?", "am I working out today"
    /^(do|am)\s+i\s+(train(ing)?|work(ing)?\s*out|lift(ing)?)(\s+(today|tonight|tomorrow))?\s*\??$/i,
];

export function isTodaysWorkoutFastPath(text: string): boolean {
    const trimmed = text.trim();
    return (
        trimmed.length > 0 &&
        trimmed.length <= 80 &&
        TODAYS_WORKOUT_FAST_PATHS.some((re) => re.test(trimmed))
    );
}

/**
 * Deterministic fast-path for the analyst's read-only data questions —
 * macro/calorie goals, body weight, progress. These always route to the
 * analyst (it owns every one of those tools), so the LLM router adds nothing
 * but latency. High precision: anything phrased unusually falls through.
 */
const DATA_READ_FAST_PATHS: ReadonlyArray<RegExp> = [
    // "what are my macros", "what's my macro goals", "my calorie goal?"
    /^(what('?s| is| are)\s+)?(my\s+)?(macros?|macro\s+(goals?|targets?)|(daily\s+)?calorie\s+(goal|target|budget)s?)(\s+(for\s+)?today)?\s*\??$/i,
    // "how many calories should I eat", "how many calories do I have left"
    /^how\s+many\s+calories\s+(should\s+i\s+(eat|have)|do\s+i\s+(have\s+left|get))(\s+(today|per\s+day|a\s+day))?\s*\??$/i,
    // "what's my weight", "show my weight history/trend", "how much do I weigh"
    /^((what('?s| is)|show( me)?)\s+(my\s+)?weight(\s+(history|trend|progress|change))?|how\s+much\s+do\s+i\s+weigh(\s+now)?)\s*\??$/i,
    // "how am I progressing", "am I making progress", "am I getting stronger"
    /^(how\s+am\s+i\s+progress(ing)?|am\s+i\s+(making\s+progress|progressing|getting\s+stronger))\s*\??$/i,
];

export function isDataReadFastPath(text: string): boolean {
    const trimmed = text.trim();
    return (
        trimmed.length > 0 &&
        trimmed.length <= 80 &&
        DATA_READ_FAST_PATHS.some((re) => re.test(trimmed))
    );
}

/**
 * Deterministic fast-path for short confirmations / declines / follow-ups.
 * When the previous turn's agent asked the user a question ("want me to set
 * your calories to 2,300?"), the reply — "yes", "do it", "ok", "no, make it
 * 2500" — MUST return to that same agent. The LLM router used to treat these
 * as greetings/small-talk and hand them to the editor, silently dropping the
 * pending action (the confirmed change never happened). This also skips a
 * full supervisor LLM round-trip on the most common follow-up messages.
 */
const CONFIRMATION_FAST_PATH =
    /^((yes|yeah|yep|yup|ye|sure|ok(ay)?)(,?\s*(please|do it|go ahead))?|k|do it|go ahead|go for it|please do|sounds good|let'?s do it|confirm(ed)?|approve(d)?|publish( it)?|apply( it)?|update it|change it|set it|make it \d[\d,.]*\s*(kcal|cal(orie)?s?|g)?|no(,?\s*(not yet|thanks|thank you|cancel|leave it))?|nope|nah|not yet|hold off|cancel|don'?t|leave it|\d[\d,.]*\s*(kcal|cal(orie)?s?|g)?)[\s!.,🙏👍💪🔥]*$/i;

export function isConfirmationFastPath(text: string, lastAgent: string | null | undefined): boolean {
    if (!lastAgent || lastAgent === "supervisor") return false;
    const trimmed = text.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && CONFIRMATION_FAST_PATH.test(trimmed);
}

function agentFromLast(lastAgent: string | null | undefined): SupervisorDecision {
    switch (lastAgent) {
        case "planner":
            return "planner";
        case "analyst":
            return "analyst";
        default:
            return "editor";
    }
}

/**
 * Direct coach reply for trivial turns (greeting fast-path). One small-model
 * call with a compact persona prompt instead of a full editor turn (whose
 * static prompt alone is thousands of tokens). Returns null on any failure so
 * the caller can fall back to routing.
 */
const DIRECT_REPLY_PROMPT = [
    "You are LiftAI, the user's personal, elite fitness & nutrition coach chatting inside your app.",
    "Reply to the user's latest message: warm, confident, coach-voiced, 1-3 short sentences.",
    "If they greeted you, greet back naturally and nudge toward today's training or how they're feeling — without being pushy.",
    "If they thanked you or closed the conversation, close warmly. No lists, no emojis unless they used one first.",
    "NEVER mention agents, routing, systems, or tools. You are simply their coach.",
].join("\n");

async function generateDirectReply(state: GraphStateType): Promise<string | null> {
    try {
        const profile = state.userProfile ?? {};
        const name =
            typeof profile.name === "string" && profile.name.trim()
                ? profile.name.trim().split(/\s+/)[0]
                : null;
        const result = await withTimeout(
            getSupervisorLLM().invoke([
                cacheableSystemMessage(DIRECT_REPLY_PROMPT),
                dynamicSystemMessage(
                    [
                        name ? `User's first name: ${name} (use it naturally, not every time).` : "",
                        `RECENT CONVERSATION:\n${recentExchange(state)}`,
                    ]
                        .filter(Boolean)
                        .join("\n")
                ),
            ]),
            SUPERVISOR_TIMEOUT_MS,
            "direct reply"
        );
        const text = typeof result.content === "string" ? result.content.trim() : "";
        return text.length > 0 ? text : null;
    } catch (err) {
        console.warn("Direct reply generation failed, falling back to routing:", err);
        return null;
    }
}

/** State delta for a supervisor-authored reply: straight to memory → END. */
function directReplyDelta(reply: string): Partial<GraphStateType> {
    return {
        activeAgent: "supervisor",
        nextAgent: "finish",
        modelComplexity: "simple",
        shouldCallTool: false,
        toolCalls: [],
        responseToUser: reply,
        completed: true,
        messages: [new AIMessage(reply)],
        // lastAgent deliberately NOT set: a pending question from the previous
        // agent (e.g. an unconfirmed calorie change) must still own the user's
        // next short confirmation.
    };
}

export async function supervisorNode(
    state: GraphStateType
): Promise<Partial<GraphStateType>> {
    console.log("Supervisor routing");

    const userText = lastUserMessage(state);
    if (!userText) {
        return {
            activeAgent: "supervisor",
            nextAgent: "finish",
        };
    }

    // Confirmations must be checked BEFORE greetings: "ok" / "sounds good"
    // matches both, but when an agent asked a question last turn, the reply
    // belongs to that agent — not to the small-talk path. Confirmations often
    // trigger the pending mutation, so they stay on the full decision model.
    if (isConfirmationFastPath(userText, state.lastAgent)) {
        const target = agentFromLast(state.lastAgent);
        console.log(`Supervisor → ${target} (confirmation fast-path → previous agent, no LLM)`);
        return {
            activeAgent: "supervisor",
            nextAgent: target,
            modelComplexity: "complex",
        };
    }

    // Pure greetings/acks get a direct coach reply from the small model — no
    // specialist turn at all. Falls back to the editor if generation fails.
    if (isGreetingFastPath(userText)) {
        const reply = await generateDirectReply(state);
        if (reply) {
            console.log("Supervisor → direct reply (greeting fast-path)");
            return directReplyDelta(reply);
        }
        console.log("Supervisor → editor (greeting fast-path, direct reply unavailable)");
        return {
            activeAgent: "supervisor",
            nextAgent: "editor",
            modelComplexity: "simple",
        };
    }

    if (isLoggingFastPath(userText)) {
        console.log("Supervisor → analyst (logging fast-path, no LLM)");
        return {
            activeAgent: "supervisor",
            nextAgent: "analyst",
            modelComplexity: "simple",
        };
    }

    // "What's my workout today?" — the editor answers straight from the plan
    // snapshot in its dynamic context, no tools needed.
    if (isTodaysWorkoutFastPath(userText)) {
        console.log("Supervisor → editor (today's-workout fast-path, no LLM)");
        return {
            activeAgent: "supervisor",
            nextAgent: "editor",
            modelComplexity: "simple",
        };
    }

    // Macro goals / body weight / progress reads — always the analyst's tools.
    if (isDataReadFastPath(userText)) {
        console.log("Supervisor → analyst (data-read fast-path, no LLM)");
        return {
            activeAgent: "supervisor",
            nextAgent: "analyst",
            modelComplexity: "simple",
        };
    }

    try {
        const structured = getSupervisorLLM().withStructuredOutput(supervisorJsonSchema, {
            name: "supervisor_decision",
        });
        const decision = (await withTimeout(
            structured.invoke([
                cacheableSystemMessage(SUPERVISOR_PROMPT),
                dynamicSystemMessage(renderSupervisorUserContext(state)),
                dynamicSystemMessage(
                    `PREVIOUS AGENT (handled the user's last message): ${state.lastAgent ?? "(none — first message)"}`
                ),
                dynamicSystemMessage(`RECENT CONVERSATION:\n${recentExchange(state)}`),
                dynamicSystemMessage(`USER MESSAGE:\n${userText}`),
            ]),
            SUPERVISOR_TIMEOUT_MS,
            "supervisor decision"
        )) as z.infer<typeof supervisorSchema>;

        console.log(
            `Supervisor → ${decision.nextAgent} [${decision.complexity}] (${decision.reasoning.slice(0, 100)})`
        );

        // Direct answer / clarifying question authored by the supervisor
        // itself — trivial or ambiguous turns never pay a specialist turn.
        if (decision.nextAgent === "respond") {
            const reply = (decision.responseToUser ?? "").trim();
            if (reply.length > 0) {
                return directReplyDelta(reply);
            }
            // respond with no text is a contract violation — fall through to
            // the conversational default rather than sending dead air.
            console.warn("Supervisor chose respond with empty reply — routing to editor");
            return {
                activeAgent: "supervisor",
                nextAgent: "editor",
                modelComplexity: "simple",
            };
        }

        return {
            activeAgent: "supervisor",
            nextAgent: decision.nextAgent as SupervisorDecision,
            modelComplexity: decision.complexity,
        };
    } catch (err) {
        console.error("Supervisor decision failed, defaulting to editor:", err);
        return {
            activeAgent: "supervisor",
            nextAgent: "editor",
            // Unclassified: agentRuntime treats null as complex (full model).
            modelComplexity: null,
        };
    }
}

// ============================================================================
// CONDITIONAL EDGES
// ============================================================================

function agentNodeForActive(agent: AgentName | null): string {
    switch (agent) {
        case "planner":
            return PLANNER_NODE_ID;
        case "editor":
            return EDITOR_NODE_ID;
        case "analyst":
            return ANALYST_NODE_ID;
        // Fallback to editor when state is missing (handles legacy/incoming
        // requests that didn't initialize the new fields).
        default:
            return EDITOR_NODE_ID;
    }
}

function routeFromSupervisor(state: GraphStateType): string {
    switch (state.nextAgent) {
        case "planner":
            return PLANNER_NODE_ID;
        case "editor":
            return EDITOR_NODE_ID;
        case "analyst":
            return ANALYST_NODE_ID;
        case "finish":
        default:
            return MEMORY_NODE_ID;
    }
}

function routeFromAgent(state: GraphStateType): string {
    if (state.shouldCallTool && Array.isArray(state.toolCalls) && state.toolCalls.length > 0) {
        return EXECUTE_TOOLS_NODE_ID;
    }
    return MEMORY_NODE_ID;
}

export function routeAfterTools(state: GraphStateType): string {
    // A freshly built workout / plan update must be validated (every exercise
    // has a real id + gif_path) before it reaches the user. Other mutations
    // (overrides, swaps, schedule shifts) skip straight to the agent recap.
    const needsValidation = Boolean(
        (state.workout?.exercises?.length ?? 0) > 0 ||
            (state.planUpdate?.days?.length ?? 0) > 0
    );
    if (needsValidation) {
        return VALIDATOR_NODE_ID;
    }
    // Deterministic recap: execute_tools already wrote the user-facing reply
    // from the tool result (simple logging/shift mutations) — no LLM recap
    // turn needed, go straight to memory.
    if (state.completed && (state.responseToUser ?? "").length > 0) {
        return MEMORY_NODE_ID;
    }
    // Otherwise return to the active agent so it can recap what changed.
    return agentNodeForActive(state.activeAgent);
}

export function routeAfterValidator(state: GraphStateType): string {
    // Every validator outcome hands back to the active agent — the DIFFERENCE
    // is in state, not routing: on failure (retries left) the mutation lock is
    // still open and the validator injected a rebuild instruction; on success
    // or final give-up the lock (turnMutationDone) is set, so the agent can
    // only write a recap/apology.
    return agentNodeForActive(state.activeAgent);
}

// ============================================================================
// BUILD GRAPH
// ============================================================================

export const supervisorWorkflow = new StateGraph(GraphState)
    .addNode(SUPERVISOR_NODE_ID, supervisorNode)
    .addNode(PLANNER_NODE_ID, plannerAgentNode)
    .addNode(EDITOR_NODE_ID, editorAgentNode)
    .addNode(ANALYST_NODE_ID, analystAgentNode)
    .addNode(EXECUTE_TOOLS_NODE_ID, toolExecutionNode)
    .addNode(VALIDATOR_NODE_ID, validatorNode)
    .addNode(MEMORY_NODE_ID, memoryNode)

    .addEdge(START, SUPERVISOR_NODE_ID)

    .addConditionalEdges(SUPERVISOR_NODE_ID, routeFromSupervisor, {
        [PLANNER_NODE_ID]: PLANNER_NODE_ID,
        [EDITOR_NODE_ID]: EDITOR_NODE_ID,
        [ANALYST_NODE_ID]: ANALYST_NODE_ID,
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
    })

    .addConditionalEdges(PLANNER_NODE_ID, routeFromAgent, {
        [EXECUTE_TOOLS_NODE_ID]: EXECUTE_TOOLS_NODE_ID,
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
    })
    .addConditionalEdges(EDITOR_NODE_ID, routeFromAgent, {
        [EXECUTE_TOOLS_NODE_ID]: EXECUTE_TOOLS_NODE_ID,
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
    })
    .addConditionalEdges(ANALYST_NODE_ID, routeFromAgent, {
        [EXECUTE_TOOLS_NODE_ID]: EXECUTE_TOOLS_NODE_ID,
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
    })

    .addConditionalEdges(EXECUTE_TOOLS_NODE_ID, routeAfterTools, {
        [VALIDATOR_NODE_ID]: VALIDATOR_NODE_ID,
        [PLANNER_NODE_ID]: PLANNER_NODE_ID,
        [EDITOR_NODE_ID]: EDITOR_NODE_ID,
        [ANALYST_NODE_ID]: ANALYST_NODE_ID,
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
    })

    .addConditionalEdges(VALIDATOR_NODE_ID, routeAfterValidator, {
        [MEMORY_NODE_ID]: MEMORY_NODE_ID,
        [PLANNER_NODE_ID]: PLANNER_NODE_ID,
        [EDITOR_NODE_ID]: EDITOR_NODE_ID,
        [ANALYST_NODE_ID]: ANALYST_NODE_ID,
    })

    .addEdge(MEMORY_NODE_ID, END);

export function compileSupervisorGraph(checkpointer: BaseCheckpointSaver | false) {
    return supervisorWorkflow.compile({ checkpointer });
}

/** @deprecated Direct compile; prefer initLangGraph() in langgraphRuntime.ts */
export const supervisorGraph = supervisorWorkflow.compile();
