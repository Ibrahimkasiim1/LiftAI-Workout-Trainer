import { z } from "zod";

export const sseIntentEventSchema = z.object({
  type: z.literal("intent"),
  agent: z.string(),
  intent: z.string().optional(),
});

export const sseStatusEventSchema = z.object({
  type: z.literal("status"),
  state: z.string(),
});

export const sseGraphNodeEventSchema = z.object({
  type: z.literal("graph_node"),
  node: z.string(),
});

export const sseToolStartEventSchema = z.object({
  type: z.literal("tool_start"),
  label: z.string(),
  toolNames: z.array(z.string()).optional(),
});

export const sseToolDoneEventSchema = z.object({
  type: z.literal("tool_done"),
});

/** Structured tool failure for the client (user-safe message; no stack traces). */
export const sseToolErrorEventSchema = z.object({
  type: z.literal("tool_error"),
  toolName: z.string(),
  message: z.string(),
});

export const sseTextStartEventSchema = z.object({
  type: z.literal("text_start"),
});

export const sseTextEventSchema = z.object({
  type: z.literal("text"),
  content: z.string(),
});

export const sseTextDoneEventSchema = z.object({
  type: z.literal("text_done"),
});

export const sseWorkoutStartEventSchema = z.object({
  type: z.literal("workout_start"),
});

export const sseWorkoutEventSchema = z.object({
  type: z.literal("workout"),
  workoutData: z.unknown(),
});

export const ssePlanEventSchema = z.object({
  type: z.literal("plan"),
  planData: z.unknown(),
});

export const sseEditPreviewEventSchema = z.object({
  type: z.literal("edit_preview"),
  actions: z.array(z.unknown()),
  previewChanges: z.object({
    before: z.array(z.unknown()),
    after: z.array(z.unknown()),
  }),
});

/**
 * Tappable follow-up replies for the just-finished coach message. Only sent
 * when the request carried `supportsSuggestions: true` — older clients render
 * unknown SSE payloads as raw text.
 */
export const sseSuggestionsEventSchema = z.object({
  type: z.literal("suggestions"),
  replies: z.array(z.string()).max(3),
});

export const sseCompleteEventSchema = z.object({
  type: z.literal("complete"),
  topic: z.string().optional(),
});

export const sseErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const sseEventSchema = z.discriminatedUnion("type", [
  sseIntentEventSchema,
  sseStatusEventSchema,
  sseGraphNodeEventSchema,
  sseToolStartEventSchema,
  sseToolDoneEventSchema,
  sseToolErrorEventSchema,
  sseTextStartEventSchema,
  sseTextEventSchema,
  sseTextDoneEventSchema,
  sseWorkoutStartEventSchema,
  sseWorkoutEventSchema,
  ssePlanEventSchema,
  sseEditPreviewEventSchema,
  sseSuggestionsEventSchema,
  sseCompleteEventSchema,
  sseErrorEventSchema,
]);

export type SSEEvent = z.infer<typeof sseEventSchema>;
