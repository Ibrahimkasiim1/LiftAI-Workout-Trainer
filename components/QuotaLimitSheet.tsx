/**
 * QuotaLimitSheet — presents the quota-limit form sheet when the backend
 * returns 429 for a quota-gated AI action.
 *
 * Caller pattern (unchanged):
 *   const [quotaError, setQuotaError] = useState<QuotaExceededError | null>(null);
 *   try { await chat(...); } catch (e) { if (isQuotaExceededError(e)) setQuotaError(e); }
 *   <QuotaLimitSheet error={quotaError} onClose={() => setQuotaError(null)} feature="chat" />
 *
 * The sheet itself is a NATIVE formSheet route (app/quota-limit.tsx) with
 * system detents, grabber, and spring physics — this component is just the
 * bridge that pushes it when an error lands and immediately clears the
 * caller's error state. The sheet manages its own lifecycle from there.
 */

import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import type { GatedFeature } from '../hooks/useProGate';
import type { QuotaExceededError } from '../src/api/backendClient';

interface Props {
    error: QuotaExceededError | null;
    onClose: () => void;
    /** Which feature hit the limit — leads the paywall carousel. */
    feature?: GatedFeature;
}

export default function QuotaLimitSheet({ error, onClose, feature = 'chat' }: Props) {
    const router = useRouter();

    useEffect(() => {
        if (!error) return;
        router.push({
            pathname: '/quota-limit',
            params: {
                feature,
                reason: error.reason ?? 'quota_exceeded',
                ...(error.retry_at ? { retryAt: error.retry_at } : {}),
            },
        });
        // The native sheet owns its lifecycle now; reset the caller's error
        // state so repeat 429s can re-present.
        onClose();
        // `router`/`onClose` are stable enough for this one-shot push; keying
        // on `error` alone prevents duplicate pushes from re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [error]);

    return null;
}
