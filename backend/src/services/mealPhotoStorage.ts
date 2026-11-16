/**
 * Meal photo storage (private `meal-photos` bucket).
 *
 * All writes go through the backend service role (bucket has no user write
 * policies). Layout:
 *   {user_id}/pending/{analysis_id}.jpg  — uploaded on successful analysis,
 *                                          before the user confirms
 *   {user_id}/{log_id}.jpg               — promoted on confirm; referenced by
 *                                          nutrition_logs.image_path
 *
 * Photos are deleted with their log (DELETE /nutrition/log/:id). Orphaned
 * pending files (analyzed but never confirmed) are swept by the daily cron.
 * Every helper is best-effort where losing the image must not lose the log.
 */

import { supabase } from "./db";

export const MEAL_PHOTOS_BUCKET = "meal-photos";

export function pendingPhotoPath(userId: string, analysisId: string): string {
    return `${userId}/pending/${analysisId}.jpg`;
}

export function confirmedPhotoPath(userId: string, logId: string): string {
    return `${userId}/${logId}.jpg`;
}

/**
 * Upload (or overwrite — fix passes reuse the analysis id) the compressed
 * JPEG for a successful analysis. Throws on failure so the route can decide;
 * analysis itself already succeeded, so callers should degrade gracefully.
 */
export async function uploadPendingMealPhoto(
    userId: string,
    analysisId: string,
    jpeg: Buffer
): Promise<string> {
    const path = pendingPhotoPath(userId, analysisId);
    const { error } = await supabase.storage
        .from(MEAL_PHOTOS_BUCKET)
        .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
    if (error) throw new Error(`meal photo upload failed: ${error.message}`);
    return path;
}

/**
 * Promote a pending photo to its permanent per-log path. Returns the new path,
 * or null when the pending object is gone (expired/swept) — the log simply has
 * no thumbnail in that case.
 */
export async function promoteMealPhoto(
    userId: string,
    analysisId: string,
    logId: string
): Promise<string | null> {
    const from = pendingPhotoPath(userId, analysisId);
    const to = confirmedPhotoPath(userId, logId);
    const { error } = await supabase.storage.from(MEAL_PHOTOS_BUCKET).move(from, to);
    if (error) {
        console.warn(`[mealPhotoStorage] promote failed (${from} → ${to}): ${error.message}`);
        return null;
    }
    return to;
}

/** Best-effort delete — used when a log is deleted. Never throws. */
export async function deleteMealPhoto(path: string): Promise<void> {
    try {
        const { error } = await supabase.storage.from(MEAL_PHOTOS_BUCKET).remove([path]);
        if (error) console.warn(`[mealPhotoStorage] delete failed (${path}): ${error.message}`);
    } catch (err) {
        console.warn("[mealPhotoStorage] delete threw (non-fatal):", err);
    }
}

/**
 * Sweep pending photos older than `maxAgeHours` (user analyzed, never
 * confirmed). Called from the daily cleanup cron. Best-effort.
 */
export async function sweepOrphanedPendingPhotos(maxAgeHours = 24): Promise<void> {
    try {
        const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
        // storage.objects is queryable with the service role; one query beats
        // recursively listing every user folder through the storage API.
        const { data, error } = await supabase
            .schema("storage")
            .from("objects")
            .select("name, created_at")
            .eq("bucket_id", MEAL_PHOTOS_BUCKET)
            .like("name", "%/pending/%")
            .lt("created_at", new Date(cutoff).toISOString())
            .limit(500);
        if (error) {
            console.warn(`[mealPhotoStorage] orphan sweep query failed: ${error.message}`);
            return;
        }
        const names = (data ?? []).map((o) => (o as { name: string }).name);
        if (names.length === 0) return;
        const { error: rmError } = await supabase.storage
            .from(MEAL_PHOTOS_BUCKET)
            .remove(names);
        if (rmError) {
            console.warn(`[mealPhotoStorage] orphan sweep remove failed: ${rmError.message}`);
            return;
        }
        console.log(`Swept ${names.length} orphaned pending meal photo(s)`);
    } catch (err) {
        console.warn("[mealPhotoStorage] orphan sweep threw (non-fatal):", err);
    }
}
