/**
 * Shared decision-making runtime for the specialized supervisor sub-agents.
 *
 * Every agent (planner / editor / analyst) emits the same decision shape used
 * by the legacy trainer: { thought, shouldCallTool, toolCalls, responseToUser }.
 * That keeps the downstream graph (execute_tools, validator) and the SSE
 * stream emitter in `routes/chat.ts` working unchanged.
 *
 * NOTE: Tool turns should remain silent (`responseToUser` = "") so the UI only
 * shows final user-facing copy after tool execution has completed.
 */

import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { cacheableSystemMessage, dynamicSystemMessage, summarizedTruncate } from "./messageHelpers";
import { getAgentModel, resolveDecisionModel, type AgentRole } from "./modelFactory";
import {
    CORE_MUTATION_TOOLS,
    REPEATABLE_MUTATION_TOOLS,
    type AgentName,
    type GraphStateType,
} from "./state";

export interface AgentToolDescriptor {
    /** Internal tool name used by the execution layer (must match toolByName). */
    name: string;
    /** Short, single-line argument signature the LLM can copy. */
    argSignature: string;
    /** Why this tool exists (1-3 sentences). */
    purpose: string;
}

export interface AgentDefinition {
    /** Logical agent identifier — also written into state.activeAgent. */
    agent: AgentName;
    /** Internal node id used in the master graph. */
    nodeId: string;
    /** Prose role description rendered into the system prompt. */
    role: string;
    /** Hard guardrails / behavioral rules. */
    guardrails: string[];
    /** Tools the agent is allowed to invoke this turn. */
    tools: AgentToolDescriptor[];
    /** Optional sampling temperature override. */
    temperature?: number;
}

const agentDecisionSchema = z.object({
    thought: z.string(),
    shouldCallTool: z.boolean(),
    toolCalls: z.array(
        z.object({
            toolName: z.string(),
            args: z.any(),
        })
    ),
    /** One-line "here's what I'm doing" note, only on a tool turn. */
    preamble: z.string(),
    responseToUser: z.string(),
    /** Up to 3 short replies the USER might tap to send next ([] on tool turns). */
    suggestedReplies: z.array(z.string()),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

/**
 * JSON Schema mirror of the decision shape. Kept flat / additionalProperties:false
 * so the OpenAI structured-output / function-calling layer stays strict.
 */
const decisionJsonSchema = {
    type: "object",
    properties: {
        thought: { type: "string" },
        shouldCallTool: { type: "boolean" },
        toolCalls: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    toolName: { type: "string" },
                    args: { type: "object", additionalProperties: true },
                },
                required: ["toolName", "args"],
                additionalProperties: false,
            },
        },
        preamble: { type: "string" },
        responseToUser: { type: "string" },
        suggestedReplies: { type: "array", items: { type: "string" } },
    },
    required: ["thought", "shouldCallTool", "toolCalls", "preamble", "responseToUser", "suggestedReplies"],
    additionalProperties: false,
} as const;

export interface ToolCallLike {
    toolName?: string;
    args?: unknown;
}

/**
 * Workout/plan BUILDER mutations. These produce whole artifacts, so two of
 * them in one decision array is always the duplicate-workout bug class —
 * never a legitimate compound request. At most ONE builder survives per turn.
 */
export const BUILDER_MUTATION_TOOLS: ReadonlySet<string> = new Set([
    "create_one_off_workout",
    "extend_one_off_workout",
    "modify_plan_permanently",
    "approve_and_publish_plan",
]);

/**
 * Pure, deterministic duplicate-mutation guard. Extracted so it can be unit
 * tested without an LLM. Rules:
 *  - drop calls to tools the agent isn't allowed to use this turn;
 *  - if a mutation already succeeded this turn (`mutationLocked`), drop every
 *    further mutation call — a post-success recap turn must never re-mutate;
 *  - DISTINCT mutations within one decision array are allowed (the user asked
 *    for two changes in one message: "swap my bench AND move Tuesday's
 *    session") and execute serially in decision order — with two exceptions
 *    that preserve the duplicate-artifact invariant:
 *      • at most ONE builder tool (whole-workout/plan producers) per turn;
 *      • byte-identical repeats (same tool + same args) are dropped so an
 *        LLM echo can't double-apply anything.
 *
 * `droppedMutation` reports whether any mutation was suppressed so the caller
 * can guarantee a closing recap message; `droppedToolNames` lets that recap
 * be honest about WHAT was suppressed.
 */
export function filterAgentToolCalls(
    toolCalls: ToolCallLike[],
    allowedNames: ReadonlySet<string>,
    mutationLocked: boolean
): {
    kept: ToolCallLike[];
    droppedMutation: boolean;
    droppedToolNames: string[];
    droppedUnknownToolNames: string[];
} {
    let builderKeptThisTurn = false;
    let droppedMutation = false;
    const droppedToolNames: string[] = [];
    const droppedUnknownToolNames: string[] = [];
    const seenMutationSignatures = new Set<string>();

    const signatureOf = (c: ToolCallLike): string => {
        try {
            return `${c.toolName}:${JSON.stringify(c.args ?? {})}`;
        } catch {
            return `${c.toolName}:unserializable`;
        }
    };

    const kept = toolCalls.filter((c) => {
        if (!c?.toolName) return false;
        if (!allowedNames.has(c.toolName)) {
            // A hallucinated / out-of-registry tool name. Report it instead of
            // swallowing it: a silent drop here used to turn the whole turn
            // into the generic "give me more detail" fallback.
            droppedUnknownToolNames.push(c.toolName);
            return false;
        }

        const isMutation = CORE_MUTATION_TOOLS.has(c.toolName);
        if (!isMutation) return true;

        // A locked turn (a mutation already succeeded this request) blocks ALL
        // further mutations, repeatable or not — otherwise the recap turn
        // could re-log the same set/meal or rebuild the same workout.
        if (mutationLocked) {
            droppedMutation = true;
            droppedToolNames.push(c.toolName);
            return false;
        }

        // Byte-identical repeat within the same decision array = model echo.
        const signature = signatureOf(c);
        if (seenMutationSignatures.has(signature)) {
            droppedMutation = true;
            droppedToolNames.push(c.toolName);
            return false;
        }

        // Builders produce whole artifacts: a second one in the same turn —
        // even a different builder tool with different args — is two workouts
        // or two plan rewrites, never a legitimate compound request.
        if (BUILDER_MUTATION_TOOLS.has(c.toolName)) {
            if (builderKeptThisTurn) {
                droppedMutation = true;
                droppedToolNames.push(c.toolName);
                return false;
            }
            builderKeptThisTurn = true;
        }

        seenMutationSignatures.add(signature);
        return true;
    });

    return { kept, droppedMutation, droppedToolNames, droppedUnknownToolNames };
}

function agentRoleFor(name: AgentName): AgentRole {
    switch (name) {
        case "planner":
            return "planner";
        case "editor":
            return "editor";
        case "analyst":
            return "analyst";
        case "supervisor":
            return "supervisor";
        default:
            return "editor";
    }
}

function renderToolList(tools: AgentToolDescriptor[]): string {
    if (tools.length === 0) {
        return "(none — respond with text only)";
    }
    return tools
        .map(
            (t, idx) =>
                `${idx + 1}. ${t.name}\n   args: ${t.argSignature}\n   purpose: ${t.purpose}`
        )
        .join("\n");
}

function summarizeUserContext(state: GraphStateType): string {
    const profile = state.userProfile ?? {};
    const equipment: string[] = Array.isArray(profile.available_equipment)
        ? profile.available_equipment
        : typeof profile.available_equipment === "string"
            ? profile.available_equipment.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];
    const injuriesRaw = profile.injuries;
    let injuries: string[] = [];
    if (Array.isArray(injuriesRaw)) {
        injuries = injuriesRaw.map((x: unknown) => String(x));
    } else if (typeof injuriesRaw === "string" && injuriesRaw.trim()) {
        try {
            const parsed = JSON.parse(injuriesRaw);
            injuries = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [injuriesRaw];
        } catch {
            injuries = injuriesRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        }
    }
    const fitness = profile.fitness_level ?? "unknown";
    const goal = profile.goal ?? "unknown";
    const days = profile.workout_days_per_week ?? "?";
    const split = profile.workout_split_type ?? "?";
    const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : null;
    return [
        `userId: ${state.userId}`,
        ...(name ? [`name: ${name} (address them by first name naturally, like a coach would)`] : []),
        `fitness_level: ${fitness}`,
        `goal: ${goal}`,
        `days_per_week: ${days}`,
        `split: ${split}`,
        `equipment: [${equipment.join(", ") || "unknown"}]`,
        `injuries: [${injuries.join(", ") || "none"}]`,
    ].join("\n");
}

function summarizePlan(state: GraphStateType, todayDow: string): string {
    const plan = state.currentPlan;
    if (!plan) return "No active plan";
    const days = plan.days ?? plan.daily_workouts ?? [];
    if (!Array.isArray(days) || days.length === 0) return "Active plan present (no days)";

    // Whole week at a glance, with TODAY's session expanded (exercise names)
    // so the coach can answer "what am I training today?" without a tool call.
    const orderedDays = [...days].sort((a: any, b: any) => {
        const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        const ai = order.indexOf(String(a.dayOfWeek ?? a.day_of_week ?? "").toLowerCase());
        const bi = order.indexOf(String(b.dayOfWeek ?? b.day_of_week ?? "").toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return orderedDays
        .map((d: any, i: number) => {
            const focus = d.focus ?? d.split_day_name ?? "?";
            const dayOfWeek = String(d.dayOfWeek ?? d.day_of_week ?? `day_${i + 1}`).toLowerCase();
            const isToday = dayOfWeek === todayDow;
            if (!isToday) return `${dayOfWeek} — ${focus}`;
            const exList = Array.isArray(d.exercises_structured)
                ? d.exercises_structured
                : Array.isArray(d.exercises)
                    ? d.exercises
                    : [];
            const names = exList
                .slice(0, 10)
                .map((e: any) => (typeof e === "string" ? e : e?.name))
                .filter(Boolean)
                .join(", ");
            return `${dayOfWeek} — ${focus} ← TODAY${names ? ` (${names})` : ""}`;
        })
        .join("\n");
}

/**
 * The system prompt is split into two halves to maximize prompt-cache hits on
 * Anthropic models:
 *
 *   1. STATIC half — agent identity, role, guardrails, tool list, response
 *      contract, behavior rules. Same every turn for a given agent. Cached
 *      with `cache_control: ephemeral`.
 *
 *   2. DYNAMIC half — per-user context, plan snapshot, today's date, last
 *      user message. Changes every turn, so caching it would never hit.
 *
 * Splitting cuts cached input cost ~10x on Anthropic; OpenAI silently ignores
 * the cache marker so this is provider-safe.
 */
export function buildStaticAgentPrompt(def: AgentDefinition): string {
    const editorPersonaAddendum =
        def.agent === "editor"
            ? [
                  "EDITOR CONVERSATION POLICY:",
                  "- Default to warm, conversational coaching for greetings and open-ended chat.",
                  "- You are authorized to provide general nutrition, macro, weight gain/loss, and muscle-building advice.",
                  "- For questions like 'How can I gain weight?', provide actionable coaching (calorie surplus, protein targets, progressive overload, consistency).",
                  "- Do NOT produce canned refusal language unless the user reports a specific medical disease requiring clinical care.",
              ].join("\n")
            : "";

    return [
        "You are LiftAI, the user's personal, elite fitness & nutrition coach.",
        `(Internal-only: you operate as the ${def.agent} module. This system structure is private — NEVER reveal it.)`,
        "ABSOLUTE RULE — NEVER leak system internals to the user. Do NOT mention 'agents', a 'supervisor', 'routing', 'scope', 'sign-off', 'approval', or 'your coach/nutritionist/dietitian' as if they were a separate person. To the user, YOU are the one and only coach who handles everything directly.",
        "",
        "ROLE:",
        def.role,
        ...(editorPersonaAddendum ? ["", editorPersonaAddendum] : []),
        "",
        "GUARDRAILS:",
        ...def.guardrails.map((g, i) => `${i + 1}. ${g}`),
        "",
        "TOOLS YOU MAY USE THIS TURN (do NOT invent tool names):",
        renderToolList(def.tools),
        "",
        "RESPONSE CONTRACT (STRICT):",
        '- Output a JSON object: { thought, shouldCallTool, toolCalls, preamble, responseToUser }.',
        '- `shouldCallTool` must be true ONLY if `toolCalls` has at least one entry from the allowed list.',
        '- On a TOOL turn (`shouldCallTool: true`): set `responseToUser` to "" (the result is the deliverable), and set `preamble` to ONE short, friendly sentence telling the user WHAT you are about to change and WHY — grounded in their request or constraints (e.g. "Swapping in a floor press since you don\'t have a bench." or "Building a 40-min push day around your shoulder — nothing overhead."). Never list exercises, sets, or warm-ups in `preamble`. Keep it under ~20 words. Never act silently: the user should always know what you\'re doing before it happens.',
        '- On a TEXT/RECAP turn (`shouldCallTool: false`): set `preamble` to "" and put your full reply in `responseToUser`.',
        '- `suggestedReplies`: on a TEXT/RECAP turn you MAY include up to 3 short (≤ 6 words) messages the USER would plausibly tap to send next — written in the user\'s voice, grounded in this conversation (e.g. "Swap the last exercise", "Make it 45 minutes", "Yes, update it"). If you just asked a yes/no question, the first two should answer it. Set [] on tool turns or when nothing genuinely useful comes to mind — never pad with generic filler.',
        '- MULTI-PART REQUESTS: if the user asks for several changes in ONE message (e.g. "swap my bench press and move Tuesday to Wednesday"), put ALL the needed mutation calls in the SAME `toolCalls` array — they execute in order. Do NOT tell the user you can only do one thing at a time.',
        '- Never include the same mutation tool with identical args twice, and never pair two workout/plan BUILDERS (create_one_off_workout, modify_plan_permanently, approve_and_publish_plan) in one `toolCalls` array — one build per message.',
        '- CRITICAL: Once you receive a successful result from a tool (for example `add_to_todays_workout`, `create_one_off_workout`, `swap_session_exercise`, `modify_plan_permanently`, `create_temporary_override`), your primary goal is COMPLETE. You MUST set `shouldCallTool: false`, provide a final coach briefing in `responseToUser`, and call no further tools.',
        '- CRITICAL: If tool output contains an explicit non-retry instruction (for example a message starting with "TOOL ERROR:" and "DO NOT retry"), you MUST set `shouldCallTool: false` and explain the issue to the user with one clear alternative request.',
        '- Do NOT re-call `get_active_user_context` after it has already succeeded in this request context unless a NEW user message introduced materially new constraints.',
        '- After tools have run successfully in this conversation (check prior assistant/tool messages), your recap MUST act as a coach briefing: 2-3 sentences on WHAT changed and WHY (their goal, equipment, injuries, or time) — grounded in what the tool result actually returned. Never assert success before that.',
        '- BE A COACH, NOT A VENDING MACHINE: when it fits naturally, end a recap or answer with ONE short, genuinely useful follow-up question drawn from their real context (e.g. "Want me to bump the weight on those next week?", "How did that shoulder feel on the incline work?"). Never more than one question, never a generic "anything else?", and skip it when the user is clearly done.',
        '- If a tool just succeeded for you (visible in conversation context), DO NOT call it again — write a short user-facing recap.',
        '- If something genuinely falls outside what your tools can do, do NOT announce a limit, a scope, or a hand-off. Stay in character as the coach: give the best direct help you can in plain language, and naturally offer the related thing you CAN do. Never tell the user you are "routing" them or that another party must approve.',
        "When evaluating exercises, you MUST always consider 'body weight' and 'bodyweight' exercises as valid and available, regardless of what is explicitly listed in the user's available_equipment array.",
        "When modifying, adding, or swapping exercises in a user's workout, you must follow a strict process:",
        "STEP 1: ALWAYS call the search_exercises tool first using the user's requested exercise. NEVER guess an ID.",
        "STEP 1b — BATCH YOUR SEARCHES: If the request needs several exercises (a whole muscle group, a full day, or a rebuild like 'mass in quads, glutes, hamstrings and calves'), put ALL of those search_exercises calls into a SINGLE toolCalls array in ONE turn. NEVER search one exercise per turn — searching across many turns wastes the turn budget and can fail the whole request.",
        "STEP 2: Read the JSON results. If an exact name match isn't found, use your best judgment to pick the closest logical match (e.g., select 'sit-up v. 2' if the user asks for 'sit ups'). Do NOT search again if a reasonable match exists.",
        "STEP 3: Extract the id of each chosen exercise and call the appropriate mutation tool from YOUR allowed tool list (e.g. add_to_todays_workout, modify_plan_permanently, swap_session_exercise, generate_draft_plan). Place each extracted ID in the field the tool's arg signature requires, alongside any other required parameters like userId.",
        "Do NOT output summaries like '[Found X exercises]' after a search. When search_exercises returns a JSON array, you must immediately read the JSON, extract the exact IDs of the best matches, and seamlessly invoke your mutation tool in the same reasoning step without talking to the user first.",
        "HOWEVER, once a mutation tool returns a success confirmation, your task is complete. You MUST then output a final, friendly conversational response to the user confirming what changed, and you MUST STOP calling tools.",
    ].join("\n");
}

export function buildDynamicAgentContext(state: GraphStateType): string {
    // "Today" in the USER's timezone, not the server's (server runs UTC — an
    // evening user in the Americas is otherwise told it's tomorrow, and every
    // targetDay/date the model passes to tools lands on the wrong day).
    const tz = state.userTimezone || "UTC";
    let dateString: string;
    let dayOfWeek: string;
    try {
        dateString = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());
        dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
            .format(new Date())
            .toLowerCase();
    } catch {
        dateString = new Date().toISOString().split("T")[0];
        dayOfWeek = new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    }

    // Turn-scoped guidance that must NEVER be persisted into thread history
    // (a stored "DO NOT build another workout" note deadlocked every later
    // "add X to it" request). These blocks are rebuilt fresh each turn from
    // per-request state, so they vanish once the turn ends.
    //
    // 1. Validation retry: the previous build was NOT delivered — rebuild.
    // 2. Validation give-up (mutations locked + error): apologize, no tools.
    // 3. Mutation success (mutations locked, no error): recap only, no tools.
    const hasValidationError = Boolean(state.error) && (state.retryCount ?? 0) > 0;
    const validationFailureBlock = hasValidationError
        ? state.turnMutationDone === true
            ? [
                  "",
                  `⚠️ BUILD FAILED after ${state.retryCount} attempts: ${state.error}`,
                  "The workout/plan was NOT delivered. Do NOT call any more tools this turn. Set shouldCallTool:false and briefly apologize that you couldn't finish the build, suggesting one tweak (different equipment, focus, or duration) the user could try.",
              ]
            : [
                  "",
                  `⚠️ VALIDATION FAILURE (attempt ${state.retryCount}): ${state.error}`,
                  "The workout/plan you built was NOT delivered to the user. Rebuild it now by calling the appropriate tool again with valid library exercises.",
              ]
        : [];
    const mutationDoneBlock =
        !hasValidationError && state.turnMutationDone === true
            ? [
                  "",
                  "✅ A change was ALREADY APPLIED successfully in this turn (see the latest bracketed note in the conversation).",
                  "Do NOT call any more tools now. Set shouldCallTool:false and write a short 2-3 sentence coach recap in responseToUser: WHAT changed and WHY it fits the user's goals or constraints.",
              ]
            : [];

    return [
        "[USER CONTEXT AND CONSTRAINTS]",
        state.userContext?.trim() || "(none)",
        "[END USER CONTEXT]",
        "You must strictly abide by the user's physical constraints, injuries, and preferences listed above.",
        "",
        "USER CONTEXT:",
        summarizeUserContext(state),
        `conversation_id: ${state.conversationId ?? "default"}`,
        "(When a tool requires conversation_id, pass this exact value.)",
        "",
        "ACTIVE PLAN (week at a glance; TODAY's session expanded):",
        summarizePlan(state, dayOfWeek),
        state.currentPlan?.id ? `plan_id: ${state.currentPlan.id}` : "plan_id: (none)",
        "(When swap_permanent_exercise / approve_and_publish_plan need plan_id, use this exact value.)",
        ...validationFailureBlock,
        ...mutationDoneBlock,
        "",
        `Context: Today's date is ${dateString} and the day of the week is ${dayOfWeek}. Use this exact day string if a tool requires a targetDay or date.`,
        "(The user's latest message is the final message of the conversation below.)",
    ].join("\n");
}

/**
 * Backward-compat shim — some callers/tests may still import the original
 * `buildAgentSystemPrompt`. Keep behavior identical for them by concatenating
 * the two halves.
 */
export function buildAgentSystemPrompt(def: AgentDefinition, state: GraphStateType): string {
    return `${buildStaticAgentPrompt(def)}\n\n${buildDynamicAgentContext(state)}`;
}

/** Hard wall on a single LLM decision so a stuck network doesn't hang chat. */
const AGENT_LLM_TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 45_000);

/**
 * Max agent (planner/editor/analyst) decision invocations per user request.
 *
 * The master graph routes `agent -> execute_tools -> agent` on every read-only
 * tool call (search_exercises, draft staging, get_active_user_context). The
 * duplicate-mutation guard only blocks repeat MUTATIONS, so a model that keeps
 * searching without converging would loop until LangGraph's recursionLimit
 * throws. A normal flow (batched search -> mutate -> recap) is ~3 turns; even
 * with a validation retry it's ~5, so 8 gives generous headroom while still
 * guaranteeing the graph terminates with a clean reply instead of a crash.
 */
const AGENT_STEP_BUDGET = Number(process.env.AGENT_STEP_BUDGET ?? 8);

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

/**
 * Single LLM call shared by every specialized agent. Returns a state delta in
 * the exact shape the rest of the graph already expects.
 *
 * Cost shape:
 *  - Static system prompt (role + guardrails + tools + contract) is marked
 *    cacheable. Steady-state reads hit the Anthropic cache at ~10% of full
 *    input cost.
 *  - Dynamic per-turn context (user profile, plan, latest message, date) is a
 *    separate uncached system message.
 *  - Conversation history is truncated to a sliding window with a rolling
 *    summary so prompts don't grow unbounded over long threads.
 */
export async function runAgentDecision(
    def: AgentDefinition,
    state: GraphStateType
): Promise<Partial<GraphStateType>> {
    const role = agentRoleFor(def.agent);
    // Mini-first: simple turns (per the supervisor's classification) run the
    // small model; validation retries always escalate back to the full model
    // so a failed build is never retried on the cheaper brain.
    const escalated = (state.retryCount ?? 0) > 0;
    const decisionModel = resolveDecisionModel(role, state.modelComplexity, escalated);
    const llm = getAgentModel(role, { temperature: def.temperature, model: decisionModel });
    console.log(`[${def.agent}] decision model: ${decisionModel} (complexity=${state.modelComplexity ?? "unclassified"}, escalated=${escalated})`);
    const staticPrompt = buildStaticAgentPrompt(def);

    // Deterministic loop guard. Once the per-request step budget is spent, stop
    // calling the LLM entirely and return a clean closing reply — the graph
    // routes a non-tool turn straight to memory -> END, so this can never reach
    // the recursionLimit. Honors any reply the agent already produced.
    const turnNumber = (state.agentTurns ?? 0) + 1;
    if (turnNumber > AGENT_STEP_BUDGET) {
        console.warn(
            `[${def.agent}] step budget (${AGENT_STEP_BUDGET}) exhausted on turn ${turnNumber} — forcing a closing reply`
        );
        const fallback =
            (state.responseToUser ?? "").trim() ||
            "That turned into more steps than I can do in one message. Tell me the single most important change you want and I'll make it right now.";
        return {
            activeAgent: def.agent,
            lastAgent: def.agent,
            agentTurns: turnNumber,
            shouldCallTool: false,
            toolCalls: [],
            responseToUser: fallback,
            completed: true,
            messages: [new AIMessage(fallback)],
            toolFailureNotices: null,
            suggestedReplies: null,
        };
    }

    let dynamicContext = buildDynamicAgentContext(state);
    // On the final budgeted turn, tell the agent it has one move left: make the
    // change now or reply — no more searching. This converts a would-be runaway
    // into a useful last action instead of a generic timeout message.
    if (turnNumber >= AGENT_STEP_BUDGET) {
        dynamicContext +=
            "\n\nFINAL TURN: You have used your tool budget for this request. Do NOT call read-only tools (e.g. search_exercises) again. Either apply ONE final change with a mutation tool now, or reply to the user in plain text. No more tools will run after this turn.";
    }
    // Tight window: history is uncached input tokens on every call. The
    // rolling summary keeps older context available; the checkpoint
    // compaction in the memory node bounds the stored thread separately.
    const truncated = summarizedTruncate(state.messages, { keepRecent: 8, hardCap: 14 });

    try {
        let structured = llm.withStructuredOutput(decisionJsonSchema, {
            name: `${def.agent}_decision`,
        });
        const invokeDecision = (label: string) =>
            withTimeout(
                structured.invoke([
                    cacheableSystemMessage(staticPrompt),
                    dynamicSystemMessage(dynamicContext),
                    ...truncated,
                ]),
                AGENT_LLM_TIMEOUT_MS,
                label
            ) as Promise<AgentDecision>;

        // Transient provider failures (truncated/malformed structured output,
        // network blips) are NOT the user's fault — retry once before the
        // catch below gives up. Without this, one flaky call became a
        // user-facing "could you rephrase?" even though rephrasing can't fix it.
        let decision: AgentDecision;
        try {
            decision = await invokeDecision(`${def.agent} decision`);
        } catch (firstErr) {
            console.warn(`[${def.agent}] decision call failed once, retrying:`, firstErr);
            try {
                decision = await invokeDecision(`${def.agent} decision (retry)`);
            } catch (retryErr) {
                // Cross-provider failover (env-gated): when the primary provider
                // is down, one final attempt on CHAT_FALLBACK_MODEL (e.g. a
                // claude-* model with ANTHROPIC_API_KEY set) keeps chat alive
                // instead of surfacing the honest-failure copy. `structured` is
                // reassigned so any corrective retries below also use the
                // fallback model for the rest of this decision.
                const fallbackModel = process.env.CHAT_FALLBACK_MODEL?.trim();
                if (!fallbackModel || fallbackModel === decisionModel) throw retryErr;
                console.warn(
                    `[${def.agent}] primary model failed twice — failing over to ${fallbackModel}`
                );
                const fallbackLlm = getAgentModel(role, {
                    temperature: def.temperature,
                    model: fallbackModel,
                });
                structured = fallbackLlm.withStructuredOutput(decisionJsonSchema, {
                    name: `${def.agent}_decision`,
                });
                decision = await invokeDecision(`${def.agent} decision (fallback model)`);
            }
        }

        let toolCalls = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];

        // Recover from a known structured-output failure: the model sets
        // shouldCallTool=true but emits an EMPTY toolCalls array (Anthropic
        // tool-use can drop the array — the same issue that forced planner_batch
        // onto GPT). Left unhandled, this completes the turn with no tool AND an
        // empty responseToUser ("silent tool turn") → the user sees nothing.
        // Retry once with a corrective nudge to actually emit the call.
        if (decision.shouldCallTool && toolCalls.length === 0) {
            console.warn(`[${def.agent}] shouldCallTool=true with empty toolCalls — retrying once`);
            decision = (await withTimeout(
                structured.invoke([
                    cacheableSystemMessage(staticPrompt),
                    dynamicSystemMessage(dynamicContext),
                    ...truncated,
                    dynamicSystemMessage(
                        "Your previous reply set shouldCallTool=true but left toolCalls EMPTY, which produces a blank turn. " +
                            "Now either (a) emit toolCalls with at least one tool from the allowed list, or " +
                            "(b) set shouldCallTool=false and put a complete reply in responseToUser. Never return an empty turn."
                    ),
                ]),
                AGENT_LLM_TIMEOUT_MS,
                `${def.agent} decision retry`
            )) as AgentDecision;
            toolCalls = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
        }

        const allowedNames = new Set(def.tools.map((t) => t.name));

        // Deterministic duplicate-mutation guard (see filterAgentToolCalls):
        // makes duplicate workouts / double-applied edits impossible without
        // relying on the model obeying a prompt rule.
        const mutationLocked = state.turnMutationDone === true;
        let filterResult = filterAgentToolCalls(toolCalls, allowedNames, mutationLocked);

        // The model tried to call tools that don't exist in its registry and
        // nothing survived the filter. Silently proceeding here produced the
        // canned "give me more detail" fallback even for perfectly clear
        // requests — instead, retry once telling the model exactly which
        // names were invalid and what it may actually use.
        if (
            decision.shouldCallTool &&
            filterResult.kept.length === 0 &&
            filterResult.droppedUnknownToolNames.length > 0
        ) {
            console.warn(
                `[${def.agent}] unknown tool name(s) ${filterResult.droppedUnknownToolNames.join(", ")} — corrective retry`
            );
            decision = (await withTimeout(
                structured.invoke([
                    cacheableSystemMessage(staticPrompt),
                    dynamicSystemMessage(dynamicContext),
                    ...truncated,
                    dynamicSystemMessage(
                        `Your previous reply called tool(s) that do not exist: ${filterResult.droppedUnknownToolNames.join(", ")}. ` +
                            `The ONLY tools available to you are: ${[...allowedNames].join(", ")}. ` +
                            "Either accomplish the user's request with those tools (e.g. search_exercises first, then the appropriate mutation tool), " +
                            "or set shouldCallTool:false and tell the user in responseToUser what you CAN do for them instead. Never return an empty turn."
                    ),
                ]),
                AGENT_LLM_TIMEOUT_MS,
                `${def.agent} decision (unknown-tool retry)`
            )) as AgentDecision;
            toolCalls = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
            filterResult = filterAgentToolCalls(toolCalls, allowedNames, mutationLocked);
        }

        const { kept: filteredToolCalls, droppedMutation, droppedToolNames } = filterResult;
        if (filteredToolCalls.length !== toolCalls.length) {
            console.warn(
                `[${def.agent}] suppressed ${toolCalls.length - filteredToolCalls.length} tool call(s) (mutationLocked=${mutationLocked})`
            );
        }
        const shouldCallTool = decision.shouldCallTool && filteredToolCalls.length > 0;

        // If we suppressed the model's intended mutation, force a recap so the
        // user always gets a closing message instead of dead air. Be honest:
        // the suppressed action did NOT run — never claim it did. (Distinct
        // multi-part requests now execute in one turn; this path only fires
        // for post-success re-mutations and duplicate builders/echoes.)
        let messageText = decision.responseToUser ?? "";
        if (!shouldCallTool && droppedMutation && messageText.trim().length === 0) {
            console.warn(
                `[${def.agent}] suppressed mutation(s) with no recap text: ${droppedToolNames.join(", ")}`
            );
            messageText = mutationLocked
                ? "That change is applied. If there was a second part to your message, send it on its own and I'll handle it now."
                : "I've kept that to one build so you don't end up with duplicates — tell me the other change and I'll apply it right away.";
        }
        // Final safety net: a non-tool turn must never be silent. If the model
        // produced no tool call AND no text, own the failure honestly — never
        // imply the user's message was too vague (it usually wasn't; this path
        // is an internal miss, and retrying the same message is the right move).
        if (!shouldCallTool && messageText.trim().length === 0) {
            console.warn(`[${def.agent}] empty non-tool turn — using fallback prompt`);
            messageText =
                "Sorry — I fumbled that one on my end. Your message was clear; send it once more and I'll take care of it right away.";
        }
        const preamble = shouldCallTool ? (decision.preamble ?? "").trim() : "";

        // Follow-up chips only make sense on a final text turn with a real
        // reply from the model (never alongside the internal fallback copy).
        const suggestedReplies =
            !shouldCallTool && (decision.responseToUser ?? "").trim().length > 0
                ? (Array.isArray(decision.suggestedReplies) ? decision.suggestedReplies : [])
                      .map((s) => String(s ?? "").trim())
                      .filter((s) => s.length > 0 && s.length <= 60)
                      .slice(0, 3)
                : [];

        const messages = messageText.length > 0 ? [new AIMessage(messageText)] : [];

        return {
            activeAgent: def.agent,
            lastAgent: def.agent,
            agentTurns: turnNumber,
            messages,
            shouldCallTool,
            toolCalls: filteredToolCalls,
            responseToUser: messageText,
            preamble: preamble.length > 0 ? preamble : null,
            completed: !shouldCallTool,
            toolFailureNotices: null,
            suggestedReplies: suggestedReplies.length > 0 ? suggestedReplies : null,
        };
    } catch (err) {
        console.error(`[${def.agent}] decision failed after retry:`, err);
        // Honest failure copy: this is OUR infra failing, not the user's
        // phrasing. Never ask them to rephrase — retrying the same message is
        // exactly the right move, so say that.
        const isTimeout = err instanceof Error && /timed out/i.test(err.message);
        const fallbackCopy = isTimeout
            ? "Sorry — that took longer than it should have on my end. Your message was fine; send it again and I'll pick it right up."
            : "Sorry — I hit a hiccup on my side processing that. Nothing wrong with your message; send it again and I'll take care of it.";
        return {
            activeAgent: def.agent,
            lastAgent: def.agent,
            agentTurns: turnNumber,
            error: `Failed to process: ${err instanceof Error ? err.message : String(err)}`,
            responseToUser: fallbackCopy,
            shouldCallTool: false,
            toolCalls: [],
            completed: false,
            toolFailureNotices: null,
            suggestedReplies: null,
        };
    }
}
