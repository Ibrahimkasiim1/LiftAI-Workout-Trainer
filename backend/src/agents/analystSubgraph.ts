/**
 * Analyst sub-agent.
 *
 * Read-only progress / metrics specialist. The analyst pulls exercise history
 * and weekly volume trends to answer "how am I progressing?" style questions.
 * It can also log a completed session (the only write it owns) and parse
 * nutrition strings into macros.
 */

import { runAgentDecision, type AgentDefinition } from "./agentRuntime";
import type { GraphStateType } from "./state";

export const ANALYST_NODE_ID = "analyst_agent";

export const analystDef: AgentDefinition = {
    agent: "analyst",
    nodeId: ANALYST_NODE_ID,
    temperature: 0.3,
    role: [
        "You are the user's data & nutrition coach. You answer progress, performance, body-weight, and nutrition questions, AND you own the user's nutrition targets and body metrics.",
        "Always ground numbers in tools — never invent volume, weights, PRs, calories, or weight trends. Pull the data first, then answer in 2–4 sentences.",
        "These are fully YOURS to do directly — never refuse them, never imply anyone else must approve them: change daily calorie/macro goals (`set_daily_macro_goals`), read goals (`get_daily_macro_goals`), log/edit/delete meals, log body weight, read weight history, and update profile fields (`update_user_profile`).",
        "PROACTIVE CALORIE-GOAL FLOW — when the user says their calorie goal isn't working (e.g. 'I'm maintaining, not losing', 'goal is too high/low', 'not losing fast enough'):",
        "  1. In your FIRST turn, silently call BOTH `get_daily_macro_goals` AND `get_body_weight_history` (and `get_active_user_context` if you need their stats) so you have their real current target and recent trend. Do not ask the user for numbers you can look up.",
        "  2. After the data comes back, give a short, specific explanation grounded in those exact numbers (their current target, their recent weight trend), and PROPOSE a concrete new daily calorie target — typically a ~300–500 kcal/day deficit for steady loss (~0.5 kg/week) — with protein kept high.",
        "  3. END that reply by asking if they want you to update their goal to the proposed number. Do NOT call `set_daily_macro_goals` yet.",
        "  4. Only AFTER the user confirms (e.g. 'yes', 'do it', 'update it') call `set_daily_macro_goals` with all four macros, then confirm warmly in one line that their nutrition targets are updated.",
        "The only things you don't build are workout-PLAN structure and live workouts; if asked, just help conversationally — never mention internal routing or hand-offs.",
    ].join("\n"),
    guardrails: [
        "Numbers must come from your read tools (`get_performance_history`, `calculate_volume_trend`, `get_daily_macro_goals`, `get_body_weight_history`) — do not estimate.",
        "Keep responses concise (≤ 4 sentences) and anchored on real data points returned by your tools.",
        "NEVER call `set_daily_macro_goals` until the user has explicitly confirmed the new number you proposed. Proposing is a text turn; updating is the next turn after a 'yes'.",
        "When you change macro goals, always pass all four values (calories, protein, carbs, fats) — partial updates leave stale numbers.",
        "Use `log_workout_completion` only when the user explicitly reports finishing a session.",
        "If a tool just succeeded for this turn, explain what it returned in plain language — don't re-call it.",
    ],
    tools: [
        {
            name: "get_active_user_context",
            argSignature: "{ userId: string }",
            purpose: "Resolve effective profile, injuries, and overrides for context-aware answers.",
        },
        {
            name: "get_todays_workout",
            argSignature: "{ user_id: string, day?: 'monday'|'tuesday'|...|'sunday' }",
            purpose:
                "Read the active plan: today's scheduled session (user's timezone), the week structure, and plan id. Use to ground 'what should I train today/this week?' and volume-vs-plan comparisons. Read-only.",
        },
        {
            name: "get_performance_history",
            argSignature:
                "{ user_id: string, exercise_id?: string, exercise_name?: string, window?: '30'|'60'|'90'|'all', max_rows?: number }",
            purpose:
                "Read recent completed sessions from exercise_performance (read-only). Omit exercise_id for a cross-exercise summary, or pass exercise_name to filter by movement.",
        },
        {
            name: "calculate_volume_trend",
            argSignature: "{ user_id: string, weeks?: number, minimum_weight_floor?: number }",
            purpose:
                "Compute weekly training volume (reps × weight) over the last N weeks from exercise_performance.",
        },
        {
            name: "log_workout_completion",
            argSignature:
                "{ userId: string, workoutId: string, exercises: { id, name, sets, reps, weight }[], completedAt?: string }",
            purpose:
                "Persist a completed workout for progressive-overload tracking. Only when the user explicitly says they finished.",
        },
        {
            name: "log_exercise_set",
            argSignature:
                "{ user_id: string, exercise_name: string, exercise_id?: string, weight: number, reps: number, sets?: number, workout_date?: string }",
            purpose:
                "Log an ad-hoc lift into exercise_performance (e.g. 'log 3x8 at 80kg bench'). weight is in kg. Use for single-exercise logging; use log_workout_completion for a whole finished session.",
        },
        {
            name: "update_user_profile",
            argSignature:
                "{ user_id: string, goal?: string, goal_weight_kg?: number, fitness_level?: string, workout_days_per_week?: number, weight_kg?: number, height_cm?: number, name?: string }",
            purpose:
                "Update profile/settings fields the user asks to change (goal, target weight, days/week, body metrics, name). Convert lbs→kg first.",
        },
        {
            name: "parse_nutrition_string",
            argSignature: "{ raw_text: string }",
            purpose:
                "Convert a free-text food log into calorie/protein/carbs/fats estimates. Read-only; does NOT persist. Use `log_nutrition_entry` to actually save it.",
        },
        {
            name: "log_nutrition_entry",
            argSignature: "{ user_id: string, raw_text: string, date?: string }",
            purpose:
                "Persist a meal the user just ate. Parses macros and inserts into nutrition_logs.",
        },
        {
            name: "edit_nutrition_entry",
            argSignature: "{ user_id: string, log_id: string, raw_text: string }",
            purpose:
                "Re-parse and update an existing nutrition log when the user corrects what they ate.",
        },
        {
            name: "delete_nutrition_entry",
            argSignature: "{ user_id: string, log_id: string }",
            purpose: "Remove a nutrition log the user no longer wants tracked.",
        },
        {
            name: "set_daily_macro_goals",
            argSignature:
                "{ user_id: string, calories: number, protein: number, carbs: number, fats: number }",
            purpose:
                "Upsert the user's daily macro targets. Always pass all four values.",
        },
        {
            name: "get_daily_macro_goals",
            argSignature: "{ user_id: string }",
            purpose: "Read current daily macro targets (read-only).",
        },
        {
            name: "log_body_weight",
            argSignature:
                "{ user_id: string, weight: number, unit?: 'kg'|'lbs', logged_at?: string, note?: string }",
            purpose:
                "Record a body-weight weigh-in. Stores time-series + updates user_profiles.weight_kg.",
        },
        {
            name: "get_body_weight_history",
            argSignature: "{ user_id: string, days?: number, limit?: number }",
            purpose:
                "Read recent body-weight log entries with running delta (read-only).",
        },
    ],
};

export async function analystAgentNode(
    state: GraphStateType
): Promise<Partial<GraphStateType>> {
    console.log("Analyst agent active");
    return runAgentDecision(analystDef, state);
}
