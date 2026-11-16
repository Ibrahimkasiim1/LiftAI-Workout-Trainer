/**
 * Exercise Data Integrity Guardrail
 * 
 * Non-blocking startup check that validates exercise data quality.
 * Logs warnings (fails loudly) if data issues are detected.
 * 
 * REQUIRED CHECKS:
 * 1. search_exercises RPC returns gif_path field
 * 2. Sufficient exercises have valid gif_path in database
 * 
 * This guardrail is backend-only and non-blocking (just logs warnings).
 */

import { OpenAIEmbeddings } from "@langchain/openai";
import { supabase } from "./db";

const WARNING_THRESHOLD_PERCENT = 10; // Warn if >10% of exercises missing gif_path

export async function runExerciseDataGuardrail(): Promise<void> {
    console.log("Running exercise data integrity guardrail...");

    try {
        // CHECK 1: Verify search_exercises RPC returns gif_path
        await checkRpcReturnsGifPath();

        // CHECK 2: Verify database has sufficient exercises with gif_path
        await checkDatabaseIntegrity();

        console.log("Exercise data guardrail passed");
    } catch (error) {
        console.error("Exercise data guardrail encountered an error:", error);
        // Non-blocking - just log the error, don't crash the server
    }
}

/**
 * Check that the search_exercises RPC returns gif_path in its response
 */
async function checkRpcReturnsGifPath(): Promise<void> {
    console.log("   Checking search_exercises RPC includes gif_path...");

    try {
        // Generate a simple embedding for testing
        const embeddings = new OpenAIEmbeddings({
            apiKey: process.env.OPENAI_API_KEY,
            modelName: "text-embedding-3-small",
        });

        const testEmbedding = await embeddings.embedQuery("test exercise");
        const embeddingString = `[${testEmbedding.join(",")}]`;

        // Call the RPC
        const { data, error } = await supabase.rpc("search_exercises", {
            query_text: "test exercise",
            query_embedding: embeddingString,
            match_count: 1,
            equipment_filter: null,
        });

        if (error) {
            console.warn("   GUARDRAIL WARNING: search_exercises RPC failed:", error.message);
            console.warn("   This may cause workout generation to fail!");
            return;
        }

        if (!data || data.length === 0) {
            console.warn("   GUARDRAIL WARNING: search_exercises returned 0 results");
            console.warn("   Vector embeddings may not be populated in exercises table");
            return;
        }

        // Check if gif_path is returned (even if null)
        const firstResult = data[0];
        if (!("gif_path" in firstResult)) {
            console.error("   GUARDRAIL CRITICAL: search_exercises RPC does NOT return gif_path!");
            console.error("   All workouts will fail validation!");
            console.error("   FIX: Run migrations/fix_search_exercises_gif_path.sql in Supabase");
            return;
        }

        // Check if gif_path has a value
        if (!firstResult.gif_path) {
            console.error("   GUARDRAIL CRITICAL: search_exercises returns gif_path=NULL!");
            console.error("   Exercise: " + firstResult.name);
            console.error("   This indicates the RPC is not selecting the gif_path column properly");
            console.error("   FIX: Run migrations/fix_search_exercises_gif_path.sql in Supabase");
            return;
        }

        console.log("   search_exercises RPC returns gif_path correctly");
        console.log(`   Sample: ${firstResult.name} → ${firstResult.gif_path}`);

    } catch (error) {
        console.warn("   GUARDRAIL WARNING: Could not verify RPC:", error);
    }
}

/**
 * Check that the database has sufficient exercises with gif_path populated
 */
async function checkDatabaseIntegrity(): Promise<void> {
    console.log("   Checking database exercise gif_path coverage...");

    try {
        // Count total exercises
        const { count: totalCount, error: totalError } = await supabase
            .from("exercises")
            .select("*", { count: "exact", head: true });

        if (totalError) {
            console.warn("   GUARDRAIL WARNING: Could not count exercises:", totalError.message);
            return;
        }

        // Count exercises with gif_path
        const { count: withGifCount, error: gifError } = await supabase
            .from("exercises")
            .select("*", { count: "exact", head: true })
            .not("gif_path", "is", null)
            .neq("gif_path", "");

        if (gifError) {
            console.warn("   GUARDRAIL WARNING: Could not count gif_path coverage:", gifError.message);
            return;
        }

        const total = totalCount ?? 0;
        const withGif = withGifCount ?? 0;
        const missingPercent = total > 0 ? ((total - withGif) / total) * 100 : 0;

        console.log(`   Exercises: ${withGif}/${total} have gif_path (${(100 - missingPercent).toFixed(1)}%)`);

        if (missingPercent > WARNING_THRESHOLD_PERCENT) {
            console.warn(`   GUARDRAIL WARNING: ${missingPercent.toFixed(1)}% of exercises missing gif_path!`);
            console.warn("   This exceeds the ${WARNING_THRESHOLD_PERCENT}% threshold");
            console.warn("   Workouts may fail to generate for some muscle groups");
        } else {
            console.log("   Database exercise gif_path coverage is acceptable");
        }

    } catch (error) {
        console.warn("   GUARDRAIL WARNING: Could not verify database integrity:", error);
    }
}

export default { runExerciseDataGuardrail };
