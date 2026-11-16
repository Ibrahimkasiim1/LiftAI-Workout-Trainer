import { Request, Response, Router } from "express";
import { z } from "zod";
import { parseNutritionStringTool } from "../agents/tools";
import { makeUsageTracker } from "../agents/usageTracking";
import type { AuthedRequest } from "../middleware/auth";
import { refundMealAllowance } from "../middleware/quotaGate";
import { supabase } from "../services/db";
import { deleteMealPhoto } from "../services/mealPhotoStorage";
import { getUserTimezone, localTodayInTimezone } from "../services/userTimezone";
import {
  getCachedLookup,
  normalizeQueryKey,
  setCachedLookup,
  type LookupResult,
} from "../services/nutritionLookup";

const router = Router();

const logNutritionRequestSchema = z
  .object({
    raw_text: z.string().min(1).optional(),
    rawText: z.string().min(1).optional(),
    date: z.string().optional(),
  })
  .transform((o) => {
    const text = (o.raw_text ?? o.rawText ?? "").trim();
    return { raw_text: text, date: o.date };
  })
  .refine((o) => o.raw_text.length > 0, { message: "raw_text is required" });

const clarificationOptionSchema = z.object({
  label: z.string().min(1).max(40),
  delta: z.object({
    calories: z.number().int(),
    protein: z.number().int(),
    carbs: z.number().int(),
    fats: z.number().int(),
  }),
});

const clarifyRequestSchema = z.object({
  option: clarificationOptionSchema,
});

type ParsedMacros = {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  vitamin_a_mcg?: number;
  vitamin_c_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
};

type Clarification = {
  question: string;
  options: z.infer<typeof clarificationOptionSchema>[];
};

function clampMacro(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * Lightweight heuristic fallback for nutrition logs when the LLM parser fails.
 * Biased conservatively — better to under-report than to invent calories the
 * user didn't eat. Only used when the model is unreachable.
 */
function estimateMacrosHeuristically(rawText: string): ParsedMacros {
  const text = rawText.toLowerCase();
  const numberMatch = text.match(/\b(\d+(?:\.\d+)?)\b/);
  const qty = Math.min(20, Math.max(1, numberMatch ? Number(numberMatch[1]) : 1));

  let calories = 220;
  let protein = 10;
  let carbs = 18;
  let fats = 8;

  if (/(egg|omelet|omelette)/.test(text)) {
    calories = 78 * qty; protein = 6 * qty; carbs = 1 * qty; fats = 5 * qty;
  } else if (/(chicken|turkey|tuna|salmon|beef|steak)/.test(text)) {
    calories = 220 * qty; protein = 30 * qty; carbs = 2 * qty; fats = 9 * qty;
  } else if (/(rice|pasta|bread|bagel|oat|oatmeal|potato)/.test(text)) {
    calories = 210 * qty; protein = 6 * qty; carbs = 40 * qty; fats = 3 * qty;
  } else if (/(protein shake|whey|protein bar)/.test(text)) {
    calories = 170 * qty; protein = 24 * qty; carbs = 8 * qty; fats = 3 * qty;
  } else if (/(salad|vegetable|veggie)/.test(text)) {
    calories = 120 * qty; protein = 4 * qty; carbs = 16 * qty; fats = 4 * qty;
  } else if (/(pizza|burger|fries|fast food|fried)/.test(text)) {
    calories = 520 * qty; protein = 20 * qty; carbs = 48 * qty; fats = 28 * qty;
  }

  return { calories: clampMacro(calories), protein: clampMacro(protein), carbs: clampMacro(carbs), fats: clampMacro(fats) };
}

router.post("/nutrition/log", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;

    // LangGraph occasionally passes the body as { input: '{"raw_text":"…"}' };
    // unpack that string so Zod can find the fields.
    let rawBody: Record<string, unknown> = req.body as Record<string, unknown>;
    if (rawBody && typeof rawBody.input === "string" && !rawBody.raw_text && !rawBody.rawText) {
      try {
        rawBody = JSON.parse(rawBody.input) as Record<string, unknown>;
      } catch {
        /* fall through; Zod will reject */
      }
    }

    const body = logNutritionRequestSchema.parse(rawBody);
    const normalizedDate =
      body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : localTodayInTimezone(await getUserTimezone(userId)); // user-local today, not UTC

    let parsed: ParsedMacros;
    let clarification: Clarification | null = null;
    let confidence: "high" | "medium" | "low" = "high";
    let source: "cache" | "llm" | "heur" = "llm";

    // Cache check first. Only `high`-confidence rows live in the cache (we
    // never persist a clarification-eligible row), so a hit means we already
    // know the right answer and no clarification UI is needed.
    const queryKey = normalizeQueryKey(body.raw_text);
    const cached = queryKey ? await getCachedLookup(queryKey) : null;

    if (cached) {
      parsed = cached;
      source = "cache";
    } else {
      try {
        const llmParsed = await parseNutritionStringTool.invoke(
          { raw_text: body.raw_text },
          { callbacks: [makeUsageTracker(userId)] }
        );
        parsed = llmParsed;
        confidence = (llmParsed as { confidence?: "high" | "medium" | "low" }).confidence ?? "high";
        const rawClar = (llmParsed as { clarification?: Clarification | null }).clarification ?? null;
        // Only attach clarification when confidence is not high. The model
        // sometimes returns both for hedge reasons; ignore it when redundant.
        clarification = confidence !== "high" ? rawClar : null;

        // Only cache when we're confident the answer is final. Caching a
        // low-confidence row would silently suppress the clarification pill
        // for every future user with the same text.
        if (confidence === "high" && queryKey) {
          await setCachedLookup(queryKey, body.raw_text, {
            source: "llm",
            ...parsed,
          } as LookupResult);
        }
      } catch (parseErr: unknown) {
        console.error("Nutrition parse (LLM) failed:", parseErr);
        parsed = estimateMacrosHeuristically(body.raw_text);
        source = "heur";
      }
    }

    const payload: Record<string, unknown> = {
      user_id: userId,
      date: normalizedDate,
      raw_text: body.raw_text,
      calories: clampMacro(parsed.calories),
      protein: clampMacro(parsed.protein),
      carbs: clampMacro(parsed.carbs),
      fats: clampMacro(parsed.fats),
    };
    if (parsed.vitamin_a_mcg != null) payload.vitamin_a_mcg = clampMacro(parsed.vitamin_a_mcg);
    if (parsed.vitamin_c_mg != null) payload.vitamin_c_mg = clampMacro(parsed.vitamin_c_mg);
    if (parsed.calcium_mg != null) payload.calcium_mg = clampMacro(parsed.calcium_mg);
    if (parsed.iron_mg != null) payload.iron_mg = clampMacro(parsed.iron_mg);

    const { data, error } = await supabase
      .from("nutrition_logs")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      console.error("Failed to insert nutrition log:", error);
      // The quota gate consumed the day's AI meal allowance pre-flight;
      // nothing was saved, so hand it back.
      void refundMealAllowance(userId);
      return res.status(500).json({
        success: false,
        error: `Failed to save nutrition log: ${error.message}`,
      });
    }

    console.log(`Nutrition log saved (source=${source}, confidence=${confidence}, clarify=${Boolean(clarification)})`);

    return res.status(200).json({
      success: true,
      log: data,
      parsed: {
        calories: payload.calories,
        protein: payload.protein,
        carbs: payload.carbs,
        fats: payload.fats,
        vitamin_a_mcg: payload.vitamin_a_mcg ?? null,
        vitamin_c_mg: payload.vitamin_c_mg ?? null,
        calcium_mg: payload.calcium_mg ?? null,
        iron_mg: payload.iron_mg ?? null,
      },
      confidence,
      clarification,
    });
  } catch (err: any) {
    // Both exits below mean no log was saved while the pre-flight count was
    // already consumed — refund it. (The heuristic-parse fallback above does
    // NOT refund: the user still got a saved log.)
    const failedUserId = (req as AuthedRequest).user?.id;
    if (failedUserId) void refundMealAllowance(failedUserId);

    if (err?.name === "ZodError") {
      const issues = err.issues ?? err.errors ?? [];
      const first = issues[0]?.message ?? "Invalid request payload";
      return res.status(400).json({
        success: false,
        error: first,
      });
    }

    console.error("Nutrition route error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to process nutrition log",
      message: err?.message,
    });
  }
});

/**
 * Structured (no-AI) nutrition log — used by the barcode scanner, where Open
 * Food Facts already returned exact macros. Deterministic insert: no LLM call,
 * and deliberately NOT behind requireAiBudget('meal') (see server.ts), so
 * barcode logging is unlimited on the free tier.
 */
const structuredLogRequestSchema = z.object({
  raw_text: z.string().min(1).max(300),
  calories: z.number().min(0).max(20000),
  protein: z.number().min(0).max(2000),
  carbs: z.number().min(0).max(2000),
  fats: z.number().min(0).max(2000),
  date: z.string().optional(),
});

router.post("/nutrition/log-structured", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;
    const body = structuredLogRequestSchema.parse(req.body);
    const normalizedDate =
      body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : localTodayInTimezone(await getUserTimezone(userId)); // user-local today, not UTC

    const payload = {
      user_id: userId,
      date: normalizedDate,
      raw_text: body.raw_text.trim(),
      calories: clampMacro(body.calories),
      protein: clampMacro(body.protein),
      carbs: clampMacro(body.carbs),
      fats: clampMacro(body.fats),
      source: "barcode", // provenance for photo-vs-text-vs-barcode analytics
    };

    const { data, error } = await supabase
      .from("nutrition_logs")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      console.error("Failed to insert structured nutrition log:", error);
      return res.status(500).json({
        success: false,
        error: `Failed to save nutrition log: ${error.message}`,
      });
    }

    console.log("Nutrition log saved (source=barcode)");

    // Same response shape as POST /nutrition/log so the client can reuse the
    // resolve pipeline; barcode macros are exact → high confidence, no pills.
    return res.status(200).json({
      success: true,
      log: data,
      parsed: {
        calories: payload.calories,
        protein: payload.protein,
        carbs: payload.carbs,
        fats: payload.fats,
        vitamin_a_mcg: null,
        vitamin_c_mg: null,
        calcium_mg: null,
        iron_mg: null,
      },
      confidence: "high",
      clarification: null,
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: err.issues?.[0]?.message ?? "Invalid structured log payload",
      });
    }
    console.error("Structured nutrition route error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to save nutrition log",
      message: err?.message,
    });
  }
});

/**
 * Apply a clarification pill to an existing log.
 *
 * The frontend sends the option the user tapped (label + macro delta). We
 * verify the row belongs to the caller, add the deltas, and write back. We
 * also write the resolved combo to `nutrition_cache` keyed on
 * `<raw_text>::<option label>` so the same raw text + same clarification
 * answer becomes a free cache hit next time — no LLM call needed.
 */
router.patch("/nutrition/log/:id/clarify", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;
    const logId = req.params.id;
    const body = clarifyRequestSchema.parse(req.body);

    const { data: row, error: fetchErr } = await supabase
      .from("nutrition_logs")
      .select("*")
      .eq("id", logId)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !row) {
      return res.status(404).json({ success: false, error: "Nutrition log not found" });
    }

    const updated = {
      calories: clampMacro(Number(row.calories) + body.option.delta.calories),
      protein: clampMacro(Number(row.protein) + body.option.delta.protein),
      carbs: clampMacro(Number(row.carbs) + body.option.delta.carbs),
      fats: clampMacro(Number(row.fats) + body.option.delta.fats),
    };

    const { data: updatedRow, error: updateErr } = await supabase
      .from("nutrition_logs")
      .update({
        ...updated,
        raw_text: `${row.raw_text} — ${body.option.label}`,
      })
      .eq("id", logId)
      .select("*")
      .single();

    if (updateErr) {
      console.error("Failed to apply clarification:", updateErr);
      return res.status(500).json({ success: false, error: updateErr.message });
    }

    const cacheKey = normalizeQueryKey(`${row.raw_text}::${body.option.label}`);
    if (cacheKey) {
      await setCachedLookup(cacheKey, `${row.raw_text} — ${body.option.label}`, {
        source: "llm",
        calories: updated.calories,
        protein: updated.protein,
        carbs: updated.carbs,
        fats: updated.fats,
        vitamin_a_mcg: row.vitamin_a_mcg ?? undefined,
        vitamin_c_mg: row.vitamin_c_mg ?? undefined,
        calcium_mg: row.calcium_mg ?? undefined,
        iron_mg: row.iron_mg ?? undefined,
      });
    }

    return res.status(200).json({ success: true, log: updatedRow });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: err.issues?.[0]?.message ?? "Invalid clarification payload",
      });
    }
    console.error("Clarify route error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to apply clarification",
      message: err?.message,
    });
  }
});

/**
 * Re-parse an existing log with new raw_text. Used by tap-to-edit on the
 * logged-meals list. Same lookup chain as POST: cache → LLM → heuristic.
 */
const editRequestSchema = z.object({
  raw_text: z.string().min(1),
});

router.patch("/nutrition/log/:id", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;
    const logId = req.params.id;
    const body = editRequestSchema.parse(req.body);
    const rawText = body.raw_text.trim();
    if (!rawText) {
      return res.status(400).json({ success: false, error: "raw_text is required" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("nutrition_logs")
      .select("id, user_id")
      .eq("id", logId)
      .eq("user_id", userId)
      .single();
    if (fetchErr || !existing) {
      return res.status(404).json({ success: false, error: "Nutrition log not found" });
    }

    let parsed: ParsedMacros;
    let clarification: Clarification | null = null;
    let confidence: "high" | "medium" | "low" = "high";

    const queryKey = normalizeQueryKey(rawText);
    const cached = queryKey ? await getCachedLookup(queryKey) : null;
    if (cached) {
      parsed = cached;
    } else {
      try {
        const llmParsed = await parseNutritionStringTool.invoke(
          { raw_text: rawText },
          { callbacks: [makeUsageTracker(userId)] }
        );
        parsed = llmParsed;
        confidence = (llmParsed as { confidence?: "high" | "medium" | "low" }).confidence ?? "high";
        const rawClar = (llmParsed as { clarification?: Clarification | null }).clarification ?? null;
        clarification = confidence !== "high" ? rawClar : null;
        if (confidence === "high" && queryKey) {
          await setCachedLookup(queryKey, rawText, { source: "llm", ...parsed } as LookupResult);
        }
      } catch (parseErr) {
        console.error("Nutrition re-parse failed:", parseErr);
        parsed = estimateMacrosHeuristically(rawText);
      }
    }

    const update: Record<string, unknown> = {
      raw_text: rawText,
      calories: clampMacro(parsed.calories),
      protein: clampMacro(parsed.protein),
      carbs: clampMacro(parsed.carbs),
      fats: clampMacro(parsed.fats),
      vitamin_a_mcg: parsed.vitamin_a_mcg != null ? clampMacro(parsed.vitamin_a_mcg) : null,
      vitamin_c_mg: parsed.vitamin_c_mg != null ? clampMacro(parsed.vitamin_c_mg) : null,
      calcium_mg: parsed.calcium_mg != null ? clampMacro(parsed.calcium_mg) : null,
      iron_mg: parsed.iron_mg != null ? clampMacro(parsed.iron_mg) : null,
    };

    const { data, error } = await supabase
      .from("nutrition_logs")
      .update(update)
      .eq("id", logId)
      .select("*")
      .single();
    if (error) {
      console.error("Failed to update nutrition log:", error);
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      log: data,
      parsed: {
        calories: update.calories,
        protein: update.protein,
        carbs: update.carbs,
        fats: update.fats,
        vitamin_a_mcg: update.vitamin_a_mcg ?? null,
        vitamin_c_mg: update.vitamin_c_mg ?? null,
        calcium_mg: update.calcium_mg ?? null,
        iron_mg: update.iron_mg ?? null,
      },
      confidence,
      clarification,
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({
        success: false,
        error: err.issues?.[0]?.message ?? "Invalid edit payload",
      });
    }
    console.error("Edit nutrition log error:", err);
    return res.status(500).json({ success: false, error: "Failed to update log", message: err?.message });
  }
});

/**
 * Delete a single nutrition log.
 */
router.delete("/nutrition/log/:id", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user.id;
    const logId = req.params.id;
    // Photo logs own a stored image — read its path first so the photo dies
    // with the log (privacy promise: photos exist only to display the log).
    const { data: row } = await supabase
      .from("nutrition_logs")
      .select("image_path")
      .eq("id", logId)
      .eq("user_id", userId)
      .maybeSingle();
    const { error } = await supabase
      .from("nutrition_logs")
      .delete()
      .eq("id", logId)
      .eq("user_id", userId);
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    const imagePath = (row as { image_path?: string | null } | null)?.image_path;
    if (imagePath) void deleteMealPhoto(imagePath);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message ?? "Failed to delete log" });
  }
});

export default router;
