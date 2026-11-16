/**
 * Exercise enrichment service.
 *
 * Two jobs, both fed by ONE cheap LLM call per exercise:
 *   1. Clean up equipment. The raw `exercises.equipment` column is dirty and
 *      ambiguous ("leverage machine", "weighted", "dumbbell, exercise ball").
 *      We derive `equipment_canonical` (a small filterable bucket) and
 *      `equipment_display` (a user-facing label disambiguated from the name,
 *      e.g. "Lever Chest Press" -> "Chest Press Machine").
 *   2. Generate biomechanics metadata (movement pattern, mechanics, force,
 *      unilateral, goal fit, joint-friendliness, aliases, plain summary) that
 *      the dataset lacks.
 *
 * The composer `buildExerciseEmbeddingText` then turns the raw fields + the
 * enrichment into a rich document we embed. This is the fix for the old
 * embeddings, which were built from name + muscle + equipment only (the
 * instructions branch in embeddings.ts was dead — `instructions` is a text[],
 * never a string, so it was always skipped, and `description` was never read).
 *
 * Provider: OpenAI `gpt-4.1-mini` with strict `response_format: json_schema`.
 * Same rationale as planner_batch in modelFactory.ts — strict server-side
 * schema enforcement means required fields can't be dropped, which matters
 * across a 1,300-row batch.
 */

// Canonical equipment buckets. Intentionally aligned with the onboarding
// `available_equipment` vocabulary so a workout filter can match canonical
// against what the user said they own.
export const EQUIPMENT_CANONICAL = [
    "dumbbell",
    "barbell",
    "ez barbell",
    "kettlebell",
    "cable",
    "machine",
    "smith machine",
    "band",
    "body weight",
    "ball",
    "bench",
    "cardio machine",
    "plate",
    "other",
] as const;
export type EquipmentCanonical = (typeof EQUIPMENT_CANONICAL)[number];

export const MOVEMENT_PATTERNS = [
    "horizontal_push",
    "horizontal_pull",
    "vertical_push",
    "vertical_pull",
    "squat",
    "hinge",
    "lunge",
    "carry",
    "rotation",
    "isolation",
    "core",
    "conditioning",
    "mobility",
] as const;

export interface ExerciseEnrichment {
    equipment_canonical: EquipmentCanonical;
    equipment_display: string;
    movement_pattern: (typeof MOVEMENT_PATTERNS)[number];
    mechanics: "compound" | "isolation";
    force: "push" | "pull" | "static" | "other";
    unilateral: boolean;
    primary_goal: "hypertrophy" | "strength" | "endurance" | "power" | "mobility" | "conditioning";
    joint_friendly: string[];
    aliases: string[];
    summary: string;
}

/** Raw exercise row shape needed for enrichment + embedding composition. */
export interface ExerciseRow {
    id: string;
    name: string;
    target_muscle?: string | null;
    body_part?: string | null;
    equipment?: string | null;
    secondary_muscles?: string[] | null;
    instructions?: string[] | null;
    description?: string | null;
    equipment_canonical?: string | null;
    equipment_display?: string | null;
    enrichment?: ExerciseEnrichment | null;
}

const ENRICHMENT_MODEL = process.env.ENRICHMENT_MODEL ?? "gpt-4.1-mini";

const RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        equipment_canonical: { type: "string", enum: [...EQUIPMENT_CANONICAL] },
        equipment_display: {
            type: "string",
            description:
                "Concise user-facing equipment label, disambiguated from the exercise name. " +
                'E.g. raw "leverage machine" + name "Lever Chest Press" -> "Chest Press Machine". ' +
                'For clear cases just title-case the canonical (e.g. "Dumbbell", "Barbell", "Bodyweight").',
        },
        movement_pattern: { type: "string", enum: [...MOVEMENT_PATTERNS] },
        mechanics: { type: "string", enum: ["compound", "isolation"] },
        force: { type: "string", enum: ["push", "pull", "static", "other"] },
        unilateral: { type: "boolean" },
        primary_goal: {
            type: "string",
            enum: ["hypertrophy", "strength", "endurance", "power", "mobility", "conditioning"],
        },
        joint_friendly: {
            type: "array",
            items: { type: "string" },
            description:
                'Short tags like "knee-friendly", "lower-back-friendly", "shoulder-friendly" when the movement is notably joint-sparing. Empty array if none apply.',
        },
        aliases: {
            type: "array",
            items: { type: "string" },
            description:
                "Common alternative names a user might say for this exercise (gym slang, abbreviations, regional names). 0-5 items.",
        },
        summary: {
            type: "string",
            description:
                "One plain-language sentence: what the movement trains and who/what it's good for.",
        },
    },
    required: [
        "equipment_canonical",
        "equipment_display",
        "movement_pattern",
        "mechanics",
        "force",
        "unilateral",
        "primary_goal",
        "joint_friendly",
        "aliases",
        "summary",
    ],
} as const;

const SYSTEM_PROMPT =
    "You are a strength & conditioning expert labeling a gym exercise database. " +
    "Given one exercise's raw fields, return clean, accurate metadata. Be precise and concise. " +
    "Disambiguate equipment using the exercise NAME (the raw equipment is often a vague bucket like " +
    '"leverage machine"). Never invent muscles the name/fields don\'t support.';

function buildUserPrompt(row: ExerciseRow): string {
    const lines = [
        `name: ${row.name}`,
        row.target_muscle ? `target_muscle: ${row.target_muscle}` : "",
        row.secondary_muscles?.length ? `secondary_muscles: ${row.secondary_muscles.join(", ")}` : "",
        row.body_part ? `body_part: ${row.body_part}` : "",
        row.equipment ? `raw_equipment: ${row.equipment}` : "",
        row.description ? `description: ${row.description}` : "",
        row.instructions?.length ? `instructions: ${row.instructions.slice(0, 4).join(" ")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
}

interface OpenAIChatResponse {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
}

/**
 * Enrich a single exercise via the LLM. Throws on hard failures so the caller
 * can decide whether to retry or skip — we never want to silently write a
 * partial/garbage enrichment.
 */
export async function enrichExercise(row: ExerciseRow): Promise<ExerciseEnrichment> {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("[enrichment] OPENAI_API_KEY is not set");
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: ENRICHMENT_MODEL,
            temperature: 0.2,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: buildUserPrompt(row) },
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name: "exercise_enrichment", strict: true, schema: RESPONSE_SCHEMA },
            },
        }),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`[enrichment] OpenAI ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as OpenAIChatResponse;
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error(`[enrichment] empty response for ${row.id} (${row.name})`);
    }
    const parsed = JSON.parse(content) as ExerciseEnrichment;
    // Defensive: enum is enforced server-side, but guard against drift.
    if (!EQUIPMENT_CANONICAL.includes(parsed.equipment_canonical)) {
        parsed.equipment_canonical = "other";
    }
    if (!parsed.equipment_display?.trim()) {
        parsed.equipment_display = titleCase(parsed.equipment_canonical);
    }
    parsed.joint_friendly = Array.isArray(parsed.joint_friendly) ? parsed.joint_friendly : [];
    parsed.aliases = Array.isArray(parsed.aliases) ? parsed.aliases : [];
    return parsed;
}

export function getEnrichmentModelName(): string {
    return ENRICHMENT_MODEL;
}

function titleCase(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Compose the document we embed. Uses enrichment when present and ALWAYS
 * includes description + joined instructions (the fields the old builder
 * silently dropped). Pure function — safe to import anywhere.
 */
export function buildExerciseEmbeddingText(row: ExerciseRow): string {
    const e = row.enrichment ?? null;
    const equip = row.equipment_display || e?.equipment_display || row.equipment || "";
    const canonical = row.equipment_canonical || e?.equipment_canonical || "";
    const instructions = Array.isArray(row.instructions) ? row.instructions.join(" ") : "";
    const secondary = Array.isArray(row.secondary_muscles) ? row.secondary_muscles.join(", ") : "";

    const parts = [
        row.name,
        equip ? `Equipment: ${equip}${canonical && canonical !== equip ? ` (${canonical})` : ""}.` : "",
        row.target_muscle ? `Primary muscle: ${row.target_muscle}.` : "",
        secondary ? `Secondary muscles: ${secondary}.` : "",
        row.body_part ? `Body part: ${row.body_part}.` : "",
        e
            ? [
                  `${e.movement_pattern.replace(/_/g, " ")}, ${e.mechanics}, ${e.force} movement` +
                      (e.unilateral ? ", unilateral" : "") + ".",
                  `Best for: ${e.primary_goal}.`,
                  e.joint_friendly.length ? `${e.joint_friendly.join(", ")}.` : "",
                  e.aliases.length ? `Also known as: ${e.aliases.join(", ")}.` : "",
                  e.summary,
              ]
                  .filter(Boolean)
                  .join(" ")
            : "",
        row.description ? row.description : "",
        instructions ? `Instructions: ${instructions}` : "",
    ];
    return parts.filter(Boolean).join("\n").trim();
}
