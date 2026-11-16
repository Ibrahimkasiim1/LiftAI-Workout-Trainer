/**
 * Live smoke test: editor decision on the new OpenAI default (gpt-4.1),
 * replaying the exact scenario that failed in production — a follow-up
 * "add a calf exercise to this" after a delivered one-off workout.
 * Verifies: API accepts the cache_control message format, structured output
 * parses, and the decision acts (tools) instead of re-asking clarification.
 */
import dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { getAgentModel } from "../src/agents/modelFactory";
import {
    buildStaticAgentPrompt,
    buildDynamicAgentContext,
} from "../src/agents/agentRuntime";
import { editorDef } from "../src/agents/editorSubgraph";
import {
    cacheableSystemMessage,
    dynamicSystemMessage,
} from "../src/agents/messageHelpers";

async function main() {
    const state: any = {
        userId: "test-user",
        userProfile: { fitness_level: "intermediate", goal: "build muscle" },
        currentPlan: null,
        userContext: "",
        userTimezone: "America/New_York",
        conversationId: "smoke",
        messages: [],
        error: null,
        retryCount: 0,
        turnMutationDone: false,
    };

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
        },
        required: ["thought", "shouldCallTool", "toolCalls", "preamble", "responseToUser"],
        additionalProperties: false,
    } as const;

    const llm = getAgentModel("editor");
    console.log("MODEL:", (llm as any).model ?? (llm as any).modelName);
    const structured = llm.withStructuredOutput(decisionJsonSchema as any, {
        name: "editor_decision",
    });
    const history = [
        new HumanMessage("Build me an abs workout"),
        new AIMessage('[Built and delivered "Abs Workout" (7 exercises) to the user as a workout card.]'),
        new AIMessage("Your abs workout is ready — seven focused movements, about 25 minutes. Want me to tweak anything?"),
        new HumanMessage("Can you add a calf exercise to this"),
    ];

    const report = (label: string, decision: any) => {
        console.log(`--- ${label} ---`);
        console.log("shouldCallTool:", decision.shouldCallTool);
        console.log(
            "tools:",
            (decision.toolCalls ?? []).map((t: any) => t.toolName).join(", ") || "(none)"
        );
        console.log("preamble:", String(decision.preamble ?? "").slice(0, 120));
        console.log("responseToUser:", String(decision.responseToUser ?? "").slice(0, 160));
    };

    // Scenario 1: first follow-up after a delivered card — must act, not stall.
    report(
        "follow-up: add calf to delivered card",
        await structured.invoke([
            cacheableSystemMessage(buildStaticAgentPrompt(editorDef)),
            dynamicSystemMessage(buildDynamicAgentContext(state)),
            ...history,
        ])
    );

    // Scenario 2: the production clarification loop — a clarifying question
    // was already asked and the user answered vaguely. Must NOT re-ask.
    report(
        "answered clarification: must act, not re-ask",
        await structured.invoke([
            cacheableSystemMessage(buildStaticAgentPrompt(editorDef)),
            dynamicSystemMessage(buildDynamicAgentContext(state)),
            ...history,
            new AIMessage(
                "Quick clarification — do you want me to rebuild that abs workout to include calves in the same session, or add a calf exercise to one of your scheduled days this week?"
            ),
            new HumanMessage("Add it to this and workout u just made"),
        ])
    );
}

main().catch((e) => {
    console.error("SMOKE FAIL:", e?.message ?? e);
    process.exit(1);
});
