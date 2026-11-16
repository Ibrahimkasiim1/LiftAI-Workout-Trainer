/**
 * Coach memory routes — the "what I know about you" surface.
 *
 * The memory extractor writes categorized facts to coach_memories; these
 * endpoints let the app show them to the user and let the user delete
 * (soft-archive) any of them. Trust + GDPR surface: users can always see and
 * remove what the coach remembers.
 *
 * Auth-scoped via requireAuth (mounted in server.ts): rows are always filtered
 * by the session user id, so users can only ever see/delete their own memories.
 */

import { Request, Response, Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { supabase } from "../services/db";
import { archiveCoachMemory } from "../services/longTermMemory";

const router = Router();

router.get("/memories", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const { data, error } = await supabase
            .from("coach_memories")
            .select("id, category, fact, confidence, source, created_at, last_seen_at")
            .eq("user_id", userId)
            .is("archived_at", null)
            .order("last_seen_at", { ascending: false })
            .limit(200);

        if (error) {
            console.error("memories list error:", error.message);
            return res.status(500).json({ success: false, error: "Failed to load memories" });
        }
        res.json({ success: true, memories: data ?? [] });
    } catch (err: any) {
        console.error("memories list error:", err);
        res.status(500).json({ success: false, error: err?.message ?? "Failed to load memories" });
    }
});

router.delete("/memories/:id", async (req: Request, res: Response) => {
    try {
        const userId = (req as AuthedRequest).user.id;
        const id = String(req.params.id ?? "").trim();
        if (!id) {
            return res.status(400).json({ success: false, error: "memory id is required" });
        }
        // archiveCoachMemory filters on user_id, so a foreign id archives 0 rows.
        const archived = await archiveCoachMemory(userId, { id });
        if (archived === 0) {
            return res.status(404).json({ success: false, error: "Memory not found" });
        }
        console.log(`Archived coach memory ${id} for ${userId}`);
        res.json({ success: true });
    } catch (err: any) {
        console.error("memory delete error:", err);
        res.status(500).json({ success: false, error: err?.message ?? "Failed to delete memory" });
    }
});

export default router;
