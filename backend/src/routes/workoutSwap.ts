import { Request, Response, Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { getUserProfile, supabase } from "../services/db";
import { swapSessionExerciseTool } from "../tools/editorActions";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

function parseEquipment(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [raw];
        } catch {
            return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        }
    }
    return [];
}

function parseInjuries(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [raw];
        } catch {
            return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        }
    }
    return [];
}

// ── GET /api/workout/alternatives ──────────────────────────────────────────

router.get("/api/workout/alternatives", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const exerciseId = req.query.exerciseId as string | undefined;

        if (!exerciseId) {
            return res.status(400).json({ success: false, error: "exerciseId query param is required." });
        }

        // Trust-but-verify: fetch user's equipment and injuries from their profile
        const profile = await getUserProfile(userId);
        const equipment = parseEquipment(profile?.available_equipment);
        const injuries = parseInjuries(profile?.injuries);

        const { data, error } = await supabase.rpc("get_exercise_alternatives", {
            p_current_exercise_id: exerciseId,
            p_user_equipment: equipment.length > 0 ? equipment : null,
            p_injuries: injuries.length > 0 ? injuries : null,
        });

        if (error) throw new Error(error.message);

        return res.status(200).json({
            success: true,
            alternatives: Array.isArray(data) ? data : [],
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: message });
    }
});

// ── POST /api/workout/swap-session-exercise ────────────────────────────────

router.post("/api/workout/swap-session-exercise", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const { sessionId, targetIndex, oldExerciseId, newExerciseId, oldExerciseNameHint } = req.body ?? {};

        if (!sessionId || typeof sessionId !== "string") {
            return res.status(400).json({ success: false, error: "sessionId is required." });
        }
        if (!Number.isInteger(targetIndex) || targetIndex < 0) {
            return res.status(400).json({ success: false, error: "targetIndex must be a non-negative integer." });
        }
        if (!oldExerciseId || typeof oldExerciseId !== "string") {
            return res.status(400).json({ success: false, error: "oldExerciseId is required." });
        }
        if (!newExerciseId || typeof newExerciseId !== "string") {
            return res.status(400).json({ success: false, error: "newExerciseId is required." });
        }

        const result = (await swapSessionExerciseTool.invoke({
            userId,
            session_id: sessionId,
            target_index: targetIndex,
            old_exercise_id: oldExerciseId,
            new_exercise_id: newExerciseId,
            old_exercise_name_hint: oldExerciseNameHint,
        })) as Record<string, unknown> & { success?: boolean };

        if (!result?.success) {
            return res.status(400).json({
                success: false,
                error: (result?.error as string | undefined) ?? "Swap failed.",
            });
        }

        return res.status(200).json({
            success: true,
            userId,
            swappedIndex: result.swappedIndex,
            replacedWith: result.replacedWith,
            message: result.message,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: message });
    }
});

export default router;
