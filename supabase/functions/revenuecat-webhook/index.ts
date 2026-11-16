// RevenueCat webhook receiver.
//
// Auth model:
//   RevenueCat lets you set a static "Authorization" header value in the
//   dashboard. RevenueCat sends that exact value on every webhook request.
//   We compare in constant time against REVENUECAT_WEBHOOK_SECRET.
//
// Environment variables (set via `supabase secrets set …`):
//   REVENUECAT_WEBHOOK_SECRET  — shared secret pasted into RevenueCat dashboard
//   SUPABASE_URL               — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  — auto-injected
//
// Behavior:
//   1. OPTIONS → CORS preflight (RevenueCat doesn't preflight, but harmless)
//   2. POST    → verify Authorization, parse event, resolve tier, RPC update
//   3. Always returns 200 unless auth fails. RevenueCat retries on non-2xx,
//      and we'd rather log+skip than retry-loop on a malformed event.

import { corsHeaders, preflight } from "../_shared/cors.ts";
import { constantTimeEqual, getAdminClient, userExists } from "../_shared/admin.ts";
import {
    resolveSupabaseUserId,
    resolveTierFromEvent,
    resolveTransferActions,
    TierType,
} from "../_shared/tier.ts";

interface WebhookPayload {
    event?: {
        type?: string;
        id?: string;
        app_user_id?: string;
        original_app_user_id?: string;
        aliases?: string[];
        entitlement_ids?: string[] | null;
        expiration_at_ms?: number | null;
        event_timestamp_ms?: number | null;
        // TRANSFER-only: the app_user_ids that lost / gained the purchases.
        transferred_from?: string[];
        transferred_to?: string[];
    };
    api_version?: string;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

Deno.serve(async (req: Request) => {
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "POST") {
        return jsonResponse(405, { error: "method not allowed" });
    }

    const expected = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
    if (!expected) {
        console.error("REVENUECAT_WEBHOOK_SECRET not configured");
        return jsonResponse(500, { error: "server not configured" });
    }

    const provided = req.headers.get("authorization") ?? "";
    if (!constantTimeEqual(provided, expected)) {
        // Don't echo what we expected; just reject.
        return jsonResponse(401, { error: "unauthorized" });
    }

    let payload: WebhookPayload;
    try {
        payload = (await req.json()) as WebhookPayload;
    } catch {
        return jsonResponse(400, { error: "invalid json" });
    }

    const event = payload.event;
    if (!event || typeof event.type !== "string") {
        return jsonResponse(400, { error: "missing event.type" });
    }

    // TRANSFER affects *two* users at once (old owner loses access, new owner
    // gains it), so it can't go through the single-user path below. Reconcile
    // each side independently from `transferred_from` / `transferred_to`.
    if (event.type === "TRANSFER") {
        const actions = resolveTransferActions(event);
        if (actions.length === 0) {
            console.log(
                `[webhook] TRANSFER ${event.id ?? "?"} skipped: no UUID-identified users`,
                { transferred_to: event.transferred_to, transferred_from: event.transferred_from }
            );
            return jsonResponse(200, { ok: true, skipped: "transfer_no_uuid" });
        }

        const admin = getAdminClient();
        const results: Array<{ user_id: string; tier: TierType; applied: boolean; reason: string }> = [];

        for (const action of actions) {
            const exists = await userExists(admin, action.userId);
            if (!exists) {
                console.warn(
                    `[webhook] TRANSFER ${event.id ?? "?"} skip ${action.userId}: user not found in auth.users`
                );
                results.push({ user_id: action.userId, tier: action.tier, applied: false, reason: "user_not_found" });
                continue;
            }

            const { error } = await admin.rpc("set_user_tier", {
                p_user_id: action.userId,
                p_tier_type: action.tier,
            });
            if (error) {
                console.error(
                    `[webhook] TRANSFER set_user_tier failed for ${action.userId}: ${error.message}`,
                    { event_id: event.id }
                );
                // 500 → RevenueCat retries the whole event. set_user_tier is an
                // idempotent upsert, so re-applying the other actions is safe.
                return jsonResponse(500, { error: "set_user_tier failed", message: error.message });
            }

            console.log(
                `[webhook] TRANSFER ${event.id ?? "?"} → ${action.tier} for ${action.userId} :: ${action.reason}`
            );
            results.push({ user_id: action.userId, tier: action.tier, applied: true, reason: action.reason });
        }

        return jsonResponse(200, { ok: true, transfer: results });
    }

    // Resolve which Supabase user this event applies to.
    const candidates: Array<unknown> = [
        event.app_user_id,
        event.original_app_user_id,
        ...(event.aliases ?? []),
    ];
    const userId = resolveSupabaseUserId(candidates);

    if (!userId) {
        // Anonymous-only RevenueCat user — nothing to do until they log in.
        // Return 200 so RevenueCat doesn't retry forever.
        console.log(
            `[webhook] event ${event.id ?? "?"} (${event.type}) skipped: no UUID identifier`,
            { app_user_id: event.app_user_id, aliases: event.aliases }
        );
        return jsonResponse(200, { ok: true, skipped: "anonymous_user" });
    }

    const resolution = resolveTierFromEvent(event);
    if (resolution.kind === "skip") {
        console.log(
            `[webhook] event ${event.id ?? "?"} (${event.type}) for ${userId} skipped: ${resolution.reason}`
        );
        return jsonResponse(200, { ok: true, skipped: resolution.reason });
    }

    const admin = getAdminClient();

    // Verify the user actually exists before trying to upsert their quota row.
    // Stale or migrated user_ids would otherwise hit a FK violation.
    const exists = await userExists(admin, userId);
    if (!exists) {
        console.warn(
            `[webhook] event ${event.id ?? "?"} for ${userId} skipped: user not found in auth.users`
        );
        return jsonResponse(200, { ok: true, skipped: "user_not_found" });
    }

    const { data, error } = await admin.rpc("set_user_tier", {
        p_user_id: userId,
        p_tier_type: resolution.tier,
    });

    if (error) {
        console.error(
            `[webhook] set_user_tier failed for ${userId}: ${error.message}`,
            { event_id: event.id, event_type: event.type }
        );
        // 500 → RevenueCat will retry, which is what we want for transient DB errors.
        return jsonResponse(500, { error: "set_user_tier failed", message: error.message });
    }

    console.log(
        `[webhook] event ${event.id ?? "?"} (${event.type}) → ${resolution.tier} for ${userId} :: ${resolution.reason}`
    );

    return jsonResponse(200, {
        ok: true,
        user_id: userId,
        tier: resolution.tier,
        reason: resolution.reason,
        result: data,
    });
});
