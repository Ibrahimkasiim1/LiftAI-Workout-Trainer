/**
 * Voice mode — OpenAI Realtime ephemeral session minting + post-session cost
 * accrual.
 *
 * The Realtime API uses WebRTC: the client connects directly to OpenAI's
 * servers, audio never transits our backend. Our server's job is to mint a
 * short-lived ephemeral token (so we never expose `OPENAI_API_KEY` to the
 * device) and, after the session ends, persist a row in `voice_sessions`
 * with audio durations so `record_ai_cost` can charge the user correctly.
 *
 * Endpoints:
 *   POST /voice/session — auth'd, returns { token, expiresAt, model }.
 *                         Client uses the token to open a WebRTC connection
 *                         to api.openai.com/v1/realtime?model=...
 *
 *   POST /voice/session/end — auth'd, accepts the durations the client
 *                              measured and triggers cost accrual.
 *
 *   POST /voice/escalate — internal-style endpoint the Realtime model can
 *                          call as a tool when the user wants heavy reasoning
 *                          (rebuild plan, deep analytics). Routes to the
 *                          existing supervisor graph. (Wired in Phase 2.)
 *
 * NOTE: This file ships only the token + end-session paths. The escalate
 * route + the actual Realtime tool definitions land in Phase 2 once we
 * decide on the audio coaching prompt and the tool subset Realtime should
 * see (likely a smaller set than the full text agent inventory).
 */

import { HumanMessage } from "@langchain/core/messages";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { LangChainCallbackHandler } from "@posthog/ai";
import { getChatGraphAsync } from "../agents/langgraphRuntime";
import { GRAPH_RECURSION_LIMIT } from "../agents/supervisorGraph";
import { makeUsageTracker } from "../agents/usageTracking";
import { recordAudioSessionCost } from "../agents/usageTracking";
import type { AuthedRequest } from "../middleware/auth";
import { getLatestPlan, getUserProfile, supabase } from "../services/db";
import { phClient } from "../services/posthog";
import { getUserTimezone } from "../services/userTimezone";
import { getFormattedUserContext } from "../tools/memoryActions";

const router = Router();

const VOICE_MODEL = process.env.VOICE_MODEL ?? "gpt-realtime-mini";

const REALTIME_SYSTEM_INSTRUCTIONS = [
    "You are LiftAI — an elite personal trainer running the user's workout right now over voice. You are NOT a chatbot. You are mid-session with someone who is lifting.",
    "",
    "YOU ALWAYS KNOW THE LIVE STATE. A 'LIVE WORKOUT CONTEXT' block is appended to these instructions and refreshed every time the user moves between sets, rests, or exercises. Reference the current exercise by name, know what set they're on, and respect whether they're MID-SET or RESTING.",
    "",
    "PHASE AWARENESS — you can see whether the user is MID-SET or RESTING in the LIVE WORKOUT CONTEXT block. Mic is always open; the user can talk to you any time, including during a set. But YOU adjust your own behaviour around set transitions:",
    "  - When the phase flips from RESTING → MID-SET while you were mid-conversation, briefly tell the user you'll let them focus (one short sentence, e.g. 'go get this set — I'll be here'). Then stop asking follow-up questions until they speak again or rest starts. Do NOT keep prompting them mid-set.",
    "  - When the phase flips MID-SET → RESTING, only re-engage if the user speaks first or there's a real reason to check in (e.g. they sounded gassed on the prior set). Otherwise, stay quiet and let them breathe.",
    "  - If the user DOES talk to you mid-set, answer normally — they chose to engage.",
    "  - During RESTING with no transition, behave like a coach in the gym: short check-ins, useful cues, no constant chatter.",
    "",
    "RESPONSE STYLE: 1–2 sentences. Coach's tone — direct, warm, never preachy. Match the user's energy: if they sound tired, ease off and offer to reduce load or reps; if they sound fired up, push them.",
    "",
    "TOOL USE — escalate_to_supervisor is your hands. Call it IMMEDIATELY any time the user wants ANY change to their workout, including:",
    "  - swapping the current exercise for another (knee bothering them, no equipment, bored)",
    "  - changing sets, reps, weight, or rest time for the current exercise",
    "  - skipping an exercise, adding one, or rebuilding the rest of the session",
    "  - logging a set, marking something done, asking for analytics",
    "  - any plan-level edit (this week's split, future sessions)",
    "Pass a one-line `intent` describing exactly what to do (e.g. 'swap current exercise to a knee-friendly alternative', 'drop reps from 12 to 8 this set, user is gassed') and an `emotion` tag. After the tool returns, read the `briefing` aloud naturally — do NOT re-list sets or exercises; the on-screen card shows that.",
    "",
    "Never refuse a change yourself with phrases like 'I can't edit your workout' — you can, via the tool. Never list exercises aloud. Never ask the user to do something they can see on screen.",
    "",
    "Acknowledge effort. Use the user's apparent emotion to inform tone, intensity recommendations, and follow-up questions.",
].join("\n");

/**
 * Tool surface exposed to the Realtime model. Deliberately small — the
 * Realtime layer is for fast conversation; anything heavy escalates to the
 * full supervisor graph via `escalate_to_supervisor`.
 *
 * The client sends these to OpenAI when starting the session via the
 * `session.update` event. They're returned here so the frontend
 * voiceMode service can pick them up at session-start without re-deriving.
 */
export const REALTIME_TOOL_DEFINITIONS = [
    {
        type: "function",
        name: "escalate_to_supervisor",
        description:
            "Hand the conversation to LiftAI's text-mode supervisor for anything beyond live coaching: building a workout, modifying the plan, analytics, deep nutrition advice. Always include an emotion tag describing how the user sounds.",
        parameters: {
            type: "object",
            properties: {
                intent: {
                    type: "string",
                    description: "One-line summary of what the user wants (e.g. 'rebuild plan around home equipment').",
                },
                emotion: {
                    type: "string",
                    enum: ["tired", "energized", "frustrated", "neutral", "anxious", "motivated"],
                    description: "How the user sounds right now.",
                },
            },
            required: ["intent", "emotion"],
        },
    },
] as const;

// ============================================================================
// SESSION MINTING
// ============================================================================

router.post("/voice/session", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "OPENAI_API_KEY not configured on backend" });
            return;
        }

        // OpenAI's Realtime sessions endpoint mints a short-lived client_secret
        // suitable for WebRTC handshake. The server-side API key never leaves
        // this process. Reference: platform.openai.com/docs/api-reference/realtime-sessions
        const upstream = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: VOICE_MODEL,
                modalities: ["audio", "text"],
                instructions: REALTIME_SYSTEM_INSTRUCTIONS,
                voice: process.env.VOICE_NAME ?? "alloy",
            }),
        });

        if (!upstream.ok) {
            const errText = await upstream.text();
            console.error(`[voice] OpenAI realtime session mint failed: ${upstream.status} ${errText}`);
            res.status(502).json({ error: "Failed to create voice session" });
            return;
        }

        const payload = (await upstream.json()) as {
            id: string;
            client_secret: { value: string; expires_at: number };
        };

        // Pre-create the voice_sessions row so post-session updates are an UPDATE
        // not an INSERT race. The client passes back this id on /voice/session/end.
        const { data: row, error: insErr } = await supabase
            .from("voice_sessions")
            .insert({
                user_id: userId,
                model_name: VOICE_MODEL,
                client_meta: { realtime_session_id: payload.id },
            })
            .select("id")
            .single();

        if (insErr || !row) {
            console.error(`[voice] failed to create voice_sessions row: ${insErr?.message}`);
            res.status(500).json({ error: "Failed to log voice session" });
            return;
        }

        res.json({
            sessionId: row.id,
            token: payload.client_secret.value,
            expiresAt: payload.client_secret.expires_at,
            model: VOICE_MODEL,
        });
    } catch (err: any) {
        console.error("[voice] /voice/session error:", err);
        res.status(500).json({ error: err?.message ?? "voice session failed" });
    }
});

// ============================================================================
// SESSION END (cost accrual)
// ============================================================================

const endSessionSchema = z.object({
    sessionId: z.string().uuid(),
    inputAudioMinutes: z.number().nonnegative(),
    outputAudioMinutes: z.number().nonnegative(),
    transcript: z.string().optional(),
    emotionSummary: z.record(z.any()).optional(),
});

router.post("/voice/session/end", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const body = endSessionSchema.parse(req.body);

        // Verify ownership before accruing cost — never trust the body's
        // sessionId without confirming it belongs to the caller.
        const { data: row, error: fetchErr } = await supabase
            .from("voice_sessions")
            .select("id, user_id, model_name")
            .eq("id", body.sessionId)
            .maybeSingle();

        if (fetchErr || !row) {
            res.status(404).json({ error: "session not found" });
            return;
        }
        if (row.user_id !== userId) {
            res.status(403).json({ error: "session does not belong to this user" });
            return;
        }

        await recordAudioSessionCost({
            userId,
            modelName: row.model_name,
            inputAudioMinutes: body.inputAudioMinutes,
            outputAudioMinutes: body.outputAudioMinutes,
        });

        // Persist usage on the row for analytics + post-hoc auditing.
        await supabase
            .from("voice_sessions")
            .update({
                ended_at: new Date().toISOString(),
                input_audio_minutes: body.inputAudioMinutes,
                output_audio_minutes: body.outputAudioMinutes,
                transcript: body.transcript ?? null,
                emotion_summary: body.emotionSummary ?? null,
            })
            .eq("id", body.sessionId);

        res.json({ success: true });
    } catch (err: any) {
        console.error("[voice] /voice/session/end error:", err);
        res.status(err?.name === "ZodError" ? 400 : 500).json({
            error: err?.message ?? "session end failed",
        });
    }
});

// ============================================================================
// REALTIME TOOL DEFINITIONS (client picks these up at session start)
// ============================================================================

router.get("/voice/tools", (_req: Request, res: Response) => {
    res.json({ tools: REALTIME_TOOL_DEFINITIONS, instructions: REALTIME_SYSTEM_INSTRUCTIONS });
});

// ============================================================================
// ESCALATION → SUPERVISOR GRAPH
// ============================================================================
//
// Realtime calls this as a function-call tool ("escalate_to_supervisor") when
// the user wants something beyond live conversation. We run the existing
// supervisor graph end-to-end and return a compact summary plus any structured
// payloads (workout, planUpdate) so the Realtime layer can read the briefing
// aloud and the client can render the modal.
//
// IMPORTANT: this endpoint executes a full graph turn — it's billed via the
// usual usageTracker callback against the user's daily budget.

const escalateSchema = z.object({
    sessionId: z.string().uuid(),
    intent: z.string().min(2),
    emotion: z
        .enum(["tired", "energized", "frustrated", "neutral", "anxious", "motivated"])
        .optional(),
    // Live workout state forwarded from the client so the supervisor knows
    // which exercise/set/rep to mutate without needing to re-query.
    workoutContext: z
        .object({
            exerciseName: z.string(),
            exerciseIndex: z.number().int().nonnegative(),
            totalExercises: z.number().int().nonnegative(),
            currentSet: z.number().int().positive(),
            totalSets: z.number().int().positive(),
            reps: z.union([z.number(), z.string()]),
            restSeconds: z.number().nonnegative().optional(),
            isResting: z.boolean(),
        })
        .optional(),
});

const ESCALATE_TIMEOUT_MS = Number(process.env.VOICE_ESCALATE_TIMEOUT_MS ?? 60_000);

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

router.post("/voice/escalate", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const body = escalateSchema.parse(req.body);

        // Verify the voice session belongs to the caller. Without this any
        // authenticated user could trigger graph runs against an arbitrary
        // session ID.
        const { data: vs, error: vsErr } = await supabase
            .from("voice_sessions")
            .select("id, user_id")
            .eq("id", body.sessionId)
            .maybeSingle();
        if (vsErr || !vs) {
            res.status(404).json({ error: "voice session not found" });
            return;
        }
        if (vs.user_id !== userId) {
            res.status(403).json({ error: "session does not belong to this user" });
            return;
        }

        const graph = await getChatGraphAsync();
        // Use a voice-prefixed thread so escalations don't pollute the user's
        // text chat history. They'll still share long-term memory.
        const threadId = `${userId}:voice:${body.sessionId}`;

        // Compose the user message — include the emotion tag so the supervisor
        // (and downstream agents) can factor in fatigue/energy when picking
        // intensity, volume, or wording. This is the whole point of voice.
        const wc = body.workoutContext;
        const contextLine = wc
            ? `\n[LIVE WORKOUT STATE] exercise=${wc.exerciseName} (index ${wc.exerciseIndex + 1}/${wc.totalExercises}), set=${wc.currentSet}/${wc.totalSets}, reps=${wc.reps}, ${wc.isResting ? `resting (${wc.restSeconds ?? "?"}s)` : "mid-set"}.`
            : "";
        const intentLine = (body.emotion
            ? `[VOICE INTENT — user sounds ${body.emotion}] ${body.intent}`
            : `[VOICE INTENT] ${body.intent}`) + contextLine;

        const [profile, currentPlan, userContext, userTimezone] = await Promise.all([
            getUserProfile(userId),
            getLatestPlan(userId),
            getFormattedUserContext(userId, { maxRows: 50 })
                .then((r) =>
                    r.success && typeof r.formattedContext === "string"
                        ? r.formattedContext
                        : ""
                )
                .catch(() => ""),
            getUserTimezone(userId),
        ]);

        const initialState = {
            userId,
            conversationId: threadId,
            userProfile: profile,
            currentPlan,
            userContext,
            userTimezone,
            messages: [new HumanMessage(intentLine)],
            shouldCallTool: false,
            toolCalls: [],
            responseToUser: null,
            workout: null,
            planUpdate: null,
            completed: false,
            retryCount: 0,
            error: null,
            // Reset the per-turn mutation lock + step counter + preamble
            // (checkpointer persists them across turns otherwise).
            turnMutationDone: false,
            agentTurns: 0,
            preamble: null as string | null,
            toolFailureNotices: null as { toolName: string; message: string }[] | null,
            activeAgent: null as "planner" | "editor" | "analyst" | "supervisor" | null,
            nextAgent: null as "planner" | "editor" | "analyst" | "finish" | null,
        };

        const callbackHandler = new LangChainCallbackHandler({
            client: phClient,
            distinctId: userId,
            properties: { conversationId: threadId, source: "voice_escalate" },
        });
        const usageTracker = makeUsageTracker(userId);

        const result = await withTimeout(
            graph.invoke(initialState, {
                recursionLimit: GRAPH_RECURSION_LIMIT,
                configurable: { thread_id: threadId },
                callbacks: [callbackHandler, usageTracker],
            }),
            ESCALATE_TIMEOUT_MS,
            "voice escalate graph invoke"
        );

        // Realtime gets a compact reply it can read aloud. Structured payloads
        // (workout, plan) are returned alongside so the client can pop the
        // existing modals without an extra round trip.
        res.json({
            success: !(result as any).error,
            briefing: (result as any).responseToUser ?? "Done.",
            workout: (result as any).workout ?? null,
            planUpdate: (result as any).planUpdate ?? null,
            error: (result as any).error ?? null,
        });
    } catch (err: any) {
        console.error("[voice] /voice/escalate error:", err);
        res.status(err?.name === "ZodError" ? 400 : 500).json({
            error: err?.message ?? "voice escalate failed",
        });
    }
});

export default router;
