/**
 * Injury-aware exercise handling, shared by the onboarding planner and the
 * chat workout tools.
 *
 * Three cooperating layers (filtering alone is NOT enough — a user who never
 * sees any acknowledgment of their injury assumes the AI ignored it):
 *
 *  1. HARD EXCLUSIONS — movements that are clearly contraindicated for a
 *     reported issue are removed from every selection pool.
 *  2. PROMPT PROTOCOL — `buildInjuryPromptBlock` gives the generating LLM
 *     explicit instructions to program around the injury and to attach a
 *     short user-facing modification cue (`injury_note`) to any exercise
 *     that loads the affected area.
 *  3. SURFACING — callers persist `injury_note` onto exercises so the app
 *     can show the user WHY a movement is safe / how to modify it.
 */

export interface InjuryRule {
    /** Matches the user's free-text injury description. */
    detect: RegExp;
    /** Exercise-name substrings that are hard-excluded. */
    blockedNamePatterns: string[];
    /** Human label used in prompts and notes. */
    label: string;
    /** Default modification guidance handed to the LLM for non-excluded work. */
    guidance: string;
}

export const INJURY_RULES: InjuryRule[] = [
    {
        label: "shoulder",
        detect: /shoulder|rotator|labrum|imping/i,
        blockedNamePatterns: [
            "overhead press", "military press", "push press", "arnold press",
            "behind neck", "behind-the-neck", "handstand", "upright row",
            "snatch", "jerk", "muscle-up", "muscle up", "dip",
        ],
        guidance:
            "Keep pressing below shoulder height, prefer neutral-grip and supported variants, and cue stopping short of any pinching.",
    },
    {
        label: "knee",
        detect: /knee|acl|mcl|meniscus|patell/i,
        blockedNamePatterns: [
            "lunge", "jump", "box jump", "pistol squat", "deep squat",
            "leg extension", "sissy squat", "depth jump", "broad jump", "plyo",
        ],
        guidance:
            "Limit squat depth to pain-free range, prefer hip-dominant and supported variants, and avoid ballistic knee loading.",
    },
    {
        label: "lower back",
        detect: /lower back|lumbar|sciatic|herniat|\bdisc\b/i,
        blockedNamePatterns: [
            "deadlift", "good morning", "hyperextension", "back extension",
            "twist", "rotation", "russian twist", "wood chop", "landmine 180",
            "superman", "jefferson",
        ],
        guidance:
            "Keep the spine neutral, prefer supported hip hinges (glute bridge, hip thrust) and brace hard; no loaded spinal flexion or rotation.",
    },
    {
        label: "wrist",
        detect: /wrist|carpal/i,
        blockedNamePatterns: [
            "push-up", "push up", "pushup", "plank", "handstand", "front rack", "burpee",
        ],
        guidance:
            "Prefer neutral-wrist grips, dumbbells over barbells, and forearm-supported positions over palms-flat loading.",
    },
    {
        label: "elbow",
        detect: /elbow|tennis|golfer/i,
        blockedNamePatterns: [
            "dip", "close grip", "skull crusher", "overhead extension", "preacher",
        ],
        guidance:
            "Use lighter loads with strict tempo on arm work, prefer cable/band tension over heavy free-weight elbow extension.",
    },
    {
        label: "ankle",
        detect: /ankle|achilles/i,
        blockedNamePatterns: ["jump", "box jump", "plyo", "sprint", "broad jump"],
        guidance:
            "Avoid ballistic/impact loading; keep heels supported on squats and prefer seated calf work in pain-free range.",
    },
];

/** Rules matching the user's free-text injuries (empty when none). */
export function matchInjuryRules(injuries: string | null | undefined): InjuryRule[] {
    const s = (injuries ?? "").trim().toLowerCase();
    if (!s) return [];
    return INJURY_RULES.filter((rule) => rule.detect.test(s));
}

/** Flat list of blocked name patterns for the user's injuries. */
export function getInjuryRestrictionPatterns(injuries: string | null | undefined): string[] {
    const patterns = matchInjuryRules(injuries).flatMap((r) => r.blockedNamePatterns);
    return [...new Set(patterns)];
}

/** Remove hard-contraindicated exercises for the user's reported injuries. */
export function filterExercisesByInjury<T extends { name: string }>(
    exercises: T[],
    injuries: string | null | undefined
): T[] {
    const restricted = getInjuryRestrictionPatterns(injuries);
    if (restricted.length === 0) return exercises;
    return exercises.filter((ex) => {
        const nameLower = (ex.name ?? "").toLowerCase();
        const blocked = restricted.some((p) => nameLower.includes(p));
        if (blocked) {
            console.log(`[INJURY] Filtering: ${ex.name} (${injuries})`);
        }
        return !blocked;
    });
}

/**
 * Prompt block for plan/workout generation. Returns "" when the user has no
 * reported injuries so callers can interpolate it unconditionally.
 */
export function buildInjuryPromptBlock(injuries: string | null | undefined): string {
    const rules = matchInjuryRules(injuries);
    const raw = (injuries ?? "").trim();
    if (!raw) return "";

    const perArea =
        rules.length > 0
            ? rules
                  .map((r) => `- ${r.label.toUpperCase()}: ${r.guidance}`)
                  .join("\n")
            : `- Use your judgment for: "${raw}". Prefer joint-friendly, supported, pain-free-range variants.`;

    return `INJURY PROTOCOL — the user reported: "${raw}". This is a safety requirement, not a preference.
Clearly contraindicated movements were already removed from the dictionary. For what remains:
${perArea}
For EVERY exercise that loads or borders an affected area, you MUST set \`injury_note\` to ONE short, user-facing modification cue (max ~15 words, e.g. "Shoulder-friendly: press below shoulder height, stop shy of any pinch."). Set \`injury_note\` to null for exercises unrelated to the injury. Never leave the user guessing whether their injury was considered.`;
}
