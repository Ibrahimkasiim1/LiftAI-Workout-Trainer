// Shared tier-resolution logic.
//
// One source of truth for converting RevenueCat state into our two-tier model.
// Used by both:
//   - revenuecat-webhook       (consumes Webhook event payloads)
//   - sync-subscription-tier   (consumes REST V1 subscriber payloads)

export type TierType = "premium" | "ad_supported";

// The RevenueCat entitlement that grants premium. Mirrors the constant in
// context/SubscriptionContext.tsx.
export const PREMIUM_ENTITLEMENT_ID = "Pro Access";

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Pull a Supabase user UUID out of a RevenueCat identifier soup.
 * The webhook event has both `app_user_id` and `aliases`; the REST V1 response
 * has `subscriber.subscriber_attributes` plus `original_app_user_id`. We look
 * for any UUID-shaped value across all of them.
 *
 * Returns null when only anonymous IDs (`$RCAnonymousID:...`) are available —
 * this means the user hasn't been logged into RevenueCat with their Supabase
 * id yet, and there's nothing actionable to do.
 */
export function resolveSupabaseUserId(candidates: Array<unknown>): string | null {
    for (const c of candidates) {
        if (isUuid(c)) return c.toLowerCase();
    }
    return null;
}

/** Result of resolving a webhook event to a tier action. */
export type TierResolution =
    | { kind: "set"; tier: TierType; reason: string }
    | { kind: "skip"; reason: string };

interface RevenueCatEventLike {
    type?: string;
    entitlement_ids?: string[] | null;
    expiration_at_ms?: number | null;
    event_timestamp_ms?: number | null;
    // TRANSFER-only: the app_user_ids that lost / gained the purchases.
    transferred_from?: string[] | null;
    transferred_to?: string[] | null;
}

/** A single tier write resolved from an event: "set this user to this tier". */
export interface TierAction {
    userId: string;
    tier: TierType;
    reason: string;
}

/**
 * Resolve the per-user tier changes implied by a TRANSFER event.
 *
 * RevenueCat fires TRANSFER when a subscription's ownership moves between app
 * user ids — most commonly when the same store account restores or repurchases
 * while a *different* Supabase user is logged in. The event carries:
 *   - `transferred_to`   → the ids that GAINED the purchases (new owner)
 *   - `transferred_from` → the ids that LOST them (old owner)
 *
 * For our single-entitlement model that maps to:
 *   - transferred_to   → premium (now owns the active subscription)
 *   - transferred_from → ad_supported (no longer owns it)
 *
 * If the transferred subscription is itself expired (per `expiration_at_ms`),
 * the gaining user does *not* become premium. Only UUID-shaped ids are
 * actionable — anonymous `$RCAnonymousID:…` ids map to no Supabase user.
 *
 * IMPORTANT: this only fires when RevenueCat's project Transfer Behavior is
 * "Transfer to new App User ID". Under "Keep with original App User ID" no
 * TRANSFER event is emitted and the new user must rely on the launch-time
 * `sync-subscription-tier` path instead.
 */
export function resolveTransferActions(event: RevenueCatEventLike): TierAction[] {
    const now = event.event_timestamp_ms ?? Date.now();
    const expiresAt = event.expiration_at_ms ?? null;
    const transferActive = expiresAt === null || expiresAt > now;

    const actions: TierAction[] = [];

    for (const id of event.transferred_to ?? []) {
        if (isUuid(id)) {
            actions.push({
                userId: id.toLowerCase(),
                tier: transferActive ? "premium" : "ad_supported",
                reason: transferActive
                    ? "transfer: received active entitlement"
                    : "transfer: received expired entitlement",
            });
        }
    }

    for (const id of event.transferred_from ?? []) {
        if (isUuid(id)) {
            actions.push({
                userId: id.toLowerCase(),
                tier: "ad_supported",
                reason: "transfer: lost entitlement",
            });
        }
    }

    return actions;
}

/**
 * Decide what tier the webhook event implies.
 *
 * Strategy:
 *   1. If expiration_at_ms is set and in the past → ad_supported.
 *   2. Else if Pro Access entitlement is in entitlement_ids → premium.
 *   3. Else fall back to event-type defaults.
 *
 * This handles edge cases like CANCELLATION (still active until expiry) and
 * BILLING_ISSUE (grace period) without needing a full event-type table.
 */
export function resolveTierFromEvent(event: RevenueCatEventLike): TierResolution {
    const type = event.type ?? "UNKNOWN";

    // RevenueCat sends a TEST event when you click "Send test" in the dashboard.
    if (type === "TEST") {
        return { kind: "skip", reason: "test event" };
    }

    // TRANSFER is handled separately (two users at once); see
    // resolveTransferActions and the webhook's dedicated branch. Keep this as a
    // safety net for any caller that routes TRANSFER through here.
    if (type === "TRANSFER") {
        return { kind: "skip", reason: "transfer event — handled separately" };
    }

    const now = event.event_timestamp_ms ?? Date.now();
    const expiresAt = event.expiration_at_ms ?? null;
    const entitlementIds = event.entitlement_ids ?? [];

    // Hard signal: explicit expiration in the past.
    if (expiresAt !== null && expiresAt < now) {
        return { kind: "set", tier: "ad_supported", reason: `expired at ${expiresAt}` };
    }

    // Hard signal: entitlement currently granted.
    if (entitlementIds.includes(PREMIUM_ENTITLEMENT_ID)) {
        return { kind: "set", tier: "premium", reason: `entitlement active (${type})` };
    }

    // Fallback by event type.
    switch (type) {
        case "INITIAL_PURCHASE":
        case "RENEWAL":
        case "UNCANCELLATION":
        case "PRODUCT_CHANGE":
        case "NON_RENEWING_PURCHASE":
            return { kind: "set", tier: "premium", reason: `${type} without entitlement_ids — assuming premium` };

        case "EXPIRATION":
        case "SUBSCRIPTION_PAUSED":
            return { kind: "set", tier: "ad_supported", reason: type };

        case "CANCELLATION":
            // User cancelled but retains access until EXPIRATION fires later.
            return { kind: "skip", reason: "cancellation — wait for expiration" };

        case "BILLING_ISSUE":
            // Grace period — RevenueCat keeps the entitlement active. No-op.
            return { kind: "skip", reason: "billing issue (grace period)" };

        default:
            return { kind: "skip", reason: `unhandled event type: ${type}` };
    }
}

interface RevenueCatSubscriberLike {
    entitlements?: Record<
        string,
        { expires_date: string | null; product_identifier?: string }
    >;
}

/**
 * Determine tier from a REST V1 `/subscribers/{id}` response.
 * Used by the sync function for the on-launch fallback path.
 */
export function resolveTierFromSubscriber(
    subscriber: RevenueCatSubscriberLike | null | undefined
): TierType {
    if (!subscriber || !subscriber.entitlements) return "ad_supported";

    const ent = subscriber.entitlements[PREMIUM_ENTITLEMENT_ID];
    if (!ent) return "ad_supported";

    // expires_date null = lifetime; future date = active.
    if (ent.expires_date === null) return "premium";
    const expiresAt = Date.parse(ent.expires_date);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return "premium";

    return "ad_supported";
}

/**
 * A single item from the V2 `GET /customers/{id}/active_entitlements` list.
 * The base shape carries only the internal `entitlement_id` (e.g. "entl…"),
 * not the human lookup_key. We request `expand=items.entitlement` so each item
 * also nests the entitlement object, whose `lookup_key` is what the app keys on
 * ("Pro Access").
 */
export interface V2ActiveEntitlementItem {
    object?: string;
    entitlement_id?: string;
    expires_at?: number | null;
    entitlement?: { id?: string; lookup_key?: string } | null;
}

/**
 * Determine tier from a RevenueCat API **v2**
 * `GET /v2/projects/{project_id}/customers/{id}/active_entitlements` response.
 *
 * The endpoint only ever returns *currently active* entitlements (RevenueCat
 * computes active state server-side, accounting for expiry and grace periods),
 * so we don't re-check `expires_at` — presence is sufficient.
 *
 * When the entitlement objects are expanded we match `lookup_key` precisely.
 * If expansion is unavailable, any active entitlement implies premium — correct
 * for this single-entitlement app.
 */
export function resolveTierFromV2ActiveEntitlements(
    items: V2ActiveEntitlementItem[] | null | undefined
): TierType {
    if (!items || items.length === 0) return "ad_supported";

    const anyExpanded = items.some(
        (it) => typeof it.entitlement?.lookup_key === "string"
    );
    if (anyExpanded) {
        return items.some(
            (it) => it.entitlement?.lookup_key === PREMIUM_ENTITLEMENT_ID
        )
            ? "premium"
            : "ad_supported";
    }

    // No lookup_key available (expand not honored) — single-entitlement app,
    // so an active entitlement is the premium one.
    return "premium";
}
