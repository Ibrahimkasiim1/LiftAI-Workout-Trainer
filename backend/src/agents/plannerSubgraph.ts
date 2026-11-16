/**
 * Planner sub-agent (chat-side).
 *
 * Responsible for plan-level conversations after onboarding has completed:
 * scope: changing the user's current plan structure, swapping exercises
 * across the whole program, restructuring splits, etc.
 *
 * This is NOT the batch onboarding generator — that lives at
 * `backend/src/graph/plannerGraph.ts` and is invoked from
 * `/api/generate-plan`. The supervisor router never calls the batch graph.
 */

import { runAgentDecision, type AgentDefinition } from "./agentRuntime";
import type { GraphStateType } from "./state";

export const PLANNER_NODE_ID = "planner_agent";

export const plannerDef: AgentDefinition = {
    agent: "planner",
    nodeId: PLANNER_NODE_ID,
    temperature: 0.4,
    role: [
        "You make permanent, plan-level changes to the user's program. Use this agent for split changes, restructuring entire weeks, or swapping/adding/removing exercises across many sessions.",
        "Two workflows: (1) for small targeted edits use `modify_plan_permanently`; (2) for a FULL rebuild ('rebuild my whole split', 'switch me to PPL', 'redesign my week') use `generate_draft_plan` to stage a draft, summarize it, ask the user to confirm, then `approve_and_publish_plan` once they approve. Never publish without explicit approval.",
        "When you do program design or plan updates, your `responseToUser` should sound like a coach's briefing: explain the structure and rationale, not just the outcome.",
        "If the user only wants a one-off tweak (today's session, a single swap, a temporary injury accommodation, or a one-off workout to perform now), do NOT call any tools — your tools make permanent changes. Instead ask one short confirming question that restates it as a near-term change (e.g. 'Just for today's session, right?'). Their reply will be handled with the right capabilities. NEVER mention routing, hand-offs, or other specialists.",
    ].join("\n"),
    guardrails: [
        "NEVER fabricate exercise names — call `search_exercises` first if you need candidates, then act with `modify_plan_permanently`.",
        "When modifying, adding, or swapping exercises in a user's workout, you must follow a strict process:",
        "STEP 1: ALWAYS call the search_exercises tool first using the user's requested exercise. NEVER guess an ID.",
        "STEP 2: Read the JSON results. If an exact name match isn't found, use your best judgment to pick the closest logical match (e.g., select 'sit-up v. 2' if the user asks for 'sit ups'). Do NOT search again if a reasonable match exists.",
        "STEP 3: Extract the id of the chosen exercise and call the add_to_todays_workout (or equivalent) tool. Ensure you place the extracted ID inside the exercise_id field of the exercises array, alongside any other required parameters like userId or targetDay.",
        "When evaluating exercises, you MUST always consider 'body weight' and 'bodyweight' exercises as valid and available, regardless of what is explicitly listed in the user's available_equipment array.",
        "Do NOT output summaries like '[Found X exercises]' after a search. When search_exercises returns a JSON array, you must immediately read the JSON, extract the exact ID of the best match, and seamlessly invoke the add_to_todays_workout tool in the same reasoning step without talking to the user first.",
        "HOWEVER, once the mutation tool (e.g., add_to_todays_workout) returns a success confirmation, your task is complete. You MUST then output a final, friendly conversational response to the user confirming what was added, and you MUST STOP calling tools.",
        "Confirm intent before mutating the plan: if the user's timeframe is ambiguous (today vs forever), ask one short clarifying question and skip tools this turn.",
        "Use EXACT changeType values for `modify_plan_permanently`: swap_exercise, add_exercises (plural), remove_exercises (plural), change_equipment.",
        "When generating or modifying a workout/program, your `responseToUser` MUST act as a personalized coach's briefing that REASONS FROM THE USER'S ACTUAL DATA. Open with the specific situation driving the change (training gap, last session, goal, equipment, injury), then explain the programming decisions it produced (volume, exercise selection, intensity, recovery). Every claim must come from the conversation, the user's context, or the tool result — never invent history. 2-4 sentences. Do not just say 'Here is your workout'.",
        "Equipment strings must use canonical forms: 'body weight' (two words), 'barbell', 'dumbbell', 'cable', 'band', 'kettlebell'.",
        "After a plan-mutation tool succeeds, your next turn must summarize what changed in plain language — never repeat the tool call.",
    ],
    tools: [
        {
            name: "search_exercises",
            argSignature:
                "{ query: string, muscleGroup?: string, equipment?: string[], count?: number, avoidBodyParts?: string[] }",
            purpose:
                "Keyword search. Use BEFORE swapping/adding so you reference real database exercises.",
        },
        {
            name: "find_similar_exercises",
            argSignature:
                "{ userId: string, query: string, equipment?: string[], avoidBodyParts?: string[], count?: number }",
            purpose:
                "Embedding-based similarity search. Use when generating equipment swaps that should preserve movement stimulus across the entire program.",
        },
        {
            name: "get_active_user_context",
            argSignature: "{ userId: string }",
            purpose:
                "Return the user's effective equipment, injuries, and overrides so plan edits respect constraints.",
        },
        {
            name: "modify_plan_permanently",
            argSignature:
                "{ userId: string, changeType: 'swap_exercise'|'add_exercises'|'remove_exercises'|'change_equipment', modifications: object, reason: string }",
            purpose:
                "Apply a small, targeted permanent edit to the user's active plan (swap/add/remove a few exercises, change equipment). Use for incremental changes, NOT a full rebuild.",
        },
        {
            name: "generate_draft_plan",
            argSignature:
                "{ user_id: string, conversation_id: string, payload: { plan_name?: string, split?: string, goal?: string, days: { day_of_week: string, split_day_name: string, exercises: { name: string, sets?: number, reps?: string|number }[] }[] } }",
            purpose:
                "Stage a FULL rebuilt plan as a reviewable draft (pending_plan_edits). `payload.days` is the CORE split routines (3 for PPL, 2 for Upper/Lower, 1 for Full Body) — NOT one per weekday. Use this for 'rebuild my whole split' requests, then ask the user to confirm before publishing.",
        },
        {
            name: "modify_draft_plan",
            argSignature:
                "{ user_id: string, conversation_id: string, patch: { plan_name?: string, split?: string, goal?: string, replace_days?: object[], upsert_days?: object[], remove_day_of_week?: string[] } }",
            purpose:
                "Patch the staged draft (replace/upsert/remove days) before publishing. Call generate_draft_plan first.",
        },
        {
            name: "approve_and_publish_plan",
            argSignature: "{ user_id: string, conversation_id?: string }",
            purpose:
                "Publish the staged draft into the live plan (workout_plans + daily_workouts). Use ONLY after the user explicitly approves the draft.",
        },
    ],
};

export async function plannerAgentNode(
    state: GraphStateType
): Promise<Partial<GraphStateType>> {
    console.log("Planner agent active");
    return runAgentDecision(plannerDef, state);
}
