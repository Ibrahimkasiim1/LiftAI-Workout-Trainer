/**
 * Error tracking (Sentry) — env-gated.
 *
 * With SENTRY_DSN set, unhandled errors and explicit captures flow to Sentry;
 * without it every function here is a no-op, so local dev and tests need no
 * config. Keep all Sentry usage behind this module — routes/services import
 * `captureException`, never @sentry/node directly.
 */

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
let enabled = false;

export function initErrorTracking(): void {
    if (!dsn) {
        console.log("SENTRY_DSN not set — error tracking disabled");
        return;
    }
    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || "development",
        // Errors are the product here; keep perf tracing cheap.
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    });
    enabled = true;
    console.log("Sentry error tracking enabled");
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
    if (!enabled) return;
    Sentry.captureException(err, context ? { extra: context } : undefined);
}
