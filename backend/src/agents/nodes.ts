/**
 * Shared graph nodes: tool execution + validator.
 *
 * (The legacy single-agent `conversationalTrainerNode` that used to live here
 * was removed — the supervisor multi-agent graph in ./supervisorGraph is the
 * only chat runtime. Agent decisions live in ./agentRuntime + the subgraphs.)
 */

import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
    CORE_MUTATION_TOOLS,
    DETERMINISTIC_RECAP_TOOLS,
    READ_ONLY_TOOLS,
    GraphStateType,
} from "./state";
import {
    addToTodaysWorkoutTool,
    createOneOffWorkoutTool,
    createTemporaryOverrideTool,
    getActiveUserContextTool,
    logWorkoutCompletionTool,
    modifyPlanPermanentlyTool,
    mutateUserMemoryTool,
    parseNutritionStringTool,
    searchExercisesTool,
    toolByName,
} from "./tools";

function sanitizeToolErrorForUi(f: {
    toolName: string;
    error?: string;
    result?: { success?: boolean; error?: unknown };
}): string {
    const raw =
        (f.error ? String(f.error) : "") ||
        (f.result && typeof f.result === "object" && f.result !== null && "error" in f.result
            ? String((f.result as { error?: unknown }).error ?? "")
            : "") ||
        "Something went wrong while running that action.";
    const cleaned = raw
        .replace(/\r?\n[\s\S]*/g, " ")
        .replace(/at\s+[\w.$/\\-]+\s*\([^)]*\)/gi, "")
        .trim();
    const out = cleaned.length > 220 ? `${cleaned.slice(0, 217)}…` : cleaned;
    return out || "Something went wrong while running that action.";
}

// ============================================================================
// TOOL EXECUTION NODE
// ============================================================================

export async function toolExecutionNode(
    state: GraphStateType
): Promise<Partial<GraphStateType>> {
    console.log(`Executing ${state.toolCalls?.length || 0} tools`);

    if (!state.toolCalls || state.toolCalls.length === 0) {
        return {
            shouldCallTool: false,
            completed: true,
        };
    }

    // Tool map (NO create_workout_plan - that's onboarding only!)
    //
    // Legacy explicit bindings remain so any historical refactor never breaks.
    // We then layer on the canonical `toolByName` registry from `tools.ts`,
    // which now also includes the new DynamicStructuredTool registry entries
    // (planner / editor / analyst / memory action tools). `toolByName` wins
    // for shared keys so the new strict-schema implementations are preferred.
    const toolMap: Record<string, any> = {
        search_exercises: searchExercisesTool,
        add_to_todays_workout: addToTodaysWorkoutTool,
        create_one_off_workout: createOneOffWorkoutTool,
        create_temporary_override: createTemporaryOverrideTool,
        modify_plan_permanently: modifyPlanPermanentlyTool,
        get_active_user_context: getActiveUserContextTool,
        log_workout_completion: logWorkoutCompletionTool,
        mutate_user_memory: mutateUserMemoryTool,
        parse_nutrition_string: parseNutritionStringTool,
        ...toolByName,
    };

    interface ToolExecResult {
        toolName: string;
        result?: any;
        error?: string;
        success: boolean;
        errorType?: "tool_input_parsing" | "tool_runtime";
    }

    const executeOne = async (toolCall: { toolName: string; args?: unknown }): Promise<ToolExecResult> => {
        const tool = toolMap[toolCall.toolName];
        if (!tool) {
            console.warn(`Unknown tool: ${toolCall.toolName}`);
            return { toolName: toolCall.toolName, error: "Unknown tool", success: false };
        }

        console.log(`  Executing: ${toolCall.toolName}`);
        console.log(`  Args:`, JSON.stringify(toolCall.args, null, 2));

        // If the LLM passes { input: '{"raw_text":"..."}' } instead of
        // { raw_text: "..." }, parse the stringified value so the tool
        // receives the correct schema shape and raw_text is never undefined.
        let invokeArgs = toolCall.args as Record<string, unknown>;
        // Deterministic injury safety: search_exercises filters results against
        // the user's STORED injuries when it knows the user. Inject the id from
        // graph state so that filter never depends on the model remembering to
        // pass avoidBodyParts.
        if (toolCall.toolName === "search_exercises" && state.userId) {
            invokeArgs = { ...(invokeArgs ?? {}), userId: (invokeArgs as any)?.userId ?? state.userId };
        }
        if (toolCall.toolName === "parse_nutrition_string") {
            if (!invokeArgs.raw_text && typeof invokeArgs.input === "string") {
                try {
                    const inner = JSON.parse(invokeArgs.input) as Record<string, unknown>;
                    invokeArgs = { raw_text: inner.raw_text ?? invokeArgs.input };
                } catch {
                    invokeArgs = { raw_text: invokeArgs.input };
                }
            }
        }

        try {
            const result = await tool.invoke(invokeArgs);
            console.log(`  ${toolCall.toolName} completed (${result.success !== false ? 'ok' : 'failed'})`);
            return {
                toolName: toolCall.toolName,
                result,
                success: result.success !== false,
            };
        } catch (error) {
            console.error(`  ${toolCall.toolName} failed:`, error);
            const raw = String(error);
            const isParsingError =
                raw.includes("ToolInputParsingException") ||
                raw.includes("did not match expected schema") ||
                raw.includes("Received tool input did not match expected schema");
            return {
                toolName: toolCall.toolName,
                error: raw,
                success: false,
                errorType: isParsingError ? "tool_input_parsing" : "tool_runtime",
            };
        }
    };

    // Read-only tools run concurrently (the analyst's first turn fans out
    // several reads); mutations run serially in decision order. Results are
    // reassembled in the original call order so downstream context messages
    // keep a stable sequence.
    const calls = state.toolCalls as { toolName: string; args?: unknown }[];
    const toolResults: ToolExecResult[] = new Array(calls.length);
    const readIndexes: number[] = [];
    const mutationIndexes: number[] = [];
    calls.forEach((c, i) =>
        (READ_ONLY_TOOLS.has(c?.toolName) ? readIndexes : mutationIndexes).push(i)
    );
    await Promise.all(
        readIndexes.map(async (i) => {
            toolResults[i] = await executeOne(calls[i]);
        })
    );
    for (const i of mutationIndexes) {
        toolResults[i] = await executeOne(calls[i]);
    }

    const successfulTools = toolResults.filter(r => r.success);
    const failedTools = toolResults.filter(r => !r.success);

    console.log(`Tool results: ${successfulTools.length} succeeded, ${failedTools.length} failed`);

    const sseFailures = failedTools.filter((f) => f.toolName !== "create_one_off_workout");

    let updates: Partial<GraphStateType> = {
        shouldCallTool: false,
        toolCalls: [],
        completed: false, // Don't complete yet - let trainer explain
        toolFailureNotices: sseFailures.length
            ? sseFailures.map((f) => ({
                  toolName: f.toolName,
                  message: sanitizeToolErrorForUi(f),
              }))
            : null,
    };

    const contextMessages: string[] = [];

    for (const tool of successfulTools) {
        if (tool.toolName === "create_temporary_override") {
            contextMessages.push(`[Workout override created successfully: ${tool.result.message}]`);
        } else if (tool.toolName === "modify_plan_permanently") {
            // If the result carries rebuilt days it must pass the validator
            // first — the validator appends the success note in that case.
            if (!(Array.isArray(tool.result?.days) && tool.result.days.length > 0)) {
                contextMessages.push(`[Plan modified permanently: ${tool.result.message}]`);
            }
        } else if (tool.toolName === "search_exercises") {
            if (typeof tool.result === "string") {
                contextMessages.push(tool.result);
            } else if (tool.result && typeof tool.result === "object" && "exercises" in tool.result) {
                contextMessages.push(
                    JSON.stringify((tool.result as { exercises?: unknown[] }).exercises ?? [], null, 2)
                );
            } else {
                contextMessages.push(JSON.stringify(tool.result ?? [], null, 2));
            }
        } else if (
            tool.toolName === "create_one_off_workout" ||
            tool.toolName === "extend_one_off_workout"
        ) {
            // No success note yet: the build still has to pass the validator.
            // The validator writes the delivery note on success (and the
            // rebuild instruction lives in the per-turn dynamic context), so
            // the next agent turn never sees a success claim for an
            // undelivered workout.
        } else if (tool.toolName === "add_to_todays_workout") {
            contextMessages.push(`[Added ${tool.result.addedExercises?.length || 0} exercises to today's workout]`);
        } else if (tool.toolName === "swap_session_exercise") {
            contextMessages.push(`[Session exercise swapped successfully: ${tool.result.message}]`);
        } else if (tool.toolName === "swap_permanent_exercise") {
            contextMessages.push(`[Permanent swap applied: ${tool.result.message}]`);
        } else if (tool.toolName === "shift_workout_schedule") {
            contextMessages.push(`[Workout schedule shifted: ${tool.result.message}]`);
        } else if (tool.toolName === "mutate_user_memory") {
            contextMessages.push(`[Profile memory updated: ${tool.result.message}]`);
        }
    }

    for (const f of failedTools) {
        if (f.toolName === "create_one_off_workout") {
            continue;
        }
        contextMessages.push(`[${f.toolName} failed: ${sanitizeToolErrorForUi(f)}]`);
    }

    const parsingFailure = failedTools.find((f) => (f as any).errorType === "tool_input_parsing");
    if (parsingFailure) {
        contextMessages.push(
            `[Tool failed: ${sanitizeToolErrorForUi(parsingFailure)}. Please inform the user or try again with different parameters.]`
        );
    }

    const workoutToolFailed = failedTools.some((f) => f.toolName === "create_one_off_workout");
    const graphMessages: (AIMessage | SystemMessage)[] = [];
    if (contextMessages.length > 0) {
        graphMessages.push(new AIMessage(contextMessages.join(" ")));
    }
    if (workoutToolFailed) {
        graphMessages.push(
            new SystemMessage(
                "create_one_off_workout could not build a workout from the exercise library for the user's constraints. You MUST set responseToUser to a non-empty, warm 2–4 sentence message. Explain that this exact combo isn't available in the library, suggest realistic alternatives (e.g. dumbbells, body weight, or a narrower focus like upper or lower body), and invite them to retry. Do NOT mention tool names, error codes, stack traces, or raw system messages. Do NOT fabricate exercise names or a full workout in chat—the modal is only for successful tool builds."
            )
        );
    }
    if (graphMessages.length > 0) {
        updates.messages = graphMessages;
    }

    if (parsingFailure) {
        graphMessages.push(
            new SystemMessage(
                "A tool call failed due to input schema mismatch. Do NOT retry the exact same tool call arguments. Either ask one concise clarification question, or call the same tool with corrected parameters."
            )
        );
        updates.messages = graphMessages;
        updates.shouldCallTool = false;
        updates.toolCalls = [];
    }

    // Handle workout creation/extension — both deliver a validatable workout
    // artifact (the extended card re-emits through the same validator path).
    const oneOffWorkout = successfulTools.find(
        (r) => r.toolName === "create_one_off_workout" || r.toolName === "extend_one_off_workout"
    );
    if (oneOffWorkout?.success && oneOffWorkout.result.workout) {
        updates.workout = oneOffWorkout.result.workout;
    }

    // Handle plan modifications
    const planModified = successfulTools.find(r => r.toolName === "modify_plan_permanently");
    if (planModified?.success) {
        updates.planUpdate = planModified.result;
    }

    if (successfulTools.length === 0 && failedTools.length > 0) {
        updates.error = "Tool execution failed";
    }

    const hasCoreMutationSuccess = successfulTools.some((t) =>
        CORE_MUTATION_TOOLS.has(String(t.toolName))
    );
    // Keep one post-tool recap turn: do NOT hard-stop on success.
    // The active agent should get one more invocation to explain what changed.
    if (hasCoreMutationSuccess) {
        updates.shouldCallTool = false;
        updates.toolCalls = [];

        // Deterministic duplicate guard: lock further mutations for the rest of
        // this turn. Workout/plan builders that still need validation are NOT
        // locked here — the validator sets the lock on success so a failed
        // validation can still retry the build (bounded by retryCount).
        const producesValidatable = Boolean(updates.workout || updates.planUpdate);
        if (!producesValidatable) {
            updates.turnMutationDone = true;
        }
    }

    // Cost short-circuit: when EVERY call this turn succeeded and is a simple
    // self-describing mutation (meal/weight/set logging, schedule shift), the
    // tool's own `message` IS the recap — skip the second LLM round-trip
    // entirely. The graph routes straight to memory (see routeAfterTools) and
    // the SSE emitter streams `responseToUser` from this node's output.
    const allDeterministic =
        successfulTools.length > 0 &&
        failedTools.length === 0 &&
        !updates.workout &&
        !updates.planUpdate &&
        successfulTools.every((t) => DETERMINISTIC_RECAP_TOOLS.has(String(t.toolName)));
    if (allDeterministic) {
        const recap = buildDeterministicRecap(successfulTools);
        updates.completed = true;
        updates.turnMutationDone = true;
        updates.responseToUser = recap;
        updates.messages = [...(updates.messages ?? []), new AIMessage(recap)];
    }

    return updates;
}

/** Fallback lines for deterministic-recap tools whose result lacks `message`. */
const RECAP_FALLBACKS: Record<string, string> = {
    log_nutrition_entry: "Meal logged.",
    edit_nutrition_entry: "Log updated.",
    delete_nutrition_entry: "Log deleted.",
    log_body_weight: "Weight logged.",
    log_exercise_set: "Set logged.",
    set_daily_macro_goals: "Daily targets updated.",
    shift_workout_schedule: "Schedule shifted.",
    swap_session_exercise: "Exercise swapped for today's session.",
    add_to_todays_workout: "Workout updated.",
};

function buildDeterministicRecap(
    successfulTools: { toolName: string; result?: { message?: unknown } }[]
): string {
    const lines = successfulTools.map((t) => {
        const msg = typeof t.result?.message === "string" ? t.result.message.trim() : "";
        return msg || RECAP_FALLBACKS[t.toolName] || "Done.";
    });
    return lines.join(" ");
}

// ============================================================================
// VALIDATOR NODE
// ============================================================================

// Two attempts is enough: each retry costs a full rebuild (agent decision +
// tool + validation). Failures past the second attempt are almost always a
// library-coverage problem a third identical attempt won't fix.
export const MAX_VALIDATION_RETRIES = 2;

export async function validatorNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
    console.log("Validator node active");

    const hasWorkout = state.workout && state.workout.exercises && state.workout.exercises.length > 0;
    const hasPlan = state.planUpdate && state.planUpdate.days && state.planUpdate.days.length > 0;

    if (!hasWorkout && !hasPlan) {
        console.warn("Validator: Nothing to validate");
        return {
            completed: true,
            error: null,
            turnMutationDone: true,
        };
    }

    // The validator owns the failure/give-up coaching of the next agent turn:
    // execute_tools deliberately does NOT write a success note for validatable
    // builds, so the agent only ever sees "SUCCEEDED" once the artifact has
    // actually been delivered.
    const fail = (error: string): Partial<GraphStateType> => {
        const retryCount = state.retryCount + 1;
        const givenUp = retryCount >= MAX_VALIDATION_RETRIES;
        console.error(`Validation failed (attempt ${retryCount}): ${error}`);
        return {
            error,
            retryCount,
            completed: false,
            // Invalid artifacts must never linger in state — they are not
            // user-deliverable and the SSE emitter keys off validator output.
            workout: null,
            planUpdate: null,
            // On give-up, lock mutations so the closing turn can only apologize.
            ...(givenUp ? { turnMutationDone: true } : {}),
            // Factual note only — the imperative guidance (rebuild now /
            // apologize and stop) is injected per-turn via the dynamic agent
            // context (see buildDynamicAgentContext), so a stale instruction
            // never poisons later turns in the checkpointed history.
            messages: [
                new AIMessage(
                    givenUp
                        ? `[Workout build failed validation ${retryCount} times (${error}). Nothing was delivered to the user.]`
                        : `[Workout build attempt ${retryCount} failed validation (${error}). Not delivered yet.]`
                ),
            ],
        };
    };

    if (hasWorkout) {
        const hasValidExercises = state.workout.exercises.every(
            (ex: any) => ex.id && ex.gif_path && ex.gif_path !== ''
        );
        if (!hasValidExercises) {
            return fail("Generated workout has exercises missing id or gif_path");
        }
        console.log(`Workout valid: ${state.workout.exercises.length} exercises`);
    }

    if (hasPlan) {
        for (const day of state.planUpdate.days) {
            const hasValidExercises = day.exercises?.every(
                (ex: any) => ex.id && ex.gif_path && ex.gif_path !== ''
            );
            if (!hasValidExercises) {
                return fail(`Plan has invalid exercises on ${day.dayOfWeek}`);
            }
        }
        console.log(`Plan valid: ${state.planUpdate.days.length} days`);
    }

    // Validation passed. Write the success note the recap turn keys off, echo
    // the validated artifacts (the SSE emitter delivers workout/plan from THIS
    // node's output, never from execute_tools), and lock further mutations for
    // the rest of the turn so the recap can't rebuild.
    // Factual delivery notes only. The "do not rebuild — write a recap"
    // instruction is injected per-turn via the dynamic agent context (keyed on
    // turnMutationDone), NOT stored here: a persisted "DO NOT build another
    // workout" in history deadlocked every later "add X to it" request.
    const successNotes: string[] = [];
    if (hasWorkout) {
        const focus = state.workout?.focus ? `"${state.workout.focus}" ` : "";
        const count = state.workout?.exercises?.length ?? 0;
        successNotes.push(
            `[Built and delivered ${focus}(${count} exercises) to the user as a workout card.]`
        );
    }
    if (hasPlan) {
        const note = typeof state.planUpdate?.message === "string" ? `: ${state.planUpdate.message}` : "";
        successNotes.push(`[Plan update validated and applied${note}.]`);
    }

    return {
        completed: true,
        error: null,
        turnMutationDone: true,
        ...(hasWorkout ? { workout: state.workout } : {}),
        ...(hasPlan ? { planUpdate: state.planUpdate } : {}),
        messages: [new AIMessage(successNotes.join(" "))],
    };
}
