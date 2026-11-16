/**
 * Vision analysis for photo food logging ("Snap a Meal").
 *
 * Sends the (already client-compressed, ~1024px) meal JPEG to a vision-capable
 * OpenAI model and returns an itemized, structured estimate for the Plate
 * review card. See docs/PRD-photo-food-logging.md §6.4.
 *
 * Model policy (mini-first, same philosophy as chat):
 *   NUTRITION_VISION_MODEL       first-pass scans   (default gpt-5.4-mini)
 *   NUTRITION_VISION_FIX_MODEL   "Fix with a note"  (default gpt-5.4)
 * A fix means the mini already got it wrong once, and fix volume is small, so
 * escalating to the flagship tier is worth the pennies. The existing
 * NUTRITION_MODEL (gpt-4.1-mini) is text-only and can NOT be reused here.
 *
 * Cost accrues through the standard makeUsageTracker → record_ai_cost path;
 * image tokens fold into input_tokens, so the model_pricing rows added in
 * migration 20260719010000 are what keep scans counted against the free-tier
 * $0.10/day backstop and the premium $0.80/12h cap.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { makeUsageTracker } from "../agents/usageTracking";

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_VISION_FIX_MODEL = "gpt-5.4";

export function resolveVisionModel(kind: "scan" | "fix"): string {
    const env =
        kind === "fix"
            ? process.env.NUTRITION_VISION_FIX_MODEL
            : process.env.NUTRITION_VISION_MODEL;
    if (env && env.trim().length > 0) return env.trim();
    return kind === "fix" ? DEFAULT_VISION_FIX_MODEL : DEFAULT_VISION_MODEL;
}

// ── Structured output schema ────────────────────────────────────────────────

const photoItemSchema = z.object({
    name: z.string().min(1).max(80).describe("Food name, e.g. 'Grilled chicken breast'"),
    portion: z
        .string()
        .min(1)
        .max(40)
        .describe("Human-readable portion, e.g. '~150 g', '1 slice', '1 tbsp'"),
    grams: z.coerce.number().int().nonnegative().nullable().optional()
        .describe("Estimated weight in grams when applicable"),
    calories: z.coerce.number().int().nonnegative(),
    protein: z.coerce.number().int().nonnegative(),
    carbs: z.coerce.number().int().nonnegative(),
    fats: z.coerce.number().int().nonnegative(),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

const photoClarificationSchema = z.object({
    question: z.string().min(1).max(80),
    options: z
        .array(
            z.object({
                label: z.string().min(1).max(40),
                delta: z.object({
                    calories: z.coerce.number().int(),
                    protein: z.coerce.number().int(),
                    carbs: z.coerce.number().int(),
                    fats: z.coerce.number().int(),
                }),
            })
        )
        .min(2)
        .max(3),
});

const photoAnalysisSchema = z.object({
    photo_quality: z
        .enum(["ok", "no_food", "unclear"])
        .describe("'no_food' when no edible food is visible; 'unclear' when too blurry/dark to estimate"),
    meal_name: z
        .string()
        .max(60)
        .default("Meal")
        .describe("Short human meal name, e.g. 'Chicken & rice bowl'"),
    items: z.array(photoItemSchema).max(12).default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
    clarification: photoClarificationSchema.nullable().optional(),
    flags: z
        .object({
            packaged: z.boolean().default(false).describe("A packaged product with a readable label/barcode is the main subject"),
            blended: z.boolean().default(false).describe("Soup / smoothie / stew / casserole — contents not individually visible"),
            multi_plate: z.boolean().default(false).describe("Multiple plates or a shared table in frame"),
        })
        .default({ packaged: false, blended: false, multi_plate: false }),
});

export type MealPhotoItem = z.infer<typeof photoItemSchema>;
export type MealPhotoAnalysis = z.infer<typeof photoAnalysisSchema>;

// ── Model ───────────────────────────────────────────────────────────────────

const modelCache = new Map<string, unknown>();

function getVisionModel(modelName: string) {
    const cached = modelCache.get(modelName);
    if (cached) return cached as any;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ChatOpenAI } = require("@langchain/openai");
    // gpt-5 family / o-series are reasoning models: they reject `temperature`,
    // and benefit from a low reasoning effort here (structured estimation task;
    // latency target is p50 ≤ 6s). maxTokens maps to max_completion_tokens,
    // which includes reasoning tokens — keep generous headroom.
    const isReasoningModel = /^(gpt-5|o\d)/.test(modelName);
    const instance = new ChatOpenAI({
        model: modelName,
        apiKey: process.env.OPENAI_API_KEY,
        maxTokens: 4096,
        ...(isReasoningModel
            ? { reasoningEffort: "low" }
            : { temperature: 0 }),
    });
    modelCache.set(modelName, instance);
    return instance;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
    "You are a nutrition expert analyzing a photo of food. Identify each distinct food, estimate its portion, and estimate calories/macros per item using USDA standard database values. All macro values are non-negative integers.",
    "",
    "QUALITY GATE (first decision):",
    "  - No edible food in frame (desk, pet, selfie, screenshot of text…) → photo_quality='no_food', items=[]. Never invent food.",
    "  - Food probably present but the shot is too blurry/dark/cropped to estimate → photo_quality='unclear', items=[]. A wrong guess from bad pixels is worse than asking to retake.",
    "  - Otherwise photo_quality='ok'.",
    "",
    "PORTION ESTIMATION:",
    "  - Use objects in frame as scale references: plate/bowl diameter (~27 cm dinner plate), forks/spoons, hands, cans, glasses.",
    "  - When a LIDAR SCALE measurement is provided in the message, it is measured ground truth for physical size — derive the plate diameter and portion sizes from it and ignore assumed defaults.",
    "  - Portion sizes are systematically UNDER-estimated from photos. When torn between two plausible portion sizes, pick the larger.",
    "  - COOKING FAT RULE: for fried, pan-cooked, sautéed, or visibly glossy food, include a separate line item for cooking oil/butter (default ~1 tbsp, ~120 kcal, 14 g fat). Users can delete it in one swipe; silently omitting it is the #1 source of undercounting.",
    "  - Dressings, sauces, and spreads that are visible (or near-certain, e.g. mayo in a deli sandwich) get their own line item too.",
    "",
    "ITEMS:",
    "  - One item per distinct food. 1–8 items typical; never more than 12.",
    "  - `portion` is a short human string ('~150 g', '1 slice', '2 tbsp'); `grams` is your numeric weight estimate when meaningful.",
    "  - Opaque drinks (mugs, cups, dark glasses) you cannot identify: include as an item named 'Drink' with confidence='low' and a conservative estimate — the app asks the user to identify it.",
    "",
    "FLAGS:",
    "  - packaged=true when the main subject is a packaged product with a readable label or barcode (the app offers exact barcode scanning instead).",
    "  - blended=true for soups, smoothies, stews, casseroles — estimate anyway, but ALWAYS return a clarification asking about the base/ingredients.",
    "  - multi_plate=true when multiple plates or a shared table are in frame (the app reminds the user to remove food that isn't theirs).",
    "",
    "CONFIDENCE + CLARIFICATION (mirrors the app's text logger):",
    "  - Overall `confidence` is 'high' only for simple, clearly visible, well-scaled plates. Mixed dishes, hidden ingredients, or uncertain scale → 'medium' or 'low'.",
    "  - When confidence is NOT 'high', return ONE `clarification`: a short question with 2–3 tap options; each option's `delta` is the macro change to ADD to your base estimate if the user picks it (0s for the option matching what you already assumed). Pick the ambiguity that moves calories the most (cooking fat, hidden base, portion size).",
    "",
    "HONESTY BAR: aim for nutrition-label accuracy (±20%). Never return absurd values; sanity-check every item (a candy bar is not 27,000,000 kcal). Totals are computed by the app as the sum of items — do not include totals.",
].join("\n");

function buildUserContent(opts: AnalyzeMealPhotoOptions): unknown[] {
    const contextLines: string[] = [];
    if (opts.mealTimeOfDay) contextLines.push(`Meal time: ${opts.mealTimeOfDay}.`);
    if (opts.goalDirection) contextLines.push(`User's fitness goal: ${opts.goalDirection}.`);
    if (opts.caption && opts.caption.trim().length > 0) {
        contextLines.push(
            `USER'S NOTE ABOUT THIS MEAL (trust it over pixels when they conflict): "${opts.caption.trim()}"`
        );
    }
    if (opts.depth) {
        const distance = Math.round(opts.depth.subjectDistanceCm);
        const fieldWidth =
            opts.depth.fieldWidthCm != null ? Math.round(opts.depth.fieldWidthCm) : null;
        contextLines.push(
            `LIDAR SCALE (measured by the phone's depth sensor — trust these numbers over visual guessing): the camera was ~${distance} cm from the food.` +
                (fieldWidth
                    ? ` The full image width spans ~${fieldWidth} cm at the food's distance. Use this to compute the true size of the plate and each portion (e.g. a plate covering half the image width is ~${Math.round(fieldWidth / 2)} cm across) instead of assuming a standard plate size.`
                    : "")
        );
    }
    if (opts.fix) {
        contextLines.push(
            "",
            "This is a CORRECTION pass. Your previous analysis of this same photo was:",
            JSON.stringify(opts.fix.priorResult),
            `The user says what's off: "${opts.fix.note.trim()}"`,
            "Re-analyze the photo applying the user's correction. Keep items they didn't dispute stable; change what the note contradicts."
        );
    }
    contextLines.push("Analyze this meal photo.");

    return [
        { type: "text", text: contextLines.join("\n") },
        {
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${opts.imageBase64}`,
                // Portion estimation needs tiles; a 1024px image is ~765 tokens.
                detail: "high",
            },
        },
    ];
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface AnalyzeMealPhotoOptions {
    userId: string;
    /** Base64 JPEG (no data: prefix), already resized to ≤1024px longest side. */
    imageBase64: string;
    /** Optional user caption from the capture screen. */
    caption?: string | null;
    /** LiDAR scale measurement (iPhone Pro captures): real-world size ground truth. */
    depth?: { subjectDistanceCm: number; fieldWidthCm: number | null } | null;
    /** "Fix with a note" correction pass — escalates to the flagship model. */
    fix?: { priorResult: unknown; note: string } | null;
    /** e.g. "morning", "midday", "evening" — cheap accuracy context. */
    mealTimeOfDay?: string | null;
    /** e.g. "lose weight" / "build muscle" from the user's profile. */
    goalDirection?: string | null;
}

/**
 * Analyze a meal photo. Throws on model/transport failure (caller refunds the
 * quota count); returns a structured analysis otherwise — including the
 * no_food/unclear outcomes, which the caller also refunds.
 */
export async function analyzeMealPhoto(
    opts: AnalyzeMealPhotoOptions
): Promise<{ analysis: MealPhotoAnalysis; modelName: string }> {
    const modelName = resolveVisionModel(opts.fix ? "fix" : "scan");
    const model = getVisionModel(modelName);
    const structured = model.withStructuredOutput(photoAnalysisSchema, { strict: false });

    const analysis = (await structured.invoke(
        [
            new SystemMessage(SYSTEM_PROMPT),
            new HumanMessage({ content: buildUserContent(opts) as any }),
        ],
        { callbacks: [makeUsageTracker(opts.userId)] }
    )) as MealPhotoAnalysis;

    // Belt-and-braces: a usable analysis must have at least one item. An empty
    // "ok" result renders a blank Plate card, so treat it as unclear (refunded).
    if (analysis.photo_quality === "ok" && (!analysis.items || analysis.items.length === 0)) {
        analysis.photo_quality = "unclear";
    }

    return { analysis, modelName };
}
