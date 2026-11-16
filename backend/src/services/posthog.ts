import { PostHog } from 'posthog-node';

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;

if (!token) {
    console.warn('POSTHOG_PROJECT_TOKEN not set — LLM analytics disabled');
}

/**
 * Shared PostHog Node.js client for server-side LLM analytics.
 * Reads POSTHOG_PROJECT_TOKEN and POSTHOG_HOST from environment variables.
 */
export const phClient = new PostHog(token ?? 'placeholder', {
    ...(host ? { host } : {}),
    disabled: !token,
    flushAt: 20,
    flushInterval: 10000,
});

// Flush on clean shutdown
process.on('SIGTERM', () => { phClient.shutdown(); });
process.on('SIGINT', () => { phClient.shutdown(); });
