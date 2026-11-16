/**
 * Photo food logging routes ("Snap a Meal") — docs/PRD-photo-food-logging.md.
 *
 * Two-step flow, because the user edits between analysis and save:
 *
 *   POST /nutrition/log-photo          gated by requireAiBudget('meal') for
 *                                      first-pass scans (see server.ts); "Fix
 *                                      with a note" re-analyses are free with
 *                                      a server-enforced cap of 2 per scan.
 *   POST /nutrition/log-photo/confirm  deterministic, no AI, no quota — like
 *                                      /nutrition/log-structured. Also handles
 *                                      re-saving an existing photo log (edit).
 *   POST /nutrition/parse-item         tiny text→macros parse for the Plate
 *                                      card's "+ Add item" row. No DB write.
 *                                      Cost-backstop gated only (cache-first).
 *
 * Refund rules (mirrors /nutrition/log): the quota gate consumes the meal
 * count pre-flight, so we hand it back on model/transport failure and on
 * no_food/unclear results. A successful analysis the user abandons is NOT
 * refunded — the AI work happened.
 *
 * Fix-cap sessions are in-memory (single-instance deploy). A server restart
 * mid-review surfaces as fix_unavailable (409) — the client degrades to
 * manual editing; nothing is lost.
 */

import { randomUUID } from "crypto";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { parseNutritionStringTool } from "../agents/tools";
import { makeUsageTracker } from "../agents/usageTracking";
import type { AuthedRequest } from "../middleware/auth";
import { refundMealAllowance } from "../middleware/quotaGate";
import { supabase } from "../services/db";
import {
    analyzeMealPhoto,
    type MealPhotoAnalysis,
} from "../services/mealPhotoAnalysis";
import { promoteMealPhoto, uploadPendingMealPhoto } from "../services/mealPhotoStorage";
import { getUserTimezone, localTodayInTimezone } from "../services/userTimezone";

const router = Router();

/**
 * Snap-a-Meal is a premium-only feature. Defensive default: on a lookup
 * failure the user is treated as free — better to make a paying user retry
 * than to give the paid feature away on errors (same policy as the
 * saved-workouts cap in savedWorkoutActions).
 */
async function isPremiumTier(userId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from("user_quotas")
        .select("tier_type")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        console.warn(`[nutritionPhoto] tier lookup failed for ${userId}: ${error.message}`);
        return false;
    }
    return (data?.tier_type ?? "ad_supported") === "premium";
}

export function photoLoggingEnabled(): boolean {
    // Kill switch: set PHOTO_LOGGING_ENABLED=false to disable the endpoints
    // without a deploy rollback. Default ON.
    return process.env.PHOTO_LOGGING_ENABLED !== "false";
}

// ── Fix-cap sessions ────────────────────────────────────────────────────────

const MAX_FIXES_PER_SCAN = 2;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // plenty for a review sheet left open

interface AnalysisSession {
    userId: string;
    fixCount: number;
    createdAt: number;
}

const sessions = new Map<string, AnalysisSession>();

function pruneSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) {
        if (s.createdAt < cutoff) sessions.delete(id);
    }
}
const pruneTimer = setInterval(pruneSessions, 15 * 60 * 1000) as unknown as NodeJS.Timeout;
pruneTimer.unref?.();

// ── Schemas ─────────────────────────────────────────────────────────────────

// ~2 MB of base64 ≈ 1.5 MB JPEG — far above the ~150–270 KB a properly
// compressed 1024px capture produces, low enough to bound abuse.
const MAX_IMAGE_B64_CHARS = 2_000_000;

const analyzeRequestSchema = z.object({
    image_base64: z
        .string()
        .min(100)
        .max(MAX_IMAGE_B64_CHARS)
        .transform((s) => s.replace(/^data:image\/[a-z]+;base64,/, "")),
    caption: z.string().max(200).optional(),
    date: z.string().optional(),
    // LiDAR scale measurement from iPhone Pro captures. Bounded to sane
    // handheld ranges so a bad client can't poison the prompt.
    depth: z
        .object({
            lidar: z.boolean().optional(),
            subject_distance_cm: z.number().min(5).max(500),
            field_width_cm: z.number().min(5).max(1000).nullable().optional(),
        })
        .optional(),
    fix: z
        .object({
            analysis_id: z.string().uuid(),
            note: z.string().min(1).max(280),
            prior_result: z.unknown(),
        })
        .optional(),
});

const confirmItemSchema = z.object({
    name: z.string().min(1).max(120),
    portion: z.string().max(60).default(""),
    grams: z.number().int().nonnegative().nullable().optional(),
    calories: z.number().min(0).max(20000),
    protein: z.number().min(0).max(2000),
    carbs: z.number().min(0).max(2000),
    fats: z.number().min(0).max(2000),
    confidence: z.enum(["high", "medium", "low"]).optional(),
});

const confirmRequestSchema = z
    .object({
        analysis_id: z.string().uuid().optional(),
        log_id: z.string().uuid().optional(),
        meal_name: z.string().min(1).max(140),
        date: z.string().optional(),
        items: z.array(confirmItemSchema).min(1).max(16),
    })
    .refine((o) => o.analysis_id || o.log_id, {
        message: "analysis_id or log_id is required",
    });

const parseItemRequestSchema = z.object({
    raw_text: z.string().min(1).max(200),
});

function clampMacro(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.round(value));
}

function sumItems(items: Array<{ calories: number; protein: number; carbs: number; fats: number }>) {
    return {
        calories: clampMacro(items.reduce((s, i) => s + i.calories, 0)),
        protein: clampMacro(items.reduce((s, i) => s + i.protein, 0)),
        carbs: clampMacro(items.reduce((s, i) => s + i.carbs, 0)),
        fats: clampMacro(items.reduce((s, i) => s + i.fats, 0)),
    };
}

/** "morning" | "midday" | "evening" | "late night" in the user's timezone. */
function mealTimeOfDay(timezone: string): string {
    try {
        const hour = Number(
            new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                hour: "numeric",
                hour12: false,
            }).format(new Date())
        );
        if (hour >= 5 && hour <= 10) return "morning";
        if (hour >= 11 && hour <= 15) return "midday";
        if (hour >= 16 && hour <= 21) return "evening";
        return "late night";
    } catch {
        return "unknown";
    }
}

async function getGoalDirection(userId: string): Promise<string | null> {
    try {
        const { data } = await supabase
            .from("user_profiles")
            .select("goal")
            .eq("id", userId)
            .maybeSingle();
        const goal = (data as { goal?: unknown } | null)?.goal;
        return typeof goal === "string" && goal.length > 0 ? goal.replace(/_/g, " ") : null;
    } catch {
        return null;
    }
}

// ── Analyze ─────────────────────────────────────────────────────────────────

router.post("/nutrition/log-photo", async (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).user.id;
    // Must mirror the gate's decision in server.ts EXACTLY (raw-body `fix`
    // presence): a malformed fix body throws in schema parsing below, and
    // refunding a count the gate never consumed would mint free scans.
    const isInitialScan = !(req.body as { fix?: unknown } | undefined)?.fix;

    try {
        if (!photoLoggingEnabled()) {
            return res.status(503).json({ success: false, error: "feature_disabled" });
        }

        // Premium-only: the client gates before capture reaches us, so this is
        // the enforcement backstop (a patched client must not get free vision
        // calls). The meal count the quota gate consumed pre-flight is handed
        // back — a rejected scan must never cost the free tier's daily log.
        if (!(await isPremiumTier(userId))) {
            if (isInitialScan) void refundMealAllowance(userId);
            return res.status(403).json({ success: false, error: "premium_required" });
        }

        const body = analyzeRequestSchema.parse(req.body);

        let analysisId: string;
        if (body.fix) {
            // Free correction pass — must reference a real, gated analysis by
            // the same user with fixes remaining. Anything else is either a
            // quota-bypass attempt or a lost session (server restart): reject
            // without an LLM call and let the client degrade to manual edits.
            const session = sessions.get(body.fix.analysis_id);
            if (!session || session.userId !== userId) {
                return res.status(409).json({ success: false, error: "fix_unavailable" });
            }
            if (session.fixCount >= MAX_FIXES_PER_SCAN) {
                return res.status(429).json({ success: false, error: "fix_limit_reached" });
            }
            session.fixCount += 1;
            analysisId = body.fix.analysis_id;
        } else {
            analysisId = randomUUID();
        }

        const timezone = await getUserTimezone(userId);
        const goalDirection = await getGoalDirection(userId);

        const { analysis, modelName } = await analyzeMealPhoto({
            userId,
            imageBase64: body.image_base64,
            caption: body.caption ?? null,
            depth: body.depth
                ? {
                      subjectDistanceCm: body.depth.subject_distance_cm,
                      fieldWidthCm: body.depth.field_width_cm ?? null,
                  }
                : null,
            fix: body.fix
                ? { priorResult: body.fix.prior_result, note: body.fix.note }
                : null,
            mealTimeOfDay: mealTimeOfDay(timezone),
            goalDirection,
        });

        if (analysis.photo_quality !== "ok") {
            // No usable result — hand the day's meal count back (initial scans
            // only; fixes never consumed one). Never store the photo.
            if (isInitialScan) void refundMealAllowance(userId);
            console.log(`Meal photo analysis: ${analysis.photo_quality} (refund=${isInitialScan})`);
            return res.status(200).json({
                success: true,
                analysis: {
                    analysis_id: null,
                    photo_quality: analysis.photo_quality,
                    meal_name: null,
                    items: [],
                    totals: { calories: 0, protein: 0, carbs: 0, fats: 0 },
                    confidence: "low",
                    clarification: null,
                    flags: { packaged: false, blended: false, multi_plate: false },
                    fixes_remaining: 0,
                },
            });
        }

        if (isInitialScan) {
            sessions.set(analysisId, { userId, fixCount: 0, createdAt: Date.now() });
        }

        // Persist the compressed capture so confirm can promote it. Losing the
        // image must not lose the analysis — degrade to a photo-less log.
        try {
            await uploadPendingMealPhoto(userId, analysisId, Buffer.from(body.image_base64, "base64"));
        } catch (uploadErr) {
            console.warn("[nutritionPhoto] pending upload failed (log will have no photo):", uploadErr);
        }

        const items = analysis.items.map((i) => ({
            name: i.name,
            portion: i.portion,
            grams: i.grams ?? null,
            calories: clampMacro(i.calories),
            protein: clampMacro(i.protein),
            carbs: clampMacro(i.carbs),
            fats: clampMacro(i.fats),
            confidence: i.confidence ?? "medium",
        }));

        const session = sessions.get(analysisId);
        const fixesRemaining = Math.max(0, MAX_FIXES_PER_SCAN - (session?.fixCount ?? 0));

        console.log(
            `Meal photo analyzed (model=${modelName}, items=${items.length}, confidence=${analysis.confidence}, fix=${!isInitialScan})`
        );

        return res.status(200).json({
            success: true,
            analysis: {
                analysis_id: analysisId,
                photo_quality: "ok",
                meal_name: analysis.meal_name || "Meal",
                items,
                totals: sumItems(items),
                confidence: analysis.confidence,
                clarification: analysis.confidence !== "high" ? analysis.clarification ?? null : null,
                flags: analysis.flags,
                fixes_remaining: fixesRemaining,
            },
        });
    } catch (err: any) {
        // Model/transport/validation failure → nothing saved; refund the
        // pre-flight count for initial scans.
        if (isInitialScan) void refundMealAllowance(userId);

        if (err?.name === "ZodError") {
            return res.status(400).json({
                success: false,
                error: err.issues?.[0]?.message ?? "Invalid photo log payload",
            });
        }
        console.error("Meal photo analysis failed:", err);
        return res.status(502).json({ success: false, error: "analysis_failed" });
    }
});

// ── Confirm (deterministic, no AI, no quota) ────────────────────────────────

router.post("/nutrition/log-photo/confirm", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const body = confirmRequestSchema.parse(req.body);

        const items = body.items.map((i) => ({
            name: i.name.trim(),
            portion: i.portion.trim(),
            grams: i.grams ?? null,
            calories: clampMacro(i.calories),
            protein: clampMacro(i.protein),
            carbs: clampMacro(i.carbs),
            fats: clampMacro(i.fats),
            confidence: i.confidence ?? "medium",
        }));
        const totals = sumItems(items);
        const mealName = body.meal_name.trim();

        // Edit mode: re-save an existing photo log's Plate card.
        if (body.log_id) {
            const { data: existing, error: fetchErr } = await supabase
                .from("nutrition_logs")
                .select("id, user_id, source")
                .eq("id", body.log_id)
                .eq("user_id", userId)
                .single();
            if (fetchErr || !existing) {
                return res.status(404).json({ success: false, error: "Nutrition log not found" });
            }

            const { data, error } = await supabase
                .from("nutrition_logs")
                .update({ raw_text: mealName, ...totals, items })
                .eq("id", body.log_id)
                .select("*")
                .single();
            if (error) {
                console.error("Failed to update photo log:", error);
                return res.status(500).json({ success: false, error: error.message });
            }
            return res.status(200).json({
                success: true,
                log: data,
                parsed: { ...totals, vitamin_a_mcg: null, vitamin_c_mg: null, calcium_mg: null, iron_mg: null },
                confidence: "high",
                clarification: null,
            });
        }

        // Insert mode: new photo log from a fresh analysis.
        const normalizedDate =
            body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
                ? body.date
                : localTodayInTimezone(await getUserTimezone(userId)); // user-local today, not UTC

        const { data, error } = await supabase
            .from("nutrition_logs")
            .insert({
                user_id: userId,
                date: normalizedDate,
                raw_text: mealName,
                ...totals,
                source: "photo",
                items,
            })
            .select("*")
            .single();

        if (error) {
            console.error("Failed to insert photo log:", error);
            return res.status(500).json({
                success: false,
                error: `Failed to save nutrition log: ${error.message}`,
            });
        }

        // Move the pending capture to its permanent per-log path. Best-effort:
        // a missing/failed image leaves image_path null, the log stands.
        let imagePath: string | null = null;
        if (body.analysis_id) {
            imagePath = await promoteMealPhoto(userId, body.analysis_id, data.id);
            if (imagePath) {
                const { error: pathErr } = await supabase
                    .from("nutrition_logs")
                    .update({ image_path: imagePath })
                    .eq("id", data.id);
                if (pathErr) console.warn("[nutritionPhoto] image_path update failed:", pathErr.message);
            }
            sessions.delete(body.analysis_id);
        }

        console.log(`Nutrition log saved (source=photo, items=${items.length})`);

        return res.status(200).json({
            success: true,
            log: { ...data, image_path: imagePath },
            parsed: { ...totals, vitamin_a_mcg: null, vitamin_c_mg: null, calcium_mg: null, iron_mg: null },
            confidence: "high",
            clarification: null,
        });
    } catch (err: any) {
        if (err?.name === "ZodError") {
            return res.status(400).json({
                success: false,
                error: err.issues?.[0]?.message ?? "Invalid confirm payload",
            });
        }
        console.error("Photo confirm route error:", err);
        return res.status(500).json({ success: false, error: "Failed to save photo log" });
    }
});

// ── Parse a single "+ Add item" line (no DB write) ──────────────────────────

router.post("/nutrition/parse-item", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const body = parseItemRequestSchema.parse(req.body);
        const rawText = body.raw_text.trim();

        // Same cache-first parser as typed logs — a repeat of "2 eggs" is free.
        const parsed = await parseNutritionStringTool.invoke(
            { raw_text: rawText },
            { callbacks: [makeUsageTracker(userId)] }
        );

        return res.status(200).json({
            success: true,
            item: {
                name: rawText,
                portion: "",
                grams: null,
                calories: clampMacro(parsed.calories),
                protein: clampMacro(parsed.protein),
                carbs: clampMacro(parsed.carbs),
                fats: clampMacro(parsed.fats),
                confidence: (parsed as { confidence?: string }).confidence ?? "medium",
            },
        });
    } catch (err: any) {
        if (err?.name === "ZodError") {
            return res.status(400).json({
                success: false,
                error: err.issues?.[0]?.message ?? "Invalid parse payload",
            });
        }
        console.error("parse-item route error:", err);
        return res.status(502).json({ success: false, error: "parse_failed" });
    }
});

export default router;
