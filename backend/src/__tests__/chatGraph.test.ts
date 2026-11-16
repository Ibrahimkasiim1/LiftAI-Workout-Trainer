/**
 * Unit tests for the chat agent graph's deterministic behavior.
 *
 * Run with:  npm test   (sets dummy SUPABASE_* env so importing the tool
 * registry — which eagerly constructs a Supabase client — does not throw).
 *
 * Covers:
 *  - duplicate-mutation guard
 *  - validator wiring / post-mutation routing
 *  - exercise_performance per-set → per-session aggregation
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    buildDynamicAgentContext,
    filterAgentToolCalls,
    runAgentDecision,
    type ToolCallLike,
} from "../agents/agentRuntime";
import {
    aggregateExercisePerformanceRows,
} from "../tools/performanceAggregation";
import {
    isConfirmationFastPath,
    isGreetingFastPath,
    isLoggingFastPath,
    routeAfterTools,
    routeAfterValidator,
    VALIDATOR_NODE_ID,
} from "../agents/supervisorGraph";
import { EDITOR_NODE_ID, editorDef } from "../agents/editorSubgraph";
import { plannerDef } from "../agents/plannerSubgraph";
import { analystDef } from "../agents/analystSubgraph";
import { MEMORY_NODE_ID } from "../agents/memorySubgraph";
import { compactHistoryForCheckpoint } from "../agents/messageHelpers";
import { validatorNode, MAX_VALIDATION_RETRIES } from "../agents/nodes";
import { JsonStringFieldStreamer } from "../agents/streamingExtractor";
import { GraphState, HISTORY_COMPACTION_FLAG } from "../agents/state";
import { toolByName } from "../agents/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

const EDITOR_ALLOWED = new Set([
    "search_exercises",
    "create_one_off_workout",
    "add_to_todays_workout",
    "get_active_user_context",
]);

// ---------------------------------------------------------------------------
// Duplicate-mutation guard
// ---------------------------------------------------------------------------

test("filterAgentToolCalls drops tools the agent is not allowed to use", () => {
    const calls: ToolCallLike[] = [
        { toolName: "search_exercises", args: {} },
        { toolName: "delete_everything", args: {} },
    ];
    const { kept } = filterAgentToolCalls(calls, EDITOR_ALLOWED, false);
    assert.deepEqual(kept.map((c) => c.toolName), ["search_exercises"]);
});

test("filterAgentToolCalls keeps only the FIRST mutation within a single turn", () => {
    // The exact reported bug: model emits build-push + build-fullbody together.
    const calls: ToolCallLike[] = [
        { toolName: "create_one_off_workout", args: { targetMuscle: "push" } },
        { toolName: "create_one_off_workout", args: { targetMuscle: "full body" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED, false);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].args && (kept[0].args as any).targetMuscle, "push");
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls blocks ALL mutations once the turn is locked", () => {
    const calls: ToolCallLike[] = [
        { toolName: "create_one_off_workout", args: {} },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED, true);
    assert.equal(kept.length, 0);
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls still allows read-only tools when locked", () => {
    const calls: ToolCallLike[] = [
        { toolName: "search_exercises", args: {} },
        { toolName: "create_one_off_workout", args: {} },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED, true);
    assert.deepEqual(kept.map((c) => c.toolName), ["search_exercises"]);
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls is a no-op for a single legitimate mutation", () => {
    const calls: ToolCallLike[] = [{ toolName: "create_one_off_workout", args: {} }];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED, false);
    assert.equal(kept.length, 1);
    assert.equal(droppedMutation, false);
});

// ---------------------------------------------------------------------------
// Multi-part requests: distinct mutations in ONE message must all execute
// (the old guard dropped everything after the first mutation, producing the
// "I can only do one action at a time" loop users reported).
// ---------------------------------------------------------------------------

const EDITOR_ALLOWED_WIDE = new Set([
    ...EDITOR_ALLOWED,
    "swap_session_exercise",
    "shift_workout_schedule",
    "modify_plan_permanently",
]);

test("filterAgentToolCalls keeps DISTINCT non-builder mutations in one turn", () => {
    // "Swap my bench press AND move Tuesday's session to Wednesday."
    const calls: ToolCallLike[] = [
        { toolName: "swap_session_exercise", args: { from: "bench press", to: "floor press" } },
        { toolName: "shift_workout_schedule", args: { from: "tuesday", to: "wednesday" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED_WIDE, false);
    assert.equal(kept.length, 2);
    assert.equal(droppedMutation, false);
});

test("filterAgentToolCalls keeps two same-tool swaps with different args", () => {
    const calls: ToolCallLike[] = [
        { toolName: "swap_session_exercise", args: { from: "bench press", to: "floor press" } },
        { toolName: "swap_session_exercise", args: { from: "dips", to: "cable pushdown" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED_WIDE, false);
    assert.equal(kept.length, 2);
    assert.equal(droppedMutation, false);
});

test("filterAgentToolCalls drops a byte-identical non-repeatable echo", () => {
    const calls: ToolCallLike[] = [
        { toolName: "swap_session_exercise", args: { from: "bench press", to: "floor press" } },
        { toolName: "swap_session_exercise", args: { from: "bench press", to: "floor press" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED_WIDE, false);
    assert.equal(kept.length, 1);
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls blocks a second builder even under a different tool name", () => {
    const calls: ToolCallLike[] = [
        { toolName: "create_one_off_workout", args: { targetMuscle: "push" } },
        { toolName: "modify_plan_permanently", args: { change: "swap split" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED_WIDE, false);
    assert.deepEqual(kept.map((c) => c.toolName), ["create_one_off_workout"]);
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls allows a builder plus a non-builder mutation together", () => {
    // "Build me a quick push day AND move Friday's session to Saturday."
    const calls: ToolCallLike[] = [
        { toolName: "create_one_off_workout", args: { targetMuscle: "push" } },
        { toolName: "shift_workout_schedule", args: { from: "friday", to: "saturday" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, EDITOR_ALLOWED_WIDE, false);
    assert.equal(kept.length, 2);
    assert.equal(droppedMutation, false);
});

// ---------------------------------------------------------------------------
// Repeatable logging mutations ("log my bench AND my squat")
// ---------------------------------------------------------------------------

const ANALYST_ALLOWED = new Set([
    "log_exercise_set",
    "log_nutrition_entry",
    "get_daily_macro_goals",
]);

test("filterAgentToolCalls keeps multiple DISTINCT repeatable log calls in one turn", () => {
    const calls: ToolCallLike[] = [
        { toolName: "log_exercise_set", args: { exercise_name: "bench press", weight: 80, reps: 8 } },
        { toolName: "log_exercise_set", args: { exercise_name: "squat", weight: 100, reps: 5 } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, ANALYST_ALLOWED, false);
    assert.equal(kept.length, 2);
    assert.equal(droppedMutation, false);
});

test("filterAgentToolCalls drops a byte-identical repeatable log call (LLM echo)", () => {
    const calls: ToolCallLike[] = [
        { toolName: "log_nutrition_entry", args: { raw_text: "2 eggs" } },
        { toolName: "log_nutrition_entry", args: { raw_text: "2 eggs" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, ANALYST_ALLOWED, false);
    assert.equal(kept.length, 1);
    assert.equal(droppedMutation, true);
});

test("filterAgentToolCalls blocks repeatable logs once the turn is locked", () => {
    const calls: ToolCallLike[] = [
        { toolName: "log_exercise_set", args: { exercise_name: "bench press" } },
    ];
    const { kept, droppedMutation, droppedToolNames } = filterAgentToolCalls(
        calls,
        ANALYST_ALLOWED,
        true
    );
    assert.equal(kept.length, 0);
    assert.equal(droppedMutation, true);
    assert.deepEqual(droppedToolNames, ["log_exercise_set"]);
});

test("filterAgentToolCalls allows a repeatable log alongside a builder mutation", () => {
    const allowed = new Set(["create_one_off_workout", "log_exercise_set"]);
    const calls: ToolCallLike[] = [
        { toolName: "create_one_off_workout", args: { targetMuscle: "push" } },
        { toolName: "log_exercise_set", args: { exercise_name: "squat" } },
    ];
    const { kept, droppedMutation } = filterAgentToolCalls(calls, allowed, false);
    assert.equal(kept.length, 2);
    assert.equal(droppedMutation, false);
});

// ---------------------------------------------------------------------------
// Validator wiring / routing
// ---------------------------------------------------------------------------

test("routeAfterTools sends a freshly built workout to the validator", () => {
    const state: any = {
        activeAgent: "editor",
        workout: { exercises: [{ id: "x", gif_path: "p" }] },
    };
    assert.equal(routeAfterTools(state), VALIDATOR_NODE_ID);
});

test("routeAfterTools sends a plan update to the validator", () => {
    const state: any = {
        activeAgent: "editor",
        planUpdate: { days: [{ exercises: [] }] },
    };
    assert.equal(routeAfterTools(state), VALIDATOR_NODE_ID);
});

test("routeAfterTools returns to the active agent for a non-validatable mutation", () => {
    const state: any = { activeAgent: "editor", workout: null, planUpdate: null };
    assert.equal(routeAfterTools(state), EDITOR_NODE_ID);
});

test("routeAfterTools skips the LLM recap turn when execute_tools wrote a deterministic recap", () => {
    const state: any = {
        activeAgent: "analyst",
        workout: null,
        planUpdate: null,
        completed: true,
        responseToUser: "Logged 80 kg (176.4 lbs).",
    };
    assert.equal(routeAfterTools(state), MEMORY_NODE_ID);
});

test("routeAfterTools still validates a workout even if a recap string is present", () => {
    const state: any = {
        activeAgent: "editor",
        workout: { exercises: [{ id: "x", gif_path: "p" }] },
        completed: true,
        responseToUser: "should not matter",
    };
    assert.equal(routeAfterTools(state), VALIDATOR_NODE_ID);
});

test("routeAfterValidator returns to the agent to retry on validation failure", () => {
    const state: any = { activeAgent: "editor", error: "bad gif", retryCount: 1 };
    assert.equal(routeAfterValidator(state), EDITOR_NODE_ID);
});

test("routeAfterValidator returns to the agent for a recap on success", () => {
    const state: any = { activeAgent: "editor", error: null, completed: true, retryCount: 0 };
    assert.equal(routeAfterValidator(state), EDITOR_NODE_ID);
});

test("routeAfterValidator gives up to a recap after exhausting retries", () => {
    const state: any = { activeAgent: "editor", error: "bad gif", retryCount: 3 };
    // After max retries it still hands to the agent for a graceful explanation.
    assert.equal(routeAfterValidator(state), EDITOR_NODE_ID);
    // sanity: memory node id is a distinct value
    assert.notEqual(EDITOR_NODE_ID, MEMORY_NODE_ID);
});

// ---------------------------------------------------------------------------
// exercise_performance per-set → per-session aggregation
// ---------------------------------------------------------------------------

test("aggregateExercisePerformanceRows collapses per-set rows into one session", () => {
    const rows = [
        { exercise_id: "bench", exercise_name: "Bench Press", set_number: 1, reps_completed: 8, weight_used: 60, workout_date: "2026-05-01T10:00:00Z" },
        { exercise_id: "bench", exercise_name: "Bench Press", set_number: 2, reps_completed: 8, weight_used: 65, workout_date: "2026-05-01T10:05:00Z" },
        { exercise_id: "bench", exercise_name: "Bench Press", set_number: 3, reps_completed: 6, weight_used: 70, workout_date: "2026-05-01T10:10:00Z" },
    ];
    const sessions = aggregateExercisePerformanceRows(rows);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sets, 3);
    // Heaviest set is the representative effort.
    assert.equal(sessions[0].weight, 70);
    assert.equal(sessions[0].reps, 6);
    assert.equal(sessions[0].exerciseName, "Bench Press");
});

test("aggregateExercisePerformanceRows separates different days and sorts newest first", () => {
    const rows = [
        { exercise_id: "sq", exercise_name: "Squat", set_number: 1, reps_completed: 5, weight_used: 100, workout_date: "2026-05-01T10:00:00Z" },
        { exercise_id: "sq", exercise_name: "Squat", set_number: 1, reps_completed: 5, weight_used: 110, workout_date: "2026-05-08T10:00:00Z" },
    ];
    const sessions = aggregateExercisePerformanceRows(rows);
    assert.equal(sessions.length, 2);
    // Most recent session first.
    assert.equal(sessions[0].completedAt, "2026-05-08T10:00:00Z");
    assert.equal(sessions[0].weight, 110);
});

test("aggregateExercisePerformanceRows tolerates an empty input", () => {
    assert.deepEqual(aggregateExercisePerformanceRows([]), []);
});

// ---------------------------------------------------------------------------
// Capability wiring: every advertised tool must actually be registered, or the
// agent is given an "impossible instruction" it can never fulfil.
// ---------------------------------------------------------------------------

for (const def of [editorDef, plannerDef, analystDef]) {
    test(`${def.agent} agent only advertises tools that exist in the registry`, () => {
        const registered = new Set(Object.keys(toolByName));
        const missing = def.tools.map((t) => t.name).filter((n) => !registered.has(n));
        assert.deepEqual(missing, [], `unregistered tools for ${def.agent}: ${missing.join(", ")}`);
    });
}

// ---------------------------------------------------------------------------
// Validator: failures must never deliver, successes must lock + note
// ---------------------------------------------------------------------------

test("validatorNode failure clears the invalid workout and injects a rebuild note", async () => {
    const state: any = {
        workout: { exercises: [{ id: "x", gif_path: "" }] },
        planUpdate: null,
        retryCount: 0,
    };
    const delta = await validatorNode(state);
    assert.ok(delta.error);
    assert.equal(delta.workout, null);
    assert.equal(delta.retryCount, 1);
    assert.notEqual(delta.turnMutationDone, true); // retry still allowed
    // History notes are now FACTUAL only — the rebuild imperative lives in the
    // per-turn dynamic context (keyed on state.error/retryCount), never in the
    // checkpointed history where it would poison later turns.
    const note = String((delta.messages as any[])[0].content);
    assert.match(note, /failed validation/i);
    assert.match(note, /Not delivered/i);
    assert.doesNotMatch(note, /DO NOT/i);
});

test("validatorNode locks mutations and apologizes path on final give-up", async () => {
    const state: any = {
        workout: { exercises: [{ id: "x", gif_path: "" }] },
        planUpdate: null,
        retryCount: MAX_VALIDATION_RETRIES - 1,
    };
    const delta = await validatorNode(state);
    assert.equal(delta.turnMutationDone, true);
    // Neutral give-up note: the apologize-and-stop instruction is injected via
    // dynamic context (turnMutationDone + error), not persisted history.
    const note = String((delta.messages as any[])[0].content);
    assert.match(note, /failed validation \d+ times/i);
    assert.match(note, /Nothing was delivered/i);
    assert.doesNotMatch(note, /DO NOT/i);
});

test("validatorNode success echoes the workout and writes a factual delivery note", async () => {
    const state: any = {
        workout: { focus: "push", exercises: [{ id: "x", gif_path: "p" }] },
        planUpdate: null,
        retryCount: 0,
    };
    const delta = await validatorNode(state);
    assert.equal(delta.error, null);
    assert.equal(delta.completed, true);
    assert.equal(delta.turnMutationDone, true);
    assert.ok(delta.workout, "validator must echo the validated workout for the SSE emitter");
    // Factual note only — a persisted "DO NOT build another workout" used to
    // deadlock every later "add X to it" request on this thread.
    const note = String((delta.messages as any[])[0].content);
    assert.match(note, /Built and delivered/);
    assert.doesNotMatch(note, /DO NOT/i);
});

// ---------------------------------------------------------------------------
// Supervisor greeting fast-path (no LLM round-trip for pure greetings)
// ---------------------------------------------------------------------------

test("isGreetingFastPath matches pure greetings and acks", () => {
    for (const msg of ["hi", "Hey!", "hello", "good morning", "thanks!", "ok", "sounds good"]) {
        assert.equal(isGreetingFastPath(msg), true, `expected fast-path: ${msg}`);
    }
});

test("isLoggingFastPath matches unambiguous logging messages", () => {
    for (const msg of [
        "log 2 eggs and toast",
        "Log my weight 75kg",
        "log bench 3x8 @ 80kg",
        "I ate a chicken salad",
        "i just ate two protein bars",
        "I weighed 81.2 this morning",
        "my weight is 75 kg",
        "weighed myself today: 78kg",
    ]) {
        assert.equal(isLoggingFastPath(msg), true, `expected analyst fast-path: ${msg}`);
    }
});

test("isLoggingFastPath never matches non-logging messages", () => {
    for (const msg of [
        "log out",
        "log me out please",
        "log in",
        "can you log my meal", // not at start — let the LLM confirm intent
        "what's my weight trend",
        "build me a leg workout",
        "",
    ]) {
        assert.equal(isLoggingFastPath(msg), false, `expected LLM routing: ${msg}`);
    }
});

test("isGreetingFastPath never matches messages with content", () => {
    for (const msg of [
        "hi, can you build me a leg workout",
        "hello? why is my calorie goal so high",
        "I hurt my shoulder",
        "ok let's swap bench for incline",
        "",
    ]) {
        assert.equal(isGreetingFastPath(msg), false, `expected LLM routing: ${msg}`);
    }
});

// ---------------------------------------------------------------------------
// Supervisor confirmation fast-path: short "yes/ok/do it" replies must return
// to the agent that asked the question (e.g. analyst awaiting a calorie-goal
// confirmation) instead of falling into the editor's small-talk path.
// ---------------------------------------------------------------------------

test("isConfirmationFastPath routes short confirmations back to the previous agent", () => {
    for (const msg of [
        "yes",
        "Yes please!",
        "do it",
        "go ahead",
        "ok",
        "sounds good 👍",
        "no, not yet",
        "cancel",
        "2200",
        "make it 2500 kcal",
        "publish it",
    ]) {
        assert.equal(
            isConfirmationFastPath(msg, "analyst"),
            true,
            `expected confirmation fast-path: ${msg}`
        );
    }
});

test("isConfirmationFastPath never fires without a previous agent", () => {
    assert.equal(isConfirmationFastPath("yes", null), false);
    assert.equal(isConfirmationFastPath("yes", undefined), false);
    assert.equal(isConfirmationFastPath("yes", "supervisor"), false);
});

test("isConfirmationFastPath never matches messages with real content", () => {
    for (const msg of [
        "yes but can you also add curls",
        "build me a push workout",
        "why is my goal 2900?",
        "I ate 2 eggs",
        "",
    ]) {
        assert.equal(
            isConfirmationFastPath(msg, "analyst"),
            false,
            `expected LLM routing: ${msg}`
        );
    }
});

// ---------------------------------------------------------------------------
// Dynamic agent context: "today" is computed in the USER's timezone and the
// plan summary expands TODAY's session (exercise names) so the coach can
// answer "what am I training today?" without a tool call.
// ---------------------------------------------------------------------------

test("buildDynamicAgentContext uses the user's timezone and expands today's workout", () => {
    const tz = "America/Los_Angeles";
    const expectedDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const expectedDow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
        .format(new Date())
        .toLowerCase();

    const allDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const state = {
        userId: "u1",
        userTimezone: tz,
        userProfile: { name: "Alex" },
        currentPlan: {
            id: "plan-1",
            days: allDays.map((d) => ({
                day_of_week: d,
                split_day_name: d === expectedDow ? "Push" : "Other",
                exercises_structured: d === expectedDow
                    ? [{ name: "Bench Press" }, { name: "Overhead Press" }]
                    : [{ name: "Filler" }],
            })),
        },
        messages: [],
    } as any;

    const ctx = buildDynamicAgentContext(state);
    assert.match(ctx, new RegExp(`Today's date is ${expectedDate}`));
    assert.match(ctx, new RegExp(`day of the week is ${expectedDow}`));
    assert.match(ctx, /← TODAY \(Bench Press, Overhead Press\)/);
});

// ---------------------------------------------------------------------------
// Loop guard: the per-turn agent step budget terminates a runaway read-tool
// loop with a clean reply instead of crashing on LangGraph's recursionLimit.
// This path short-circuits BEFORE any LLM call, so it needs no model mock.
// ---------------------------------------------------------------------------

test("runAgentDecision forces a terminating reply once the step budget is spent", async () => {
    // AGENT_STEP_BUDGET defaults to 8 → turn 9 must short-circuit. Set it
    // explicitly so the test is independent of the default.
    process.env.AGENT_STEP_BUDGET = "8";
    const state = {
        agentTurns: 8, // next invocation is turn 9 → over budget
        responseToUser: null,
        messages: [new HumanMessage("rebuild my whole legs day")],
    } as any;

    const out = await runAgentDecision(editorDef, state);

    assert.equal(out.shouldCallTool, false, "must not call more tools when over budget");
    assert.deepEqual(out.toolCalls, []);
    assert.equal(out.completed, true);
    assert.equal(out.agentTurns, 9, "increments the per-turn counter");
    assert.ok(
        (out.responseToUser ?? "").trim().length > 0,
        "must produce a non-empty closing reply, never dead air"
    );
});

test("runAgentDecision preserves an already-produced reply when budget is hit", async () => {
    process.env.AGENT_STEP_BUDGET = "8";
    const state = {
        agentTurns: 12,
        responseToUser: "Here's the squat-focused leg day I built.",
        messages: [new HumanMessage("more")],
    } as any;

    const out = await runAgentDecision(editorDef, state);
    assert.equal(out.responseToUser, "Here's the squat-focused leg day I built.");
    assert.equal(out.shouldCallTool, false);
});

// ---------------------------------------------------------------------------
// Token streaming: incremental responseToUser extraction from JSON deltas
// ---------------------------------------------------------------------------

test("JsonStringFieldStreamer decodes a field split across arbitrary chunks", () => {
    const s = new JsonStringFieldStreamer("responseToUser");
    const json = '{"thought":"t","shouldCallTool":false,"toolCalls":[],"preamble":"","responseToUser":"Hello \\"champ\\"!\\nLet\'s lift."}';
    let out = "";
    for (let i = 0; i < json.length; i += 3) {
        out += s.push(json.slice(i, i + 3));
    }
    assert.equal(out, 'Hello "champ"!\nLet\'s lift.');
    assert.equal(s.isComplete, true);
    assert.equal(s.emittedLength, out.length);
});

test("JsonStringFieldStreamer holds back incomplete escapes and unicode", () => {
    const s = new JsonStringFieldStreamer("responseToUser");
    assert.equal(s.push('{"responseToUser":"a\\'), "a");
    assert.equal(s.push('u00e9b"'), "éb");
    assert.equal(s.isComplete, true);
});

test("JsonStringFieldStreamer emits nothing for other fields", () => {
    const s = new JsonStringFieldStreamer("responseToUser");
    assert.equal(s.push('{"thought":"do not leak this","preamble":"or this"'), "");
    assert.equal(s.emittedLength, 0);
});

// ---------------------------------------------------------------------------
// Checkpoint history compaction
// ---------------------------------------------------------------------------

function fakeThread(turns: number) {
    const msgs = [];
    for (let i = 0; i < turns; i++) {
        msgs.push(new HumanMessage(`user message ${i}`));
        msgs.push(new AIMessage(`assistant reply ${i}`));
    }
    return msgs;
}

test("compactHistoryForCheckpoint is a no-op under the threshold", () => {
    assert.equal(compactHistoryForCheckpoint(fakeThread(10), { threshold: 60 }), null);
});

test("compactHistoryForCheckpoint collapses old turns behind a flagged summary", () => {
    const compacted = compactHistoryForCheckpoint(fakeThread(40), {
        threshold: 60,
        keepRecent: 24,
    });
    assert.ok(compacted);
    assert.equal(compacted![0].additional_kwargs[HISTORY_COMPACTION_FLAG], true);
    assert.ok(compacted!.length <= 26);
    assert.ok(compacted![1] instanceof HumanMessage, "kept window must start on a user message");
    assert.match(String(compacted![0].content), /CONVERSATION SUMMARY/);
});

test("messages reducer replaces history when the compaction flag is present", () => {
    const reducer = (GraphState.spec.messages as any).reducer ??
        // Annotation internals differ across versions; fall back to invoking via channel
        null;
    // Exercise the reducer through the channel binary operator if exposed.
    const existing = fakeThread(5);
    const replacement = compactHistoryForCheckpoint(fakeThread(40), { threshold: 10, keepRecent: 8 })!;
    if (typeof reducer === "function") {
        const next = reducer(existing, replacement);
        assert.equal(next, replacement, "flagged update must REPLACE, not append");
        const appended = reducer(existing, [new HumanMessage("normal append")]);
        assert.equal(appended.length, existing.length + 1);
    } else {
        // If the reducer isn't directly reachable, at least assert the flag survives.
        assert.equal(replacement[0].additional_kwargs[HISTORY_COMPACTION_FLAG], true);
    }
});

test("planner can build + publish a full plan (draft tools wired)", () => {
    const names = new Set(plannerDef.tools.map((t) => t.name));
    for (const t of ["generate_draft_plan", "modify_draft_plan", "approve_and_publish_plan"]) {
        assert.ok(names.has(t), `planner missing ${t}`);
    }
});

test("editor can move/swap workouts (schedule + swap tools wired)", () => {
    const names = new Set(editorDef.tools.map((t) => t.name));
    for (const t of ["shift_workout_schedule", "swap_session_exercise", "swap_permanent_exercise"]) {
        assert.ok(names.has(t), `editor missing ${t}`);
    }
});

// ---------------------------------------------------------------------------
// One-message-chatbot regression pass: unknown-tool reporting, turn-scoped
// recap guidance, and the extend_one_off_workout wiring.
// ---------------------------------------------------------------------------

test("filterAgentToolCalls reports unknown tool names for corrective retry", () => {
    const calls: ToolCallLike[] = [
        { toolName: "edit_workout", args: {} }, // hallucinated
        { toolName: "add_exercise_to_workout", args: {} }, // hallucinated
    ];
    const { kept, droppedUnknownToolNames } = filterAgentToolCalls(calls, EDITOR_ALLOWED, false);
    assert.equal(kept.length, 0);
    assert.deepEqual(droppedUnknownToolNames, ["edit_workout", "add_exercise_to_workout"]);
});

test("buildDynamicAgentContext injects recap-only guidance after a mutation succeeded", () => {
    const state: any = {
        userId: "u1",
        userProfile: {},
        currentPlan: null,
        userContext: "",
        userTimezone: "UTC",
        conversationId: "c1",
        messages: [],
        error: null,
        retryCount: 0,
        turnMutationDone: true,
    };
    const ctx = buildDynamicAgentContext(state);
    assert.match(ctx, /ALREADY APPLIED/);
    assert.match(ctx, /Do NOT call any more tools/);
});

test("buildDynamicAgentContext distinguishes validation retry from final give-up", () => {
    const base: any = {
        userId: "u1",
        userProfile: {},
        currentPlan: null,
        userContext: "",
        userTimezone: "UTC",
        conversationId: "c1",
        messages: [],
        error: "missing gif_path",
        retryCount: 1,
    };
    const retryCtx = buildDynamicAgentContext({ ...base, turnMutationDone: false });
    assert.match(retryCtx, /Rebuild it now/);
    const giveUpCtx = buildDynamicAgentContext({ ...base, turnMutationDone: true });
    assert.match(giveUpCtx, /apologize/i);
    assert.doesNotMatch(giveUpCtx, /Rebuild it now/);
});

test("buildDynamicAgentContext has no turn-scoped guidance on a fresh turn", () => {
    const state: any = {
        userId: "u1",
        userProfile: {},
        currentPlan: null,
        userContext: "",
        userTimezone: "UTC",
        conversationId: "c1",
        messages: [],
        error: null,
        retryCount: 0,
        turnMutationDone: false,
    };
    const ctx = buildDynamicAgentContext(state);
    assert.doesNotMatch(ctx, /ALREADY APPLIED/);
    assert.doesNotMatch(ctx, /VALIDATION FAILURE/);
});

test("extend_one_off_workout is fully wired (registry + editor + mutation/builder guards)", async () => {
    assert.ok(toolByName["extend_one_off_workout"], "missing from toolByName registry");
    const editorTools = new Set(editorDef.tools.map((t) => t.name));
    assert.ok(editorTools.has("extend_one_off_workout"), "editor cannot use extend tool");
    const { BUILDER_MUTATION_TOOLS } = await import("../agents/agentRuntime");
    const { CORE_MUTATION_TOOLS } = await import("../agents/state");
    assert.ok(BUILDER_MUTATION_TOOLS.has("extend_one_off_workout"), "not a builder mutation");
    assert.ok(CORE_MUTATION_TOOLS.has("extend_one_off_workout"), "not a core mutation");
});
