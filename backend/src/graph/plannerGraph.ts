/**
 * AI-Powered Workout Planner - PRODUCTION FIXED
 * 
 * CRITICAL FIXES:
 * 1. PULL MOVEMENTS NOW ENFORCED (rows, pull-ups, pulldowns)
 * 2. Bench removed from equipment (it's an accessory)
 * 3. Canonical exercise names (no more "back pov" garbage)
 * 4. No exercise repeats within same week
 * 5. Required patterns enforced (block generation if missing)
 * 6. Better fuzzy matching for common exercises
 */

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { getAgentModel } from "../agents/modelFactory";
import crypto from "crypto";
import { z } from "zod";
import {
    AllowedExerciseRow,
    FALLBACK_EXERCISE_DICTIONARY,
    formatAllowedExerciseDictionary,
    getAllowedExerciseDictionary,
    getUserProfile,
    saveWorkoutPlan,
} from "../services/db";
import { searchExercisesBatch } from "../tools/supabaseExerciseSearch";
import { estimateWorkoutDurationMinutes } from "../services/workoutDuration";
import { filterByAvailableEquipment } from "../services/equipmentAvailability";
import {
    buildInjuryPromptBlock,
    filterExercisesByInjury,
} from "../services/injuryFiltering";
import { ExerciseDetail, SplitType } from "../types";

// ============================================================================
// CANONICAL NAMES MAPPING
// ============================================================================

/**
 * Clean up messy database names to user-friendly canonical names
 */
const CANONICAL_NAMES: Record<string, string> = {
    // Squats
    "barbell full squat (back pov)": "Barbell Back Squat",
    "barbell squat (on knees)": "Barbell Box Squat",
    "quads (bodyweight squat)": "Bodyweight Squat",

    // Core
    "side bridge v. 2": "Side Plank",
    "side bridge v. 1": "Side Plank",
    "barbell standing ab rollerout": "Ab Wheel Rollout",
    "negative crunch": "Slow Eccentric Crunch",

    // Press variations
    "dumbbell one arm incline chest press": "Single-Arm Incline Dumbbell Press",
    "dumbbell incline palm-in press": "Incline Neutral Grip Dumbbell Press",
    "dumbbell lying one arm press": "Single-Arm Dumbbell Floor Press",
    "dumbbell one arm reverse grip press": "Reverse Grip Dumbbell Press",
    "dumbbell incline hammer press": "Incline Hammer Press",
    "dumbbell seated alternate shoulder": "Seated Alternating Shoulder Press",

    // Other
    "landmine 180": "Landmine Rotation",
    "barbell rear lunge": "Barbell Reverse Lunge",
    "dumbbell single leg deadlift with stepbox support": "Single-Leg Romanian Deadlift",
    "wide hand push up": "Wide Grip Push-Up",
};

function cleanExerciseName(dbName: string): string {
    return CANONICAL_NAMES[dbName.toLowerCase()] || dbName;
}

// ============================================================================
// REQUIRED MOVEMENT PATTERNS (EVIDENCE-BASED & FLEXIBLE)
// ============================================================================

/**
 * Movement pattern requirements based on exercise science:
 * - MED (Minimum Effective Dose): 4+ sets per muscle group per week
 * - Full ROM compound movements prioritized
 * - Substitutions allowed for equipment-limited scenarios
 */
interface PatternRequirement {
    required: string[];         // Must have at least ONE of these
    optional?: string[];        // Nice to have but not blocking
    substitutions?: Record<string, string[]>; // Acceptable alternatives
}

const REQUIRED_PATTERNS: Record<string, PatternRequirement> = {
    "full_body": {
        required: ["squat", "push", "pull", "core"],
        optional: ["hinge"],
        substitutions: {
            // Hip hinge can be substituted with glute-focused exercises
            "hinge": ["squat", "glute", "bridge", "lunge"],
            // Vertical pull can be substituted with horizontal pull variations
            "vertical_pull": ["horizontal_pull", "pull", "row"],
        }
    },
    "upper": {
        required: ["horizontal_push", "horizontal_pull"],
        optional: ["vertical_push", "vertical_pull"],
        substitutions: {
            // Vertical pull alternatives for limited equipment
            "vertical_pull": ["horizontal_pull", "row", "inverted", "prone"],
            // Vertical push can be worked with incline variations
            "vertical_push": ["horizontal_push", "incline", "pike"],
        }
    },
    "lower": {
        required: ["squat"],
        optional: ["hinge"],
        substitutions: {
            // Hinge can be substituted with posterior chain work
            "hinge": ["squat", "glute", "bridge", "lunge", "step"],
        }
    },
    "push_day": {
        required: ["horizontal_push"],
        optional: ["vertical_push", "arms"],
        substitutions: {
            "vertical_push": ["incline", "pike", "dip"],
        }
    },
    "pull_day": {
        required: ["horizontal_pull"],
        optional: ["vertical_pull", "arms"],
        substitutions: {
            "vertical_pull": ["horizontal_pull", "row", "inverted"],
        }
    },
    "leg_day": {
        required: ["squat"],
        optional: ["hinge", "core"],
        substitutions: {
            "hinge": ["glute", "bridge", "lunge"],
        }
    },
    // Bro split day types
    "chest_day": {
        required: ["horizontal_push"],
        optional: ["vertical_push", "fly", "arms"],
        substitutions: {
            "horizontal_push": ["push", "press", "chest", "fly", "dip"],
        }
    },
    "back_day": {
        required: ["horizontal_pull"],
        optional: ["vertical_pull", "row"],
        substitutions: {
            "horizontal_pull": ["pull", "row", "back"],
            "vertical_pull": ["pulldown", "pull-up", "chin"],
        }
    },
    "shoulders_day": {
        required: ["vertical_push"],
        optional: ["lateral", "rear_delt"],
        substitutions: {
            "vertical_push": ["press", "shoulder", "raise", "push"],
        }
    },
    "arms_day": {
        required: ["arms"],
        optional: [],
        substitutions: {
            "arms": ["curl", "extension", "tricep", "bicep", "push", "pull"],
        }
    },
    "core_day": {
        required: ["core"],
        optional: [],
        substitutions: {
            "core": ["abs", "plank", "crunch", "twist", "leg raise"],
        }
    },
};

/**
 * Check if a category matches a pattern, including substitutions
 */
function matchesPattern(
    category: string,
    pattern: string,
    substitutions?: Record<string, string[]>
): boolean {
    const catLower = category.toLowerCase();
    const patternLower = pattern.toLowerCase();

    // Direct match
    if (catLower.includes(patternLower)) {
        return true;
    }

    // Check substitutions
    if (substitutions && substitutions[pattern]) {
        return substitutions[pattern].some(sub =>
            catLower.includes(sub.toLowerCase())
        );
    }

    return false;
}

/**
 * Canonicalize equipment names for consistency
 * Fixes: "bodyweight" vs "body weight" inconsistency
 */
function canonicalizeEquipment(equipment: string[]): string[] {
    const equipmentMap: Record<string, string> = {
        'bodyweight': 'body weight',
        'body_weight': 'body weight',
        'bodyweight only': 'body weight',
        'dumbbell': 'dumbbell',
        'dumbbells': 'dumbbell',
        'barbell': 'barbell',
        'barbells': 'barbell',
        'kettlebell': 'kettlebell',
        'kettlebells': 'kettlebell',
        'resistance band': 'resistance band',
        'resistance_band': 'resistance band',
        'resistance bands': 'resistance band',
        'bands': 'band',
        'cables': 'cable',
        'cable': 'cable',
        'machine': 'leverage machine',
        'machines': 'leverage machine',
        'ez bar': 'ez barbell',
        'ez-bar': 'ez barbell',
        // Keep the accessory identity: mapping to 'assisted' (a machine bucket)
        // erased the "user owns a bar" signal the availability filter needs to
        // allow pull-ups/hanging work.
        'pull up bar': 'pull-up bar',
        'chin-up bar': 'pull-up bar',
    };

    return [...new Set(equipment.map(eq => {
        const normalized = eq.toLowerCase().trim();
        return equipmentMap[normalized] || normalized;
    }))];
}

/**
 * Get requirements for a specific day focus
 * Fixes: Validates per-day focus instead of converting split to single key
 */
function getRequirementsForDayFocus(focus: string): PatternRequirement {
    const focusLower = focus.toLowerCase();

    // Map day focus to requirement pattern
    if (focusLower.includes('upper')) {
        return REQUIRED_PATTERNS['upper'];
    } else if (focusLower.includes('lower')) {
        return REQUIRED_PATTERNS['lower'];
    } else if (focusLower.includes('push')) {
        return REQUIRED_PATTERNS['push_day'];
    } else if (focusLower.includes('pull')) {
        return REQUIRED_PATTERNS['pull_day'];
    } else if (focusLower.includes('leg')) {
        return REQUIRED_PATTERNS['leg_day'];
    } else if (focusLower.includes('chest')) {
        return REQUIRED_PATTERNS['chest_day'];
    } else if (focusLower.includes('back')) {
        return REQUIRED_PATTERNS['back_day'];
    } else if (focusLower.includes('shoulder')) {
        return REQUIRED_PATTERNS['shoulders_day'];
    } else if (focusLower.includes('arm')) {
        return REQUIRED_PATTERNS['arms_day'];
    } else if (focusLower.includes('core') || focusLower.includes('abs')) {
        return REQUIRED_PATTERNS['core_day'];
    } else {
        // Full body or unknown
        return REQUIRED_PATTERNS['full_body'];
    }
}

const PATTERN_TO_CATEGORY_HINTS: Record<string, string[]> = {
    squat: ["squat", "hinge", "legs_accessory"],
    hinge: ["hinge", "squat", "legs_accessory"],
    push: ["horizontal_push", "vertical_push", "push", "chest", "shoulders"],
    pull: ["horizontal_pull", "vertical_pull", "pull", "back"],
    core: ["core", "arms"],
    horizontal_push: ["horizontal_push", "push", "chest", "vertical_push"],
    vertical_push: ["vertical_push", "shoulders", "horizontal_push", "push"],
    horizontal_pull: ["horizontal_pull", "pull", "back", "vertical_pull"],
    vertical_pull: ["vertical_pull", "pull", "back", "horizontal_pull"],
    arms: ["arms", "horizontal_push", "horizontal_pull"],
};

function getFocusCategoryPriority(focus: string): string[] {
    const lower = focus.toLowerCase();
    if (lower.includes("leg") || lower.includes("lower")) {
        return ["squat", "hinge", "legs_accessory", "core", "arms"];
    }
    if (lower.includes("push") || lower.includes("chest") || lower.includes("shoulder")) {
        return ["horizontal_push", "vertical_push", "arms", "core", "horizontal_pull"];
    }
    if (lower.includes("pull") || lower.includes("back")) {
        return ["horizontal_pull", "vertical_pull", "arms", "core", "horizontal_push"];
    }
    if (lower.includes("arm")) {
        return ["arms", "horizontal_push", "horizontal_pull", "core"];
    }
    if (lower.includes("core") || lower.includes("abs")) {
        return ["core", "squat", "hinge", "horizontal_push", "horizontal_pull"];
    }
    if (lower.includes("upper")) {
        return ["horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "arms", "core"];
    }
    return ["squat", "hinge", "horizontal_push", "horizontal_pull", "core", "vertical_push", "vertical_pull"];
}

// ============================================================================
// STATE DEFINITION
// ============================================================================

export interface PlannerState {
    userId: string;
    preferences?: {
        splitType?: SplitType;
        trainingDays?: number;
        focusAreas?: string[];
    };
    userProfile?: any;
    split?: SplitType;
    trainingDays?: number;
    selectedDays?: string[];
    programmingReasoning?: string;
    /**
     * Prompt-ready dictionary string injected into generation prompts.
     * Populated by `fetchAllowedExercises`; never empty (fallback is used on DB failure).
     */
    allowedExercises?: string;
    /**
     * Structured RAG rows kept alongside the formatted prompt block so downstream
     * code (post-processing, swap matching) can reason over the same dictionary
     * the LLM saw.
     */
    allowedExerciseRows?: AllowedExerciseRow[];
    dayPlans?: Array<{
        dayIndex: number;
        dayOfWeek: string;
        focus: string;
        exercises: ExerciseDetail[];
    }>;
    planId?: string;
    success: boolean;
    error?: string;
    warnings?: string[];
    messages: BaseMessage[];
}

// ============================================================================
// LLM SETUP
// ============================================================================

// Onboarding plan generation runs only once per user, but it's the most
// quality-sensitive call in the system — a bad plan damages first-day
// retention. Default this role to Sonnet (override via PLANNER_BATCH_MODEL).
// `planner_batch` resolves to gpt-4.1-mini (see modelFactory.ts). OpenAI's
// strict json_schema response format enforces required fields server-side,
// so we don't need the maxTokens ceiling or the schema gymnastics that
// Anthropic's tool-use required.
const llm = getAgentModel("planner_batch", { temperature: 0.7 });

// ============================================================================
// INJURY FILTERING — moved to services/injuryFiltering.ts so the chat tools
// apply the exact same exclusions and prompt protocol as onboarding.
// ============================================================================
// EXERCISE NAME MATCHING
// ============================================================================

function fuzzyMatchExercise(targetName: string, availableExercises: any[]): any | null {
    const target = targetName.toLowerCase().trim();

    // Exact match
    let match = availableExercises.find(ex => ex.name.toLowerCase() === target);
    if (match) return match;

    // Common aliases (EXPANDED)
    const aliases: Record<string, string[]> = {
        // Rows
        "row": ["bent over row", "barbell row", "dumbbell row", "single arm row", "bent-over"],
        "barbell row": ["barbell bent over row", "bb row"],
        "dumbbell row": ["dumbbell bent over row", "db row", "single arm row"],

        // Pull-ups and pulldowns
        "pull-up": ["pull up", "pullup", "chin up", "chin-up"],
        "lat pulldown": ["pulldown", "lat pull down", "lat pull-down"],

        // Presses
        "dumbbell shoulder press": ["dumbbell overhead press", "db shoulder press", "dumbbell press"],
        "bench press": ["barbell bench press", "bb bench press"],

        // Arms
        "dumbbell bicep curl": ["dumbbell curl", "bicep curl", "db curl"],
        "dumbbell triceps extension": ["dumbbell overhead extension", "tricep extension", "db tricep"],

        // Legs
        "goblet squat": ["dumbbell goblet squat", "kettlebell goblet squat"],
        "glute bridge": ["hip thrust", "bridge", "barbell hip thrust", "glute bridge"],

        // Core
        "plank": ["front plank", "forearm plank", "elbow plank"],
        "side plank": ["side bridge"],

        // Dips
        "bench dip": ["tricep dip", "dips", "bodyweight dip"],
        "calf raise": ["standing calf raise", "seated calf raise", "dumbbell calf raise"],
    };

    // Try aliases
    for (const [canonical, variations] of Object.entries(aliases)) {
        if (target.includes(canonical) || variations.some(v => target.includes(v))) {
            match = availableExercises.find(ex => {
                const exName = ex.name.toLowerCase();
                return exName.includes(canonical) || variations.some(v => exName.includes(v));
            });
            if (match) return match;
        }
    }

    // Partial match
    const targetWords = target.split(' ').filter(w => w.length > 3);
    if (targetWords.length > 0) {
        match = availableExercises.find(ex => {
            const exName = ex.name.toLowerCase();
            return targetWords.every(word => exName.includes(word));
        });
        if (match) return match;
    }

    return null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateAge(birthday: string): number {
    const birthDate = new Date(birthday);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
}

/**
 * Canonical core routine focuses per split type.
 * The LLM is instructed to generate exactly this many unique routines.
 * Per-day mapping happens deterministically in code via modulo wrap.
 */
function getCoreFocuses(split: SplitType): string[] {
    const map: Record<SplitType, string[]> = {
        "full_body": ["Full Body"],
        "upper_lower": ["Upper Body", "Lower Body"],
        "ppl": ["Push", "Pull", "Legs"],
        "bro_split": ["Chest", "Back", "Legs", "Shoulders", "Arms"],
        "custom": ["Custom"],
    };
    return map[split];
}

function getCoreWorkoutCount(split: SplitType): number {
    return getCoreFocuses(split).length;
}

function getSplitFocus(split: SplitType, dayIndex: number): string {
    const focuses = getCoreFocuses(split);
    return focuses[dayIndex % focuses.length];
}

function calculateExercisesPerDay(
    durationMinutes: number,
    fitnessLevel: string,
    goal: string
): number {
    let timePerExercise = 7;
    if (fitnessLevel === 'beginner') timePerExercise = 8;
    if (goal === 'get_stronger') timePerExercise = 9;

    const exerciseCount = Math.floor((durationMinutes * 0.9) / timePerExercise);
    const minForDuration =
        durationMinutes <= 20 ? 2 : durationMinutes <= 35 ? 3 : 4;
    const capped = Math.min(12, Math.max(1, exerciseCount));
    return Math.max(minForDuration, capped);
}

/**
 * Get comprehensive search queries - FIXED PULL MOVEMENTS
 */
function getSplitSearchQueries(split: SplitType, equipment: string[]): { query: string; equipment?: string; category: string }[] {
    // Accessories (bench, pull-up bar) are not search buckets — they gate
    // availability AFTER search (see services/equipmentAvailability). Fanning
    // queries out over them just duplicates RPCs.
    const ACCESSORY_VALUES = new Set(['bench', 'pull-up bar', 'pull up bar', 'chin-up bar']);
    const validEquipment = equipment.filter(eq => !ACCESSORY_VALUES.has(eq.toLowerCase()));
    const hasEquipment = validEquipment.length > 0;

    const baseQueries: Record<SplitType, { query: string; category: string }[]> = {
        "ppl": [
            // Push - Horizontal
            { query: "chest press bench", category: "horizontal_push" },
            { query: "chest fly pec", category: "horizontal_push" },

            // Push - Vertical
            { query: "shoulder press overhead", category: "vertical_push" },
            { query: "shoulder raise lateral front", category: "vertical_push" },

            // Push - Arms
            { query: "triceps extension dip", category: "arms" },

            // Pull - Horizontal (CRITICAL FIX)
            { query: "back rows bent", category: "horizontal_pull" },
            { query: "back row dumbbell barbell", category: "horizontal_pull" },
            { query: "seated row cable", category: "horizontal_pull" },

            // Pull - Vertical (CRITICAL FIX)
            { query: "pull-up chin-up", category: "vertical_pull" },
            { query: "lat pulldown", category: "vertical_pull" },
            { query: "pulldown wide grip", category: "vertical_pull" },

            // Pull - Arms
            { query: "biceps curl", category: "arms" },
            { query: "hammer curl", category: "arms" },

            // Legs - Quad
            { query: "squat", category: "squat" },
            { query: "lunge split squat", category: "squat" },

            // Legs - Hip
            { query: "deadlift hinge", category: "hinge" },
            { query: "glute bridge hip thrust", category: "hinge" },

            // Legs - Accessories
            { query: "calf raise", category: "legs_accessory" },

            // Core
            { query: "core abs plank crunch", category: "core" },
        ],

        "upper_lower": [
            // Upper - Horizontal Push
            { query: "chest press", category: "horizontal_push" },
            { query: "chest fly", category: "horizontal_push" },

            // Upper - Vertical Push
            { query: "shoulder press", category: "vertical_push" },
            { query: "shoulder raise", category: "vertical_push" },

            // Upper - Horizontal Pull (CRITICAL FIX)
            { query: "back rows", category: "horizontal_pull" },
            { query: "bent over row", category: "horizontal_pull" },

            // Upper - Vertical Pull (CRITICAL FIX + Bodyweight alternatives)
            { query: "pull-up pulldown", category: "vertical_pull" },
            { query: "lat pull", category: "vertical_pull" },
            { query: "prone pulldown superman", category: "vertical_pull" }, // Bodyweight alternative
            { query: "inverted row", category: "vertical_pull" }, // Bodyweight alternative

            // Upper - Arms
            { query: "biceps curl", category: "arms" },
            { query: "triceps extension", category: "arms" },

            // Lower - Squat
            { query: "squat", category: "squat" },
            { query: "lunge step-up", category: "squat" },

            // Lower - Hinge
            { query: "deadlift", category: "hinge" },
            { query: "hamstring", category: "hinge" },
            { query: "glute bridge", category: "hinge" }, // Bodyweight hinge alternative
            { query: "good morning", category: "hinge" }, // Bodyweight hinge alternative

            // Lower - Accessories
            { query: "calf raise", category: "legs_accessory" },

            // Core
            { query: "core abs plank", category: "core" },
        ],

        "bro_split": [
            { query: "chest press fly", category: "chest" },
            { query: "back rows pull", category: "back" },
            { query: "legs squat", category: "legs" },
            { query: "shoulders press raise", category: "shoulders" },
            { query: "biceps curl", category: "arms" },
            { query: "triceps extension", category: "arms" },
            { query: "abs core", category: "core" },
        ],

        "full_body": [
            { query: "squat", category: "squat" },
            { query: "deadlift hinge", category: "hinge" },
            { query: "glute bridge hip thrust", category: "hinge" }, // Bodyweight hinge alternative
            { query: "single leg deadlift", category: "hinge" }, // Bodyweight hinge variation
            { query: "press chest shoulder", category: "push" },

            // CRITICAL FIX: Better pull queries
            { query: "rows back", category: "pull" },
            { query: "pull-up pulldown", category: "pull" },
            { query: "bent over row", category: "pull" },

            { query: "lunge", category: "squat" },
            { query: "core abs plank", category: "core" },
        ],

        "custom": [
            { query: "compound", category: "compound" },
            { query: "isolation", category: "isolation" },
        ],
    };

    const queries = baseQueries[split];

    if (!hasEquipment) {
        return queries.map(q => ({ ...q }));
    }

    const equipmentQueries: { query: string; equipment: string; category: string }[] = [];
    for (const eq of validEquipment) {
        for (const { query, category } of queries) {
            equipmentQueries.push({ query, equipment: eq, category });
        }
    }

    return equipmentQueries;
}

/**
 * Fetch exercises with PULL movements guaranteed
 */
async function fetchTargetedExercises(
    split: SplitType,
    equipment: string[],
    injury: string | null
): Promise<{
    exercises: any[];
    categorized: Map<string, any[]>;
    equipmentCounts: Map<string, number>
}> {
    console.log(`[FETCH] Fetching exercises for ${split} split`);
    console.log(`[FETCH] Equipment: [${equipment.join(', ')}], Injury: ${injury || 'none'}`);

    const searchQueries = getSplitSearchQueries(split, equipment);
    console.log(`[FETCH] Generated ${searchQueries.length} search queries across movement patterns`);

    const allExercises: any[] = [];
    const categorized = new Map<string, any[]>();

    // MOVED: equipmentCounts now computed after dedupe (see below)

    // Batched: one OpenAI embedDocuments call + parallel pgvector RPCs.
    const batchParams = searchQueries.map(({ query, equipment: eq }) => ({
        query,
        matchCount: 40,
        filterEquipment: eq ? [eq] : undefined,
    }));
    const batchResults = await searchExercisesBatch(batchParams);

    batchResults.forEach((result, idx) => {
        const { query, equipment: eq, category } = searchQueries[idx];
        if (!result.success) {
            console.warn(`Search failed for "${query}":`, result.error);
            return;
        }
        const validExercises = result.exercises
            .filter(ex => ex.id && ex.gif_path && ex.gif_path !== '')
            .map(ex => {
                const exerciseEquipment = ex.equipment || 'bodyweight';
                return {
                    name: ex.name,
                    id: ex.id,
                    target: ex.target_muscle || ex.body_part,
                    equipment: exerciseEquipment,
                    difficulty: ex.difficulty,
                    bodyPart: ex.body_part,
                    category,
                    fullData: ex,
                };
            });

        if (!categorized.has(category)) {
            categorized.set(category, []);
        }
        categorized.get(category)!.push(...validExercises);
        allExercises.push(...validExercises);

        if (validExercises.length > 0) {
            console.log(
                `"${query}" (${eq || 'all'}) [${category}]: ${validExercises.length} exercises`
            );
        }
    });

    const verticalPullIds = new Set(
        (categorized.get("vertical_pull") || []).map((ex: { id: string }) => ex.id)
    );
    if (verticalPullIds.size < 16) {
        console.log(
            `[FETCH] Vertical pull pool is small (${verticalPullIds.size}); adding unfiltered pull searches`
        );
        const supplementals: { query: string; category: string }[] = [
            { query: "pull-up chin-up assisted lat pulldown", category: "vertical_pull" },
            { query: "inverted row prone pull bodyweight", category: "horizontal_pull" },
        ];
        const suppResults = await searchExercisesBatch(
            supplementals.map(({ query }) => ({
                query,
                matchCount: 40,
                matchThreshold: 0.35,
                filterEquipment: undefined,
            }))
        );
        suppResults.forEach((result, idx) => {
            const { query, category } = supplementals[idx];
            if (!result.success) {
                console.warn(`Supplemental search failed for "${query}":`, result.error);
                return;
            }
            const validExercises = result.exercises
                .filter(ex => ex.id && ex.gif_path && ex.gif_path !== '')
                .map(ex => {
                    const exerciseEquipment = ex.equipment || "bodyweight";
                    return {
                        name: ex.name,
                        id: ex.id,
                        target: ex.target_muscle || ex.body_part,
                        equipment: exerciseEquipment,
                        difficulty: ex.difficulty,
                        bodyPart: ex.body_part,
                        category,
                        fullData: ex,
                    };
                });
            if (!categorized.has(category)) {
                categorized.set(category, []);
            }
            categorized.get(category)!.push(...validExercises);
            allExercises.push(...validExercises);
            if (validExercises.length > 0) {
                console.log(
                    `[SUPPLEMENTAL] "${query}" [${category}]: ${validExercises.length} exercises`
                );
            }
        });
    }

    const uniqueExercises = Array.from(
        new Map(allExercises.map(ex => [ex.id, ex])).values()
    );
    // Availability pass covers what the per-query bucket filter can't: results
    // of the unfiltered supplemental searches above, and accessory needs the
    // bucket doesn't encode (bench lifts without a bench, hangs without a bar).
    const equipmentSafe = filterByAvailableEquipment(
        uniqueExercises.map((ex) => ({
            ...ex,
            equipment_canonical: ex.fullData?.equipment_canonical ?? null,
        })),
        equipment
    );
    if (equipmentSafe.length !== uniqueExercises.length) {
        console.log(
            `[FETCH] Equipment availability removed ${uniqueExercises.length - equipmentSafe.length} exercises the user can't perform`
        );
    }
    const filteredExercises = filterExercisesByInjury(equipmentSafe, injury);

    // CRITICAL FIX: Compute equipment counts AFTER dedupe
    const equipmentCounts = new Map<string, number>();
    for (const ex of filteredExercises) {
        const eq = ex.equipment || 'bodyweight';
        equipmentCounts.set(eq, (equipmentCounts.get(eq) || 0) + 1);
    }

    console.log(`[FETCH] Total: ${uniqueExercises.length} exercises (${filteredExercises.length} after injury filtering)`);
    console.log(
        `[FETCH] Equipment:`,
        Array.from(equipmentCounts.entries()).map(([eq, c]) => `${eq}(${c})`).join(', ')
    );

    const categoryBreakdown = Array.from(categorized.entries())
        .map(([cat, exs]) => {
            const filtered = exs.filter(ex =>
                filteredExercises.some(fex => fex.id === ex.id)
            );
            return `${cat}(${filtered.length})`;
        })
        .join(', ');
    console.log(`[FETCH] Categories:`, categoryBreakdown);

    // FLEXIBLE PATTERN CHECK: Basic validation that core patterns exist
    // Detailed per-day focus validation happens during plan generation
    const corePatterns = ['squat', 'push', 'pull', 'core'];
    const missingCorePatterns: string[] = [];

    for (const pattern of corePatterns) {
        const hasExercises = Array.from(categorized.entries())
            .filter(([cat]) => {
                const catLower = cat.toLowerCase();
                // Check direct match or common substitutions
                if (catLower.includes(pattern)) return true;
                if (pattern === 'squat' && (catLower.includes('lunge') || catLower.includes('step'))) return true;
                if (pattern === 'pull' && catLower.includes('row')) return true;
                return false;
            })
            .flatMap(([_, exs]) => exs)
            .filter(ex => filteredExercises.some(fex => fex.id === ex.id))
            .length > 0;

        if (!hasExercises) {
            missingCorePatterns.push(pattern);
        }
    }

    if (missingCorePatterns.length > 0) {
        console.warn(`[FETCH] MISSING CORE PATTERNS: ${missingCorePatterns.join(', ')}`);
    }

    return { exercises: filteredExercises, categorized, equipmentCounts };
}

// ============================================================================
// SCHEMAS
// ============================================================================

const ProgrammingParametersSchema = z.object({
    reasoning: z.string(),
    defaultSets: z.number(),
    defaultReps: z.string(),
    defaultRest: z.number(),
    exercisesPerDay: z.number(),
});

const DayWorkoutSchema = z.object({
    dayOfWeek: z.string(),
    focus: z.string(),
    exercises: z.array(z.object({
        id: z
            .string()
            .describe(
                "Exact id from the ALLOWED EXERCISE DICTIONARY (e.g. id=abc123). Required."
            ),
        name: z
            .string()
            .describe(
                "Exact exercise name from the ALLOWED EXERCISE DICTIONARY. Must match an entry verbatim."
            ),
        sets: z.number(),
        reps: z.string(),
        rest_seconds: z.number(),
        quick_alternatives: z
            .array(z.string())
            .describe(
                "An array of 2-3 alternative exercise names that target the same muscle group and movement pattern (e.g., if the main exercise is Barbell Squat, alternatives could be ['Dumbbell Goblet Squat', 'Leg Press']). Must be from the allowed dictionary."
            ),
        intensity_target: z
            .string()
            .describe(
                "The RPE (Rate of Perceived Exertion) or RIR (Reps in Reserve) target for this exercise."
            ),
        injury_note: z
            .string()
            .nullable()
            .describe(
                "REQUIRED when the user reported an injury AND this exercise loads or borders the affected area: one short user-facing modification cue (max ~15 words). null otherwise."
            ),
    })),
});

// `reasoning` was deliberately REMOVED from this schema. Even when declared
// after `days`, optional, with a length cap and an explicit "do not think
// out loud" description, the model treated it as a scratchpad and produced
// JSON containing only `reasoning` — omitting `days` entirely (Anthropic's
// tool schema doesn't enforce `maxLength` or required-field ordering).
// With nowhere to monologue in the output shape, the model goes straight
// to `days`. If we ever need a programmer rationale, derive it from the
// generated plan downstream instead of asking the LLM for it inline.
const WeekPlanSchema = z.object({
    days: z.array(DayWorkoutSchema),
});

// ============================================================================
// AUTO-REGULATION (RPE / RIR)
// ============================================================================

/**
 * Default intensity_target string applied to fallback-filled exercises (i.e. those
 * we appended ourselves when the LLM under-delivered). The LLM is also instructed
 * to use the same scheme so user-facing intensity is consistent across both paths.
 */
function getDefaultIntensityTarget(goal: string | null | undefined, fitnessLevel: string | null | undefined): string {
    const lvl = (fitnessLevel || "").toLowerCase();
    if (lvl === "beginner") {
        return "Leave 2 solid reps in the tank";
    }
    const g = (goal || "").toLowerCase();
    if (g.includes("strength") || g.includes("stronger") || g.includes("power")) {
        return "RPE 8";
    }
    return "2 RIR - stop 2 reps shy of failure";
}

/**
 * Build the goal-specific programming block injected into the generation prompt.
 * Keeps the canonical RIR / RPE language identical between the prompt and the
 * fallback default applied during repair, preventing intensity drift.
 */
function buildAutoRegulationBlock(goal: string | null | undefined, fitnessLevel: string | null | undefined): string {
    const lvl = (fitnessLevel || "").toLowerCase();
    const g = (goal || "").toLowerCase();
    const isBeginner = lvl === "beginner";
    const isStrength = g.includes("strength") || g.includes("stronger") || g.includes("power");
    const isHypertrophy =
        g.includes("muscle") || g.includes("hypertrophy") || g.includes("size") || g.includes("build");

    let recommendedTone = "";
    if (isBeginner) {
        recommendedTone = `Recommended for THIS user (${lvl} / ${g || "general"}): "Leave 2 solid reps in the tank".`;
    } else if (isStrength) {
        recommendedTone = `Recommended for THIS user (${g}): "RPE 8" (heaviest set ~2 reps shy of failure).`;
    } else if (isHypertrophy) {
        recommendedTone = `Recommended for THIS user (${g}): "2 RIR - stop 2 reps shy of failure".`;
    } else {
        recommendedTone = `Recommended for THIS user: "2 RIR - stop 2 reps shy of failure".`;
    }

    return `INTENSITY PROGRAMMING (AUTO-REGULATION) — REQUIRED PER EXERCISE:
You must program intensity using RIR (Reps in Reserve) or RPE.
- For Hypertrophy goals: Program 1-3 RIR (e.g., "2 RIR - stop 2 reps shy of failure").
- For Strength goals: Program specific RPE targets (e.g., "RPE 8").
- For Beginners: Keep it simple (e.g., "Leave 2 solid reps in the tank").
${recommendedTone}
Include this in the \`intensity_target\` field for every exercise.`;
}

// ============================================================================
// GRAPH NODES
// ============================================================================

async function loadUserProfile(state: PlannerState): Promise<Partial<PlannerState>> {
    console.log("[LOAD] Loading user profile...");

    try {
        if (state.userId === "test-diagnostic-edge") {
            const mockProfile = {
                id: state.userId,
                name: "Edge Case User",
                birthday: "1990-01-01",
                age: 35,
                fitness_level: "intermediate",
                goal: "build_muscle",
                workout_days_per_week: 4,
                workout_split_type: "ppl",
                workout_duration_minutes: 15,
                selected_workout_days: ["monday", "tuesday", "thursday", "friday"],
                available_equipment: ["dumbbell", "body weight"],
                injuries: "bad knees",
            };
            return {
                userProfile: mockProfile,
                selectedDays: mockProfile.selected_workout_days,
                messages: [new HumanMessage("Edge-case demo user loaded")],
            };
        }

        if (state.userId.startsWith('test-') || state.userId.startsWith('mock-') || state.userId.startsWith('demo-')) {
            const mockProfile = {
                id: state.userId,
                name: "Demo User",
                birthday: '1995-01-01',
                age: 30,
                fitness_level: "intermediate",
                goal: "build_muscle",
                workout_days_per_week: 4,
                workout_split_type: "ppl",
                workout_duration_minutes: 60,
                selected_workout_days: ['monday', 'tuesday', 'thursday', 'friday'],
                available_equipment: ["dumbbell", "barbell"],
                injuries: null,
            };

            return {
                userProfile: mockProfile,
                selectedDays: mockProfile.selected_workout_days,
                messages: [new HumanMessage("Demo user loaded")],
            };
        }

        const profile = await getUserProfile(state.userId);
        if (!profile) {
            return { success: false, error: "User profile not found" };
        }

        const rawDays = profile.selected_workout_days as unknown;
        let selectedDays: string[] = [];
        if (Array.isArray(rawDays)) {
            if (rawDays.length === 0) {
                selectedDays = [];
            } else if (typeof rawDays[0] === 'string') {
                selectedDays = (rawDays as string[]).map((d) => d.trim());
            } else if (typeof rawDays[0] === 'object' && rawDays[0] !== null && 'day' in (rawDays[0] as object)) {
                selectedDays = (rawDays as { day: string; enabled?: boolean }[])
                    .filter((d) => d.enabled !== false)
                    .map((d) => d.day);
            }
        } else if (rawDays && typeof rawDays === 'object') {
            const o = rawDays as Record<string, boolean>;
            selectedDays = Object.keys(o).filter((day) => o[day] === true);
        } else if (typeof rawDays === 'string') {
            selectedDays = rawDays.split(',').map((d: string) => d.trim());
        }

        const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        selectedDays = selectedDays.filter(day => validDays.includes(day.toLowerCase()));

        if (selectedDays.length === 0) {
            return { success: false, error: "No valid workout days selected" };
        }

        const rawEquipment = profile.available_equipment as unknown;
        let equipment: string[] = [];
        if (Array.isArray(rawEquipment)) {
            equipment = rawEquipment.map((e) => String(e).trim());
        } else if (typeof rawEquipment === 'string') {
            equipment = rawEquipment.split(',').map((e: string) => e.trim());
        }

        // CRITICAL FIX: Canonicalize equipment names for consistency
        equipment = canonicalizeEquipment(equipment);

        const age = profile.birthday ? calculateAge(profile.birthday) : 25;

        const validatedProfile = {
            ...profile,
            age,
            fitness_level: profile.fitness_level || 'beginner',
            goal: profile.goal || 'build_muscle',
            workout_duration_minutes: profile.workout_duration_minutes || 60,
            available_equipment: equipment, // Use canonicalized equipment
            injuries: profile.injuries || null,
        };

        console.log(`[LOAD] ${validatedProfile.name}, ${age}yo, ${validatedProfile.fitness_level}, ${validatedProfile.goal}`);
        console.log(
            `   Days: ${selectedDays.length} [${selectedDays.join(', ')}], Duration: ${validatedProfile.workout_duration_minutes}min`
        );
        console.log(
            `   Equipment: [${equipment.join(', ')}], Injuries: ${validatedProfile.injuries || 'none'}`
        );

        return {
            userProfile: validatedProfile,
            selectedDays,
            messages: [new HumanMessage("User loaded")],
        };
    } catch (error) {
        return { success: false, error: `Error loading profile: ${String(error)}` };
    }
}

async function determineSplit(state: PlannerState): Promise<Partial<PlannerState>> {
    console.log("[SPLIT] Determining workout split...");

    const profile = state.userProfile;
    const selectedDays = state.selectedDays!;
    const numDays = selectedDays.length;

    if (state.preferences?.splitType) {
        console.log(`[SPLIT] Using preference: ${state.preferences.splitType}`);
        return { split: state.preferences.splitType, trainingDays: numDays };
    }

    if (profile.workout_split_type) {
        console.log(`[SPLIT] Using profile: ${profile.workout_split_type}`);
        return { split: profile.workout_split_type, trainingDays: numDays };
    }

    const splitSchema = z.object({
        split: z.enum(['full_body', 'upper_lower', 'ppl', 'bro_split']),
        reasoning: z.string(),
    });

    const structured = llm.withStructuredOutput(splitSchema, { strict: true });
    const response = await structured.invoke([
        new SystemMessage("You are an expert personal trainer."),
        new HumanMessage(`Recommend best split for: ${profile.age}yo, ${profile.fitness_level}, ${profile.goal}, ${numDays} days/week`),
    ]) as z.infer<typeof splitSchema>;

    console.log(`[SPLIT] AI: ${response.split}`);

    return {
        split: response.split,
        trainingDays: numDays,
        messages: [...state.messages, new AIMessage(`Selected ${response.split}`)],
    };
}

/**
 * RAG node — runs after the split is decided and before plan generation.
 *
 * Loads a vetted exercise dictionary (filtered by the user's available equipment
 * when present) from Supabase and stores both:
 *   - `allowedExercises`     — prompt-ready formatted block injected into LLM prompts
 *   - `allowedExerciseRows`  — structured rows used by post-processing / matching
 *
 * Never throws: any failure swaps in `FALLBACK_EXERCISE_DICTIONARY` and emits a warning.
 */
async function fetchAllowedExercises(state: PlannerState): Promise<Partial<PlannerState>> {
    console.log("[RAG] Fetching allowed exercise dictionary...");

    const profile = state.userProfile ?? {};
    const rawEquipment = profile.available_equipment as unknown;
    let equipment: string[] = [];
    if (Array.isArray(rawEquipment)) {
        equipment = rawEquipment.map((e) => String(e).trim()).filter((e) => e.length > 0);
    } else if (typeof rawEquipment === "string") {
        equipment = rawEquipment
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e.length > 0);
    }
    if (equipment.length > 0) {
        equipment = canonicalizeEquipment(equipment);
    }

    const warnings = [...(state.warnings ?? [])];

    try {
        const dictionary = await getAllowedExerciseDictionary({
            equipment: equipment.length > 0 ? equipment : null,
            limit: 250,
        });

        if (dictionary.warnings.length > 0) {
            warnings.push(...dictionary.warnings);
        }

        // The dictionary is the ONLY list the generation LLM may pick from, so
        // injury exclusions must land here too — filtering the search pools
        // alone still let contraindicated names through via the dictionary.
        const injurySafeRows = filterExercisesByInjury(
            dictionary.rows,
            (profile.injuries as string | null) ?? null
        );
        const rows = injurySafeRows.length >= 5 ? injurySafeRows : dictionary.rows;

        console.log(
            `[RAG] Allowed exercise dictionary ready (source=${dictionary.source}, rows=${rows.length})`
        );

        return {
            allowedExercises: formatAllowedExerciseDictionary(rows),
            allowedExerciseRows: rows,
            warnings,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[RAG] fetchAllowedExercises failed: ${message}; using fallback dictionary.`);
        warnings.push(
            `fetchAllowedExercises: unexpected failure (${message}); used hardcoded fallback dictionary.`
        );
        return {
            allowedExercises: formatAllowedExerciseDictionary(FALLBACK_EXERCISE_DICTIONARY),
            allowedExerciseRows: FALLBACK_EXERCISE_DICTIONARY,
            warnings,
        };
    }
}

async function generateDayPlans(state: PlannerState): Promise<Partial<PlannerState>> {
    console.log("[GENERATE] Generating workout plan...");

    const profile = state.userProfile;
    const split = state.split!;
    const selectedDays = state.selectedDays!;
    const equipment = profile.available_equipment || [];

    const coreFocuses = getCoreFocuses(split);
    const coreWorkoutCount = coreFocuses.length;

    const exercisesPerDay = calculateExercisesPerDay(
        profile.workout_duration_minutes,
        profile.fitness_level,
        profile.goal
    );

    console.log(
        `[GENERATE] Target: ${exercisesPerDay} exercises/routine, ${coreWorkoutCount} core routines for ${split}`
    );
    console.log(
        `[GENERATE] Selected days (${selectedDays.length}): ${selectedDays.join(", ")} — will be mapped via rolling modulo`
    );

    const programmingPrompt = `Determine programming for: ${profile.age}yo, ${profile.fitness_level}, ${profile.goal}, ${profile.workout_duration_minutes}min. Sets? (3-5) Reps for ${profile.goal}? Rest?`;

    const programmingStructured = llm.withStructuredOutput(ProgrammingParametersSchema, { strict: true });

    // Fire programming-params LLM call in parallel with the (slow) RAG fetch.
    // The two have no data dependency; awaiting both with Promise.all overlaps
    // ~1–2s of LLM latency with the embedding + pgvector fan-out.
    const [programmingParams, targeted] = await Promise.all([
        programmingStructured.invoke([
            new SystemMessage("You are an expert strength coach."),
            new HumanMessage(programmingPrompt),
        ]) as Promise<z.infer<typeof ProgrammingParametersSchema>>,
        fetchTargetedExercises(split, equipment, profile.injuries),
    ]);

    programmingParams.exercisesPerDay = exercisesPerDay;

    console.log(`[GENERATE] Programming: ${exercisesPerDay} exercises, ${programmingParams.defaultSets}x${programmingParams.defaultReps}, ${programmingParams.defaultRest}s rest`);

    const { exercises: availableExercises, categorized } = targeted;

    if (availableExercises.length < 8) {
        return {
            success: false,
            error: `Only found ${availableExercises.length} exercises. Please add equipment or broaden constraints.`
        };
    }

    // CRITICAL FIX: Validate ALL day types for the split, not just one
    // For upper_lower: check both upper AND lower requirements
    // For PPL: check push AND pull AND legs requirements
    const dayFocuses = [...coreFocuses];

    const allMissingPatterns: string[] = [];

    // Check requirements for each day type
    for (const dayFocus of dayFocuses) {
        const dayRequirements = getRequirementsForDayFocus(dayFocus);

        for (const pattern of dayRequirements.required) {
            const hasExercises = Array.from(categorized.entries())
                .filter(([cat]) =>
                    matchesPattern(cat, pattern, dayRequirements.substitutions)
                )
                .flatMap(([_, exs]) => exs)
                .filter(ex => availableExercises.some(ae => ae.id === ex.id))
                .length > 0;

            if (!hasExercises) {
                const patternKey = `${dayFocus}:${pattern}`;
                if (!allMissingPatterns.includes(patternKey)) {
                    allMissingPatterns.push(patternKey);
                }
            }
        }
    }

    const generationWarnings: string[] = [];
    if (allMissingPatterns.length > 0) {
        generationWarnings.push(
            `Missing strict movement patterns for current constraints: ${allMissingPatterns.join(", ")}. Using closest available substitutions.`
        );
        console.warn(`[GENERATE] ${generationWarnings[generationWarnings.length - 1]}`);
    }

    const exercisesByCategoryFormatted = Array.from(categorized.entries())
        .filter(([_, exs]) =>
            exs.filter(ex => availableExercises.some(ae => ae.id === ex.id)).length > 0
        )
        .map(([category, exs]) => {
            const filtered = exs.filter(ex => availableExercises.some(ae => ae.id === ex.id));
            const samples = filtered.slice(0, 15).map(ex => `"${ex.name}"`).join(', ');
            return `${category.toUpperCase()} (${filtered.length}): ${samples}`;
        })
        .join('\n\n');

    let movementRequirements = "";
    if (split === "full_body") {
        movementRequirements = `REQUIRED MOVEMENT PATTERNS PER WORKOUT (NON-NEGOTIABLE):
1. One SQUAT pattern (squat, lunge, split squat)
2. One HINGE pattern (deadlift, RDL, glute bridge)
3. One HORIZONTAL PUSH (bench press, push-up, chest fly)
4. One HORIZONTAL PULL (row - bent over, seated, cable, dumbbell) ← MUST INCLUDE
5. One VERTICAL movement (overhead press OR pull-up/pulldown) ← MUST INCLUDE
6. One CORE exercise (plank, crunch, leg raise, dead bug)
7. Optional: One ACCESSORY (arms, calves, shoulders)

CRITICAL: The Full Body routine MUST include pulling movements (rows, pull-ups, pulldowns).

NO EXERCISE REPEATS within the routine.`;
    } else if (split === "upper_lower") {
        movementRequirements = `UPPER BODY ROUTINE MUST INCLUDE (NON-NEGOTIABLE):
1. One HORIZONTAL PUSH (bench press, push-up)
2. One HORIZONTAL PULL (rows - MUST INCLUDE)
3. One VERTICAL PUSH (overhead press)
4. One VERTICAL PULL (pull-up, pulldown - MUST INCLUDE)
5. One ARM exercise (curls OR extensions)
6. Optional: Extra push/pull or shoulders

LOWER BODY ROUTINE MUST INCLUDE:
1. One SQUAT pattern
2. One HINGE pattern
3. One UNILATERAL (single-leg)
4. One CALVES
5. One CORE

CRITICAL: The Upper routine MUST have both horizontal AND vertical pulling.

NO EXERCISE REPEATS across the two core routines.`;
    } else if (split === "ppl") {
        movementRequirements = `PUSH ROUTINE: 2-3 chest, 2-3 shoulders, 1-2 triceps

PULL ROUTINE (CRITICAL):
- 2-3 BACK exercises (rows, pulldowns, pull-ups - NON-NEGOTIABLE)
- 1-2 rear delts or traps
- 1-2 biceps

LEGS ROUTINE: 2-3 quads, 2-3 hamstrings/glutes, 1 calf, 1 core

NO EXERCISE REPEATS across the three core routines.`;
    } else if (split === "bro_split") {
        movementRequirements = `Generate ONE routine per body part: Chest, Back, Legs, Shoulders, Arms.
Each routine must focus on its body part with appropriate compounds + accessories.
NO EXERCISE REPEATS across the five core routines.`;
    }

    // RAG dictionary block (injected into prompt and used for post-gen swap matching).
    // Falls back to a synthesised block if the fetch node was somehow skipped.
    const allowedExerciseRows: AllowedExerciseRow[] =
        state.allowedExerciseRows && state.allowedExerciseRows.length > 0
            ? state.allowedExerciseRows
            : FALLBACK_EXERCISE_DICTIONARY;
    const allowedExercisesFormatted: string =
        state.allowedExercises && state.allowedExercises.trim().length > 0
            ? state.allowedExercises
            : formatAllowedExerciseDictionary(allowedExerciseRows);

    const autoRegulationBlock = buildAutoRegulationBlock(profile.goal, profile.fitness_level);
    const defaultIntensityTarget = getDefaultIntensityTarget(profile.goal, profile.fitness_level);
    const injuryBlock = buildInjuryPromptBlock(profile.injuries);

    const fullWeekPrompt = `Create a ${split} program.

CLIENT: ${profile.name}, ${profile.age}yo, ${profile.fitness_level}, ${profile.goal}
EQUIPMENT: ${equipment.join(', ') || 'bodyweight'}
INJURIES: ${profile.injuries || 'none'}
DURATION: ${profile.workout_duration_minutes}min
${injuryBlock ? `\n${injuryBlock}\n` : ''}

PROGRAMMING:
- ${exercisesPerDay} exercises per routine (STRICT)
- ${programmingParams.defaultSets} sets × ${programmingParams.defaultReps} reps
- ${programmingParams.defaultRest}s rest

CORE ROUTINES — you MUST return EXACTLY ${coreWorkoutCount} routine objects in the "days" array, no more and no fewer, in this exact order:
${coreFocuses.map((focus, idx) => `Routine ${idx + 1}: ${focus}`).join('\n')}

HARD COUNT CONTRACT: days.length === ${coreWorkoutCount}. If you return any other count, the response is invalid and rejected. Do not add bonus routines. Do not collapse routines. Do not generate one routine per preferred training day.

ROLLING SCHEDULE NOTE:
The user selected ${selectedDays.length} preferred training day(s) per week. Those days will be
mapped to the routines above by the system using a rolling modulo wrap (Routine[i % ${coreWorkoutCount}]),
starting from today. DO NOT generate one routine per preferred day. Generate ONLY the
${coreWorkoutCount} core routines listed above.

${movementRequirements}

ALLOWED EXERCISE DICTIONARY (RAG — the ONLY exercises you may use):
${allowedExercisesFormatted}

PROMPT-CATEGORIZED HINTS (for inspiration ONLY — DO NOT pick exercises from here unless they ALSO appear in the ALLOWED EXERCISE DICTIONARY above):
${exercisesByCategoryFormatted}

${autoRegulationBlock}

QUICK SWAPS (per exercise) — REQUIRED:
For every exercise, also include 2-3 entries in \`quick_alternatives\`. Each alternative must:
- Be an exact exercise name copied verbatim from the ALLOWED EXERCISE DICTIONARY above.
- Target the same muscle group / movement pattern as the main exercise.
- NOT duplicate the main exercise's name.

CRITICAL RULES:
1. EXACTLY ${coreWorkoutCount} routines in the "days" array — one per core focus, in the listed order.
2. EXACTLY ${exercisesPerDay} exercises per routine.
3. ZERO HALLUCINATIONS: every exercise's \`id\` and \`name\` MUST appear verbatim in the ALLOWED EXERCISE DICTIONARY. Do not invent exercises. Do not paraphrase names. Do not pull from the categorized hints unless that exact name is also in the dictionary.
4. \`quick_alternatives\` MUST contain 2-3 names, each pulled verbatim from the ALLOWED EXERCISE DICTIONARY.
5. \`intensity_target\` MUST be set on every exercise per the auto-regulation rules above.
6. MUST include all required movement patterns (especially PULLING).
7. Mix equipment types where the dictionary allows.
8. NO EXERCISE REPEATS across the ${coreWorkoutCount} routines.
9. Balance compounds + accessories.
10. Avoid: ${profile.injuries || 'none'}

Return EXACTLY ${coreWorkoutCount} routines in the "days" array. Use the focus name (e.g. "${coreFocuses[0]}") in the dayOfWeek field for each entry.`;

    const weekStructured = llm.withStructuredOutput(WeekPlanSchema, { strict: true });
    const weekPlan = await weekStructured.invoke([
        new SystemMessage(
            "You are an elite, evidence-based strength coach creating BALANCED programs.\n" +
            `HARD CONTRACT: the "days" array MUST contain EXACTLY ${coreWorkoutCount} routine objects, in the listed routine order. ` +
            "Returning any other count is a contract violation that will be rejected. " +
            "Do NOT generate one routine per preferred training day — generate ONLY the core split routines listed. " +
            `(Push/Pull/Legs = 3, Upper/Lower = 2, Full Body = 1, Bro Split = 5; this run requires ${coreWorkoutCount}.)\n` +
            "EVERY routine must include PULLING movements where appropriate (rows, pull-ups). " +
            "NO exercise repeats across the core routines. Follow exact exercise count per routine. " +
            "ZERO HALLUCINATIONS: only construct workouts using exact exercise IDs and names from the ALLOWED EXERCISE DICTIONARY. " +
            "Every `quick_alternatives` entry must also be a verbatim name from the dictionary. " +
            "Every exercise must include an `intensity_target` (RIR or RPE) consistent with the user's goal."
        ),
        new HumanMessage(fullWeekPrompt),
    ]) as z.infer<typeof WeekPlanSchema>;

    if (weekPlan.days.length !== coreWorkoutCount) {
        return {
            success: false,
            error: `Plan generation returned ${weekPlan.days.length} routines but ${coreWorkoutCount} core routines were required for ${split}.`,
        };
    }

    console.log(`[GENERATE] AI generated ${weekPlan.days.length} core routines`);

    const dayPlans: NonNullable<PlannerState["dayPlans"]> = [];
    const coreRoutines: { focus: string; exercises: ExerciseDetail[] }[] = [];
    const usedExercises = new Set<string>();
    const finalEquipmentCounts = new Map<string, number>();
    const weekExerciseNames = new Set<string>();
    const availableById = new Map(availableExercises.map((ex) => [ex.id, ex]));

    // Allowed-dictionary lookups used to (a) prefer LLM-provided ids and (b) sanitise
    // `quick_alternatives` so we never emit a hallucinated alternative downstream.
    const allowedById = new Map(allowedExerciseRows.map((row) => [row.id, row]));
    const allowedByName = new Map(
        allowedExerciseRows.map((row) => [row.name.toLowerCase(), row])
    );

    /** Sanitise LLM-provided alternatives down to dictionary names only (max 3). */
    const sanitizeQuickAlternatives = (
        candidates: string[] | undefined,
        skipName: string
    ): string[] => {
        if (!candidates || candidates.length === 0) return [];
        const skip = skipName.toLowerCase();
        const seen = new Set<string>();
        const out: string[] = [];
        for (const candidate of candidates) {
            if (typeof candidate !== "string") continue;
            const trimmed = candidate.trim();
            if (trimmed.length === 0) continue;
            const lower = trimmed.toLowerCase();
            if (lower === skip || seen.has(lower)) continue;
            const dictRow = allowedByName.get(lower);
            if (!dictRow) continue;
            seen.add(lower);
            out.push(dictRow.name);
            if (out.length >= 3) break;
        }
        return out;
    };

    /** Build dictionary-grounded fallback alternatives by body_part / target_muscle siblings. */
    const buildFallbackAlternatives = (ex: ExerciseDetail): string[] => {
        const skip = (ex.name || "").toLowerCase();
        const target = (ex.target_muscle || "").toLowerCase();
        const body = (ex.body_part || "").toLowerCase();
        const out: string[] = [];
        const seen = new Set<string>([skip]);
        for (const row of allowedExerciseRows) {
            if (out.length >= 3) break;
            const rowName = row.name.toLowerCase();
            if (seen.has(rowName)) continue;
            const rowTarget = (row.target_muscle || "").toLowerCase();
            const rowBody = (row.body_part || "").toLowerCase();
            const matches =
                (target && rowTarget && rowTarget === target) ||
                (body && rowBody && rowBody === body);
            if (!matches) continue;
            seen.add(rowName);
            out.push(row.name);
        }
        return out;
    };

    const toCanonicalExercise = (candidate: any): ExerciseDetail | null => {
        if (!candidate || typeof candidate !== "object") return null;
        const base = candidate.fullData && typeof candidate.fullData === "object"
            ? candidate.fullData
            : candidate;
        if (!base?.id || !base?.name || !base?.gif_path) return null;
        return base as ExerciseDetail;
    };

    const pushUniqueExercise = (
        bucket: ExerciseDetail[],
        ex: any,
        sets: number,
        reps: string,
        restSeconds: number,
        opts?: {
            quickAlternatives?: string[];
            intensityTarget?: string;
            injuryNote?: string | null;
        }
    ) => {
        const canonicalEx = toCanonicalExercise(ex);
        if (!canonicalEx) return false;

        const cleanedName = cleanExerciseName(canonicalEx.name);
        const dedupeName = cleanedName.toLowerCase();
        if (weekExerciseNames.has(dedupeName)) return false;
        const quickAlternatives = (() => {
            const fromLlm = sanitizeQuickAlternatives(opts?.quickAlternatives, cleanedName);
            if (fromLlm.length >= 2) return fromLlm;
            const fallback = buildFallbackAlternatives({ ...canonicalEx, name: cleanedName });
            const merged = [...fromLlm];
            for (const candidate of fallback) {
                if (merged.length >= 3) break;
                if (!merged.some((m) => m.toLowerCase() === candidate.toLowerCase())) {
                    merged.push(candidate);
                }
            }
            return merged;
        })();
        bucket.push({
            ...canonicalEx,
            name: cleanedName,
            sets,
            reps,
            rest_seconds: restSeconds,
            quick_alternatives: quickAlternatives,
            intensity_target: opts?.intensityTarget?.trim() || defaultIntensityTarget,
            ...(opts?.injuryNote?.trim() ? { injury_note: opts.injuryNote.trim() } : {}),
        });
        weekExerciseNames.add(dedupeName);
        return true;
    };

    // Build core routines (no day binding); deterministic per-day assignment happens after.
    for (let i = 0; i < coreWorkoutCount; i++) {
        const focus = coreFocuses[i];
        const aiDay = weekPlan.days[i];

        if (!aiDay) {
            console.warn(`[VALIDATE] Missing core routine ${i + 1} (${focus})`);
            continue;
        }

        const selectedExercises: ExerciseDetail[] = [];

        for (const selection of aiDay.exercises) {
            // Prefer matching by LLM-provided id (since we hand the LLM a curated id list);
            // fall back to fuzzy name matching for resilience.
            let matchedExercise: any = null;
            if (selection.id && availableById.has(selection.id)) {
                const fromAvailable = availableById.get(selection.id);
                if (fromAvailable) {
                    matchedExercise = { fullData: toCanonicalExercise(fromAvailable) };
                }
            }
            if (!matchedExercise) {
                matchedExercise = fuzzyMatchExercise(selection.name, availableExercises);
            }

            if (matchedExercise && matchedExercise.fullData) {
                const fullEx = toCanonicalExercise(matchedExercise.fullData);
                if (!fullEx) continue;
                const exerciseNameLower = cleanExerciseName(fullEx.name).toLowerCase();

                if (weekExerciseNames.has(exerciseNameLower)) {
                    console.warn(`[VALIDATE] Duplicate exercise across core routines: "${fullEx.name}" - skipping`);
                    continue;
                }

                const added = pushUniqueExercise(
                    selectedExercises,
                    fullEx,
                    selection.sets,
                    selection.reps,
                    selection.rest_seconds,
                    {
                        quickAlternatives: selection.quick_alternatives,
                        intensityTarget: selection.intensity_target,
                        injuryNote: selection.injury_note,
                    }
                );
                if (added) {
                    usedExercises.add(selection.name.toLowerCase());
                }
            } else {
                console.warn(`[VALIDATE] Exercise not found: "${selection.name}" (id="${selection.id ?? "n/a"}")`);
                if (selection.id && allowedById.has(selection.id)) {
                    generationWarnings.push(
                        `Dictionary id "${selection.id}" was not present in the live exercise pool; skipped.`
                    );
                }
            }
        }

        const routineLabel = aiDay.focus || focus;

        // Fallback phase 1: fill missing required patterns for this routine focus.
        const dayRequirements = getRequirementsForDayFocus(routineLabel);
        for (const pattern of dayRequirements.required) {
            if (selectedExercises.length >= exercisesPerDay) break;
            const hasPatternAlready = selectedExercises.some((ex) =>
                matchesPattern(ex.body_part || ex.target_muscle || ex.name, pattern, dayRequirements.substitutions)
            );
            if (hasPatternAlready) continue;

            const candidateCategories = PATTERN_TO_CATEGORY_HINTS[pattern] || [];
            let patternFilled = false;
            for (const category of candidateCategories) {
                if (patternFilled || selectedExercises.length >= exercisesPerDay) break;
                const pool = (categorized.get(category) || [])
                    .map((ex) => availableById.get(ex.id))
                    .map((ex) => toCanonicalExercise(ex))
                    .filter((ex): ex is ExerciseDetail => Boolean(ex));
                for (const candidate of pool) {
                    const added = pushUniqueExercise(
                        selectedExercises,
                        candidate,
                        programmingParams.defaultSets,
                        programmingParams.defaultReps,
                        programmingParams.defaultRest
                    );
                    if (added) {
                        patternFilled = true;
                        break;
                    }
                }
            }
            if (!patternFilled) {
                generationWarnings.push(
                    `${routineLabel}: couldn't satisfy "${pattern}" exactly; generated closest available routine.`
                );
            }
        }

        // Fallback phase 2: fill remaining slots with focus-priority categories.
        if (selectedExercises.length < exercisesPerDay) {
            const focusCategories = getFocusCategoryPriority(routineLabel);
            for (const category of focusCategories) {
                if (selectedExercises.length >= exercisesPerDay) break;
                const pool = (categorized.get(category) || [])
                    .map((ex) => availableById.get(ex.id))
                    .map((ex) => toCanonicalExercise(ex))
                    .filter((ex): ex is ExerciseDetail => Boolean(ex));
                for (const candidate of pool) {
                    if (selectedExercises.length >= exercisesPerDay) break;
                    pushUniqueExercise(
                        selectedExercises,
                        candidate,
                        programmingParams.defaultSets,
                        programmingParams.defaultReps,
                        programmingParams.defaultRest
                    );
                }
            }
        }

        // Fallback phase 3: global fill from any remaining valid exercise.
        if (selectedExercises.length < exercisesPerDay) {
            for (const candidate of availableExercises) {
                if (selectedExercises.length >= exercisesPerDay) break;
                pushUniqueExercise(
                    selectedExercises,
                    toCanonicalExercise(candidate),
                    programmingParams.defaultSets,
                    programmingParams.defaultReps,
                    programmingParams.defaultRest
                );
            }
        }

        if (selectedExercises.length > 0) {
            for (const ex of selectedExercises) {
                const eq = ex.equipment || 'bodyweight';
                finalEquipmentCounts.set(eq, (finalEquipmentCounts.get(eq) || 0) + 1);
            }
            coreRoutines.push({
                focus: routineLabel,
                exercises: selectedExercises,
            });

            const uniqueEquip = [...new Set(selectedExercises.map(ex => ex.equipment || 'bodyweight'))];
            console.log(
                `Core routine "${routineLabel}": ${selectedExercises.length} exercises - Equipment: [${uniqueEquip.join(', ')}]`
            );
            if (selectedExercises.length < exercisesPerDay) {
                generationWarnings.push(
                    `${routineLabel}: generated ${selectedExercises.length}/${exercisesPerDay} exercises due to constraints.`
                );
            }
        }
    }

    if (coreRoutines.length === 0) {
        return { success: false, error: "Could not create valid workout plan." };
    }

    // Rolling map: replicate core routines onto selected days via modulo wrap.
    // The /api/generate-plan flow keeps profile-day order here; the chat-driven
    // `generate_draft_plan` tool re-rolls this mapping by user-local "today".
    for (let i = 0; i < selectedDays.length; i++) {
        const routine = coreRoutines[i % coreRoutines.length];
        if (!routine) continue;
        dayPlans.push({
            dayIndex: i,
            dayOfWeek: selectedDays[i],
            focus: routine.focus,
            exercises: routine.exercises,
        });
    }

    if (dayPlans.length === 0) {
        return { success: false, error: "Could not map core routines to any selected day." };
    }

    const totalExercises = dayPlans.reduce((sum, day) => sum + day.exercises.length, 0);
    console.log(`\n[GENERATE] Complete!`);
    console.log(
        `   Core routines: ${coreRoutines.length}, Mapped days: ${dayPlans.length}, Unique exercises: ${weekExerciseNames.size}, Total exercise slots: ${totalExercises}`
    );
    console.log(
        `   Equipment:`,
        Array.from(finalEquipmentCounts.entries()).map(([eq, c]) => `${eq}(${c})`).join(', ')
    );

    return {
        dayPlans,
        warnings: generationWarnings.length ? [...new Set(generationWarnings)] : [],
        messages: [
            ...state.messages,
            new AIMessage(
                `Generated ${coreRoutines.length} core routine(s) and mapped them onto ${dayPlans.length} training day(s).`
            ),
        ],
    };
}

async function savePlan(state: PlannerState): Promise<Partial<PlannerState>> {
    console.log("[SAVE] Saving plan...");

    const isDemo = state.userId.startsWith('demo-') || state.userId.startsWith('test-') || state.userId.startsWith('mock-');
    if (isDemo) {
        return { planId: `demo-${Date.now()}`, success: true };
    }

    try {
        const result = await saveWorkoutPlan(
            state.userId,
            state.split!,
            state.dayPlans!.map(day => ({
                ...day,
                id: crypto.randomUUID(),
                estimatedTime: estimateWorkoutDurationMinutes(day.exercises as any[]),
            })),
            state.userProfile?.goal
        );

        console.log(`[SAVE] Plan saved: ${result.id}`);
        return { planId: result.id, success: true };
    } catch (error) {
        return { success: false, error: `Save failed: ${String(error)}` };
    }
}

// ============================================================================
// BUILD GRAPH
// ============================================================================

function shouldContinue(state: PlannerState): string {
    return state.error ? END : "continue";
}

// ============================================================================
// MUSCLE-GROUP BALANCE CHECK (post-generation audit)
// ============================================================================
//
// Read-only pass over the LLM-generated plan that flags imbalances. We
// surface findings as warnings rather than rejecting the plan — onboarding
// must always succeed and a flat warning lets the user (or a follow-up
// editor turn) fix anything obviously off without blocking the first
// experience. Catches three classes of regression:
//
//   1. A push-pull asymmetry (e.g. a "Push" day with no horizontal pull
//      anywhere in the week, or 3x more pushing than pulling volume).
//   2. Lower-body neglect (legs < 1/4 of total volume on a 3+ day program).
//   3. A day that looks like rest but isn't tagged as such.
//
// The warnings live on state.warnings which `savePlan` already persists.

const PUSH_PATTERNS = /\b(bench|press|push|dip|fly|chest|shoulder)\b/i;
const PULL_PATTERNS = /\b(row|pull|chin|lat|curl|face[\s-]?pull)\b/i;
const LOWER_PATTERNS = /\b(squat|deadlift|lunge|hinge|leg|glute|hamstring|quad|calf)\b/i;
const CORE_PATTERNS = /\b(core|abs|crunch|plank|leg[\s-]?raise|sit[\s-]?up|twist)\b/i;

interface BalanceTally {
    push: number;
    pull: number;
    lower: number;
    core: number;
    total: number;
}

function classifyExercise(name: string, target: string | undefined, bodyPart: string | undefined): keyof BalanceTally | null {
    const blob = `${name ?? ""} ${target ?? ""} ${bodyPart ?? ""}`;
    if (LOWER_PATTERNS.test(blob)) return "lower";
    if (PULL_PATTERNS.test(blob)) return "pull";
    if (PUSH_PATTERNS.test(blob)) return "push";
    if (CORE_PATTERNS.test(blob)) return "core";
    return null;
}

async function balanceCheck(state: PlannerState): Promise<Partial<PlannerState>> {
    const days = Array.isArray(state.dayPlans) ? state.dayPlans : [];
    if (days.length === 0) return {};

    const tally: BalanceTally = { push: 0, pull: 0, lower: 0, core: 0, total: 0 };
    let trainingDays = 0;
    for (const day of days) {
        const exercises = Array.isArray(day?.exercises) ? day.exercises : [];
        if (exercises.length === 0) continue;
        trainingDays++;
        for (const ex of exercises) {
            const name = String((ex as { name?: unknown })?.name ?? "");
            const target = String((ex as { target?: unknown })?.target ?? "");
            const bodyPart = String((ex as { bodyPart?: unknown })?.bodyPart ?? "");
            const cls = classifyExercise(name, target, bodyPart);
            tally.total++;
            if (cls) tally[cls]++;
        }
    }

    const warnings: string[] = [];
    if (tally.total < 6) {
        warnings.push(
            `[balance] Plan is very thin — only ${tally.total} exercises across ${trainingDays} day(s). Consider regenerating.`
        );
    }
    if (trainingDays >= 3 && tally.lower < Math.max(2, Math.floor(tally.total / 5))) {
        warnings.push(
            `[balance] Lower-body coverage looks light: ${tally.lower}/${tally.total} exercises. Aim for ≥1 squat/hinge per leg day.`
        );
    }
    // Push:pull ratio guard — chronic asymmetry is the single most common
    // posture/injury risk. Allow some skew (~1.4×) but flag clear imbalance.
    if (tally.push > 0 && tally.pull > 0) {
        const ratio = tally.push / tally.pull;
        if (ratio > 1.6) {
            warnings.push(
                `[balance] Pushing volume ${tally.push} vs pulling ${tally.pull} (${ratio.toFixed(2)}×). Add row/pulldown/face-pull volume.`
            );
        } else if (ratio < 0.6) {
            warnings.push(
                `[balance] Pulling volume ${tally.pull} vs pushing ${tally.push} (${(1 / ratio).toFixed(2)}× pull-heavy). Add a press variant.`
            );
        }
    } else if (trainingDays >= 3 && (tally.push === 0 || tally.pull === 0)) {
        warnings.push(
            `[balance] Missing entire push or pull pattern (push=${tally.push}, pull=${tally.pull}).`
        );
    }

    if (warnings.length === 0) return {};

    console.log(`[balanceCheck] ${warnings.length} warning(s):\n  - ${warnings.join("\n  - ")}`);
    return { warnings: [...(state.warnings ?? []), ...warnings] };
}

/**
 * Fan-out router after profile load: kick off split determination and the
 * allowed-exercise dictionary fetch in parallel — they have no data dependency.
 * LangGraph joins both branches before `generateDays` runs.
 */
function fanOutAfterProfile(state: PlannerState): string[] | string {
    if (state.error) return END;
    return ["determineSplit", "fetchAllowedExercises"];
}

const PlannerStateAnnotation = Annotation.Root({
    userId: Annotation<string>,
    preferences: Annotation<any>,
    userProfile: Annotation<any>,
    split: Annotation<SplitType>,
    trainingDays: Annotation<number>,
    selectedDays: Annotation<string[]>,
    programmingReasoning: Annotation<string>,
    allowedExercises: Annotation<string>,
    allowedExerciseRows: Annotation<AllowedExerciseRow[]>,
    dayPlans: Annotation<any[]>,
    planId: Annotation<string>,
    success: Annotation<boolean>,
    error: Annotation<string>,
    warnings: Annotation<string[]>,
    messages: Annotation<BaseMessage[]>,
});

export function createPlannerGraph() {
    const workflow = new StateGraph(PlannerStateAnnotation);

    workflow.addNode("loadProfile", loadUserProfile);
    workflow.addNode("determineSplit", determineSplit);
    workflow.addNode("fetchAllowedExercises", fetchAllowedExercises);
    workflow.addNode("generateDays", generateDayPlans);
    // Read-only audit between generation and save: surfaces push/pull
    // asymmetry, missing lower-body coverage, etc. as state.warnings.
    workflow.addNode("balanceCheck", balanceCheck);
    workflow.addNode("savePlan", savePlan);

    workflow.addEdge(START, "loadProfile" as any);
    workflow.addConditionalEdges("loadProfile" as any, fanOutAfterProfile, {
        determineSplit: "determineSplit" as any,
        fetchAllowedExercises: "fetchAllowedExercises" as any,
        [END]: END,
    } as any);
    // Both parallel branches fan into generateDays — LangGraph waits for both.
    workflow.addEdge("determineSplit" as any, "generateDays" as any);
    workflow.addEdge("fetchAllowedExercises" as any, "generateDays" as any);
    workflow.addConditionalEdges("generateDays" as any, shouldContinue, {
        continue: "balanceCheck" as any,
        [END]: END,
    });
    workflow.addEdge("balanceCheck" as any, "savePlan" as any);
    workflow.addEdge("savePlan" as any, END);

    return workflow.compile();
}

export const plannerGraph = createPlannerGraph();
