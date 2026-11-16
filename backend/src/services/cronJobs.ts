/**
 * Cron Jobs Service
 * 
 * Scheduled tasks for maintaining database integrity
 */

import { supabase } from "./db";

/**
 * Restore daily_workouts rows from snapshots taken when temporary overrides
 * were applied. Runs before the deactivation step below so a single pass
 * handles "expire → revert → deactivate" atomically per override.
 *
 * Without this, `create_temporary_override` permanently mutates the plan even
 * though it promises the user the changes "will automatically revert."
 */
export async function revertExpiredOverrides(): Promise<void> {
    const now = new Date().toISOString();

    const { data: expired, error } = await supabase
        .from("durational_plan_overrides")
        .select("id, user_id, daily_workouts_snapshot")
        .eq("is_active", true)
        .lt("effective_until", now)
        .not("daily_workouts_snapshot", "is", null);

    if (error) {
        if (error.code === "PGRST205" || error.code === "42703") {
            console.log("   Skipping override revert (migration 020 not applied)");
            return;
        }
        console.error("Failed to query expired overrides:", error);
        return;
    }

    if (!expired || expired.length === 0) return;

    let restoredCount = 0;
    for (const override of expired) {
        const snapshot = override.daily_workouts_snapshot as
            | { id: string; exercises_structured: unknown[]; exercises: string[] }[]
            | null;
        if (!Array.isArray(snapshot) || snapshot.length === 0) continue;

        for (const row of snapshot) {
            if (!row?.id) continue;
            const { error: restoreErr } = await supabase
                .from("daily_workouts")
                .update({
                    exercises_structured: row.exercises_structured,
                    exercises: row.exercises,
                })
                .eq("id", row.id);
            if (restoreErr) {
                console.error(
                    `Failed to restore daily_workouts row ${row.id}:`,
                    restoreErr.message
                );
            } else {
                restoredCount++;
            }
        }
    }

    console.log(
        `   Reverted ${restoredCount} daily_workouts row(s) across ${expired.length} expired override(s)`
    );
}

/**
 * Prune LangGraph checkpoint rows. Every chat super-step writes one
 * conversation_state row (~5-7 per turn) and only the latest per thread is
 * ever read back, so without this the table grows forever. Keeps the newest
 * N checkpoints per thread and drops non-head rows older than the age cap
 * (see migration 20260712010000). Skips gracefully until that migration is
 * applied.
 */
export async function pruneConversationCheckpoints(): Promise<void> {
    try {
        const { data, error } = await supabase.rpc("prune_conversation_checkpoints", {
            p_keep_per_thread: 5,
            p_max_age_days: 45,
        });
        if (error) {
            if (error.code === "PGRST202") {
                console.log("   Skipping checkpoint prune (migration 20260712010000 not applied)");
            } else {
                console.error("Checkpoint prune failed:", error.message);
            }
            return;
        }
        const deleted = typeof data === "number" ? data : 0;
        if (deleted > 0) {
            console.log(`   Pruned ${deleted} old conversation_state checkpoint row(s)`);
        }
    } catch (err) {
        console.error("Checkpoint prune threw:", err);
    }
}

/**
 * Clean up expired contexts and overrides
 * Runs every hour to keep database clean
 */
export async function cleanupExpiredContexts(): Promise<void> {
    console.log("Running cleanup job...");

    const now = new Date().toISOString();

    // Try user_contexts first, fallback to user_facts
    try {
        const { data: deletedContexts, error: contextsError } = await supabase
            .from("user_contexts")
            .delete()
            .lt("expires_at", now)
            .select("id");

        if (contextsError && contextsError.code === 'PGRST205') {
            // Table doesn't exist, try alternative name
            console.log("   user_contexts table not found, skipping");
        } else if (contextsError) {
            console.error("Failed to cleanup contexts:", contextsError);
        } else {
            console.log(`   Deleted ${deletedContexts?.length || 0} expired contexts`);
        }
    } catch (err) {
        console.log("   Skipping context cleanup (table may not exist)");
    }

    // Revert mutations from expired overrides FIRST, then mark them inactive
    // in the same pass. Order matters: deactivating before restoring would
    // skip the snapshot lookup since the query filters `is_active = true`.
    try {
        await revertExpiredOverrides();
    } catch (err) {
        console.error("Override revert step failed:", err);
    }

    try {
        await pruneConversationCheckpoints();
    } catch (err) {
        console.error("Checkpoint prune step failed:", err);
    }

    try {
        const { data: deactivatedOverrides, error: overridesError } = await supabase
            .from("durational_plan_overrides")
            .update({ is_active: false })
            .lt("effective_until", now)
            .eq("is_active", true)
            .select("id");

        if (overridesError) {
            if (overridesError.code === "PGRST205" || overridesError.code === "42703") {
                console.log("   durational_plan_overrides not found, skipping deactivation");
            } else {
                console.error("Failed to deactivate overrides:", overridesError);
            }
        } else {
            console.log(`   Deactivated ${deactivatedOverrides?.length || 0} expired overrides`);
        }
    } catch (err) {
        console.log("   Skipping override deactivation (table may not exist)");
    }

    console.log("Cleanup complete");
}

/**
 * Initialize cleanup scheduler
 * Runs cleanup every hour
 */
export function initializeCleanupScheduler(): void {
    // Run immediately on startup
    cleanupExpiredContexts();

    // Then run every hour
    setInterval(cleanupExpiredContexts, 60 * 60 * 1000);

    // Meal-photo orphan sweep: pending captures the user analyzed but never
    // confirmed (abandoned review sheet). Daily is plenty — they're ~200 KB.
    const sweepPendingPhotos = () => {
        void import("./mealPhotoStorage").then(({ sweepOrphanedPendingPhotos }) =>
            sweepOrphanedPendingPhotos(24)
        );
    };
    sweepPendingPhotos();
    setInterval(sweepPendingPhotos, 24 * 60 * 60 * 1000);

    console.log("Cleanup scheduler initialized (runs hourly; photo sweep daily)");
}
