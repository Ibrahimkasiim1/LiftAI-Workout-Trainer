/**
 * Sentry error tracking — env-gated, JS-layer only.
 *
 * Enabled by setting EXPO_PUBLIC_SENTRY_DSN (e.g. in eas.json env or .env);
 * without it this module is a no-op, so local dev needs no config.
 *
 * `enableNative: false` keeps this a pure-JS integration: no config plugin,
 * no native init, and existing dev-client builds keep working without a
 * rebuild. It still captures the debugging surface we're missing in
 * production — unhandled JS errors, promise rejections, and explicit
 * captures (e.g. chat stream failures). Flip to native later (with the
 * Sentry expo plugin + source maps) if crash-level coverage is needed.
 */

import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initSentry(): void {
    if (!dsn) {
        if (__DEV__) console.log('EXPO_PUBLIC_SENTRY_DSN not set — Sentry disabled');
        return;
    }
    Sentry.init({
        dsn,
        enableNative: false,
        environment: __DEV__ ? 'development' : 'production',
        tracesSampleRate: 0,
    });
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
    if (!dsn) return;
    Sentry.captureException(err, context ? { extra: context } : undefined);
}
