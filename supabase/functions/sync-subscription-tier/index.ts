// On-demand fallback sync. The client calls this on app launch (or after
// `Purchases.logIn` completes) to make sure user_quotas.tier_type matches
// what RevenueCat reports — for the case where the webhook hasn't fired yet
// or got dropped.
//
// Auth model:
//   The caller must provide their Supabase JWT in the Authorization header.
//   We resolve the user_id from the JWT (server-side, so spoofing is impossible)
//   then call the RevenueCat REST **v2** API with the *server-only* secret key.
//
// Environment variables:
//   REVENUECAT_V2_API_KEY      — RevenueCat **v2** secret API key (sk_…) with
//                                Customer information read permission
//   REVENUECAT_PROJECT_ID      — RevenueCat v2 project id (the customers API is
//                                project-scoped: /v2/projects/{id}/customers/…)
//   SUPABASE_URL               — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  — auto-injected
//   SUPABASE_ANON_KEY          — auto-injected (used to verify caller's JWT)

import { corsHeaders, preflight } from "../_shared/cors.ts";
import { getAdminClient, userExists } from "../_shared/admin.ts";
import {
    resolveTierFromV2ActiveEntitlements,
    TierType,
    V2ActiveEntitlementItem,
} from "../_shared/tier.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

/**
 * Fetch a customer's active entitlements from the RevenueCat **v2** API.
 *
 * `sk_…` keys are v2 keys and are rejected by the v1 REST API (403), so we use
 * the project-scoped v2 customers endpoint. `expand=items.entitlement` nests the
 * entitlement object so we can match by `lookup_key`.
 *
 * A 404 means RevenueCat has never seen this customer (no purchases) — that's a
 * normal "free user" state, surfaced as an empty item list rather than an error.
 */
async function fetchActiveEntitlements(
    apiKey: string,
    projectId: string,
    customerId: string
): Promise<{ items?: V2ActiveEntitlementItem[]; status: number; body: string }> {
    const url =
        `https://api.revenuecat.com/v2/projects/${encodeURIComponent(projectId)}` +
        `/customers/${encodeURIComponent(customerId)}/active_entitlements` +
        `?expand=items.entitlement`;

    const resp = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
        },
    });

    const text = await resp.text();

    // 404 = unknown customer (never purchased). Treat as "no active entitlements".
    if (resp.status === 404) {
        return { status: 404, body: text, items: [] };
    }
    if (!resp.ok) {
        return { status: resp.status, body: text };
    }

    try {
        const json = JSON.parse(text) as { items?: V2ActiveEntitlementItem[] };
        return { status: resp.status, body: text, items: json.items ?? [] };
    } catch {
        return { status: resp.status, body: text };
    }
}

Deno.serve(async (req: Request) => {
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "POST") {
        return jsonResponse(405, { error: "method not allowed" });
    }

    const apiKey = Deno.env.get("REVENUECAT_V2_API_KEY");
    if (!apiKey) {
        console.error("REVENUECAT_V2_API_KEY not configured");
        return jsonResponse(500, { error: "server not configured" });
    }

    const projectId = Deno.env.get("REVENUECAT_PROJECT_ID");
    if (!projectId) {
        console.error("REVENUECAT_PROJECT_ID not configured");
        return jsonResponse(500, { error: "server not configured" });
    }

    // Verify the caller's JWT against Supabase Auth. We use a separate client
    // (anon key) for token validation, then the admin client for the RPC.
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
        return jsonResponse(401, { error: "missing bearer token" });
    }
    const jwt = authHeader.slice("Bearer ".length);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: userResult, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userResult?.user) {
        return jsonResponse(401, { error: "invalid token" });
    }
    const userId = userResult.user.id;

    // Fetch their RevenueCat state via the v2 customers API. A 404 (unknown
    // customer / never purchased) is normalized to an empty list inside
    // fetchActiveEntitlements; any other 4xx/5xx is a real upstream problem.
    const rc = await fetchActiveEntitlements(apiKey, projectId, userId);

    if (rc.items === undefined) {
        console.error(`[sync] RevenueCat ${rc.status}: ${rc.body}`);
        return jsonResponse(502, { error: "revenuecat upstream error", status: rc.status });
    }

    const tier: TierType = resolveTierFromV2ActiveEntitlements(rc.items);

    const admin = getAdminClient();

    // Belt-and-suspenders: confirm user still exists before writing.
    const exists = await userExists(admin, userId);
    if (!exists) {
        return jsonResponse(404, { error: "user not found" });
    }

    const { data, error } = await admin.rpc("set_user_tier", {
        p_user_id: userId,
        p_tier_type: tier,
    });

    if (error) {
        console.error(`[sync] set_user_tier failed for ${userId}: ${error.message}`);
        return jsonResponse(500, { error: "set_user_tier failed", message: error.message });
    }

    console.log(`[sync] ${userId} → ${tier}`);
    return jsonResponse(200, { ok: true, tier_type: tier, result: data });
});
