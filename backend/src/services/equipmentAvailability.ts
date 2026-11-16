/**
 * Equipment availability — single source of truth for "can the user actually
 * perform this exercise with the gear they said they have?".
 *
 * Why this exists: equipment filtering used to happen only at search time,
 * matching an exercise's equipment BUCKET (e.g. "dumbbell") against the user's
 * list. That leaks two whole classes of exercises the user cannot do:
 *
 *   1. Bucket mismatches on unfiltered fallback searches (any equipment).
 *   2. ACCESSORY requirements the bucket doesn't capture: "Dumbbell Bench
 *      Press" is bucket=dumbbell but needs a bench; "Pull-Up" is bucket=body
 *      weight but needs a bar. This is generalized here for every accessory,
 *      not special-cased per complaint.
 *
 * Every surface that selects exercises for a user (onboarding plan generation,
 * the allowed-exercise dictionary, chat workout builders, searches) should run
 * results through `filterByAvailableEquipment`.
 */

export interface EquipmentCheckable {
    name: string;
    equipment_canonical?: string | null;
    equipment?: string | null;
}

/**
 * Raw/legacy equipment strings → canonical buckets. Superset of what the
 * onboarding chips emit so profiles saved by older app versions still resolve.
 */
const RAW_TO_CANONICAL: Record<string, string> = {
    "body weight": "body weight",
    "bodyweight": "body weight",
    "body_weight": "body weight",
    "bodyweight only": "body weight",
    "no equipment": "body weight",
    "weighted": "body weight",
    "dumbbell": "dumbbell",
    "dumbbells": "dumbbell",
    "db": "dumbbell",
    "barbell": "barbell",
    "barbells": "barbell",
    "olympic barbell": "barbell",
    "trap bar": "barbell",
    "ez barbell": "ez barbell",
    "ez bar": "ez barbell",
    "ez-bar": "ez barbell",
    "ez curl bar": "ez barbell",
    "kettlebell": "kettlebell",
    "kettlebells": "kettlebell",
    "cable": "cable",
    "cables": "cable",
    "rope": "cable",
    "machine": "machine",
    "machines": "machine",
    "leverage machine": "machine",
    "assisted": "machine",
    "sled machine": "machine",
    "smith machine": "smith machine",
    "smith": "smith machine",
    "band": "band",
    "bands": "band",
    "resistance band": "band",
    "resistance bands": "band",
    "resistance_band": "band",
    "ball": "ball",
    "exercise ball": "ball",
    "stability ball": "ball",
    "medicine ball": "ball",
    "bosu ball": "ball",
    "swiss ball": "ball",
    "bench": "bench",
    "pull-up bar": "pull-up bar",
    "pull up bar": "pull-up bar",
    "chin-up bar": "pull-up bar",
};

/**
 * Accessory requirements a bucket check can't see. Each rule names the gear,
 * which owned buckets satisfy it, and how to detect the requirement from the
 * exercise name.
 */
const ACCESSORY_RULES: Array<{
    accessory: string;
    satisfiedBy: string[];
    requires: RegExp;
    /** Name patterns that look like matches but do NOT need the accessory. */
    exempt?: RegExp;
}> = [
    {
        accessory: "bench",
        satisfiedBy: ["bench"],
        // Bench lifts, incline/decline lifts, preacher work, roman-chair
        // hyperextensions. A gym "machine" bucket does NOT satisfy this —
        // the moves below need an actual bench.
        requires: /\bbench\b|\bincline\b|\bdecline\b|\bpreacher\b|\bhyperextension\b|\bchest[- ]supported\b/i,
        // Elevated bodyweight moves work off any surface (stairs, couch).
        exempt: /push[- ]?up|plank|mountain climber|step[- ]?up|pike/i,
    },
    {
        accessory: "pull-up bar",
        satisfiedBy: ["pull-up bar"],
        requires: /\bpull[- ]?up\b|\bpullup\b|\bchin[- ]?up\b|\bchinup\b|\bmuscle[- ]?up\b|\bhanging\b|\btoes[- ]to[- ]bar\b|\bdead hang\b/i,
        // Pulldowns/pullovers are cable/machine moves, not bar hangs.
        exempt: /pull[- ]?down|pullover|band|lat pulldown/i,
    },
];

/** Buckets that can't be resolved to real gear ("other", "cardio machine"…). */
const GYM_ONLY_FALLBACK_BUCKETS = new Set(["other", "cardio machine", "plate"]);

export function normalizeEquipmentToken(raw: string): string | null {
    const s = String(raw ?? "").trim().toLowerCase();
    if (!s) return null;
    return RAW_TO_CANONICAL[s] ?? s;
}

/** User's available equipment → canonical bucket set. Bodyweight is always in. */
export function toAvailableBuckets(available: string[] | null | undefined): Set<string> {
    const out = new Set<string>(["body weight"]);
    for (const raw of available ?? []) {
        const bucket = normalizeEquipmentToken(raw);
        if (bucket) out.add(bucket);
    }
    return out;
}

function exerciseBucket(ex: EquipmentCheckable): string {
    const canonical = normalizeEquipmentToken(ex.equipment_canonical ?? "");
    if (canonical) return canonical;
    return normalizeEquipmentToken(ex.equipment ?? "") ?? "body weight";
}

/**
 * Can the user perform this exercise with the buckets they own?
 * Checks the equipment bucket first, then accessory requirements by name.
 */
export function isExerciseAvailable(ex: EquipmentCheckable, buckets: Set<string>): boolean {
    const bucket = exerciseBucket(ex);

    if (!buckets.has(bucket)) {
        // Unknown/unresolvable buckets are treated as gym-only gear: allow them
        // only for users who own machines (the "full gym" signal). Excluding is
        // the safe direction — recommending gear the user doesn't own is the
        // trust-killer this module exists to prevent.
        const gymish = GYM_ONLY_FALLBACK_BUCKETS.has(bucket) || !RAW_TO_CANONICAL[bucket];
        if (!(gymish && buckets.has("machine"))) return false;
    }

    const name = ex.name ?? "";
    for (const rule of ACCESSORY_RULES) {
        if (rule.satisfiedBy.some((b) => buckets.has(b))) continue;
        if (!rule.requires.test(name)) continue;
        if (rule.exempt && rule.exempt.test(name)) continue;
        return false;
    }
    return true;
}

/**
 * Filter a result set down to what the user can actually perform.
 * `available` empty/null → no filtering (legacy profiles with no equipment
 * saved keep their previous behavior).
 */
export function filterByAvailableEquipment<T extends EquipmentCheckable>(
    exercises: T[],
    available: string[] | null | undefined
): T[] {
    if (!available || available.length === 0) return exercises;
    const buckets = toAvailableBuckets(available);
    return exercises.filter((ex) => isExerciseAvailable(ex, buckets));
}
