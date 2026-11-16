// Admin Supabase client — service role, RLS-bypassing.
// Use only inside Edge Functions, never expose to the client.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
    if (cached) return cached;

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !key) {
        throw new Error(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the function environment"
        );
    }

    cached = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return cached;
}

/**
 * Constant-time string comparison to prevent timing attacks on shared-secret
 * authentication (RevenueCat webhook Authorization header).
 */
export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Verify that the Supabase user_id refers to an existing auth.users row.
 * Returns true if exists. Used to skip processing for stale or test events.
 */
export async function userExists(
    admin: SupabaseClient,
    userId: string
): Promise<boolean> {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return false;
    return !!data?.user;
}
