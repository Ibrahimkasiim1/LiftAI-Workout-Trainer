/**
 * Trace LangGraph streaming behavior for three canned prompts.
 * Requires a running backend and valid Supabase user id.
 *
 * Usage (from backend/):
 *   TRACE_SUPABASE_JWT=<access_token> npx tsx scripts/trace-chat-stream.ts
 *
 * Optional: CHAT_STREAM_URL (default http://127.0.0.1:3001/chat/stream)
 */
import dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const CHAT_STREAM_URL = process.env.CHAT_STREAM_URL ?? "http://127.0.0.1:3001/chat/stream";
const TRACE_JWT =
    process.env.TRACE_SUPABASE_JWT ||
    process.env.LIFT_DIAGNOSTIC_JWT ||
    process.env.SUPABASE_ACCESS_TOKEN ||
    "";

type SseRecord = { type?: string; content?: string; toolNames?: string[]; message?: string };

async function consumeSse(response: Response): Promise<SseRecord[]> {
    const body = response.body;
    if (!body) return [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: SseRecord[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
            for (const line of part.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const raw = line.slice(6).trim();
                if (!raw) continue;
                try {
                    events.push(JSON.parse(raw) as SseRecord);
                } catch {
                    events.push({ type: "parse_error", message: raw } as SseRecord);
                }
            }
        }
    }
    return events;
}

function firstIndex(types: string[], t: string): number {
    return types.indexOf(t);
}

async function runCase(name: string, message: string) {
    if (!TRACE_JWT) {
        console.error("Missing TRACE_SUPABASE_JWT (Supabase access_token).");
        process.exit(1);
    }

    const res = await fetch(CHAT_STREAM_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${TRACE_JWT}`,
        },
        body: JSON.stringify({
            message,
            conversationId: `trace-${name.replace(/\s+/g, "-")}-${Date.now()}`,
        }),
    });

    if (!res.ok) {
        console.error(`[${name}] HTTP ${res.status}`, await res.text());
        return;
    }

    const events = await consumeSse(res);
    const types = events.map((e) => e.type ?? "?");
    const textJoined = events
        .filter((e) => e.type === "text")
        .map((e) => e.content ?? "")
        .join("");

    console.log(`\n── ${name} ──`);
    console.log("SSE types:", types.join(" → "));

    const iTool = firstIndex(types, "tool_start");
    const iText = firstIndex(types, "text");
    const hasWorkout = types.includes("workout");
    const toolNames = events.find((e) => e.type === "tool_start")?.toolNames ?? [];

    if (name.startsWith("Direct")) {
        if (iTool >= 0 && iText >= 0 && iText < iTool) {
            console.warn("Expected tool_start before text for workout path (check backend ordering).");
        }
        if (!hasWorkout) console.warn("Expected workout event for direct session request.");
        if (!toolNames.includes("create_one_off_workout")) {
            console.warn("Expected create_one_off_workout in tool_start.toolNames.");
        }
    }
    if (name.startsWith("Ambiguous")) {
        if (hasWorkout) console.warn("Did not expect workout modal for vague goal.");
        if (toolNames.includes("create_one_off_workout")) {
            console.warn("Model called create_one_off_workout without enough context (should clarify).");
        }
    }
    if (name.startsWith("Chat")) {
        if (hasWorkout) console.warn("Did not expect workout for pure Q&A.");
        if (toolNames.includes("create_one_off_workout")) {
            console.warn("Unexpected create_one_off_workout for education question.");
        }
    }

    console.log("Assistant text (concat):", JSON.stringify(textJoined.slice(0, 320)));
}

const PROMPTS: { name: string; message: string }[] = [
    {
        name: "Direct workout",
        message:
            "I only have 20 minutes and dumbbells today. Generate a full-body session.",
    },
    {
        name: "Ambiguous goal",
        message: "I want to get huge.",
    },
    {
        name: "Chat only",
        message: "Why do my knees hurt when I squat?",
    },
];

async function main() {
    console.log("CHAT_STREAM_URL:", CHAT_STREAM_URL);
    for (const p of PROMPTS) {
        await runCase(p.name, p.message);
    }
    console.log("\nDone.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
