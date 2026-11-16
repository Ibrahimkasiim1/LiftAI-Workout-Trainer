// hooks/useProGate.ts
//
// Single entry point for Pro feature gating across the app.
//
// Usage:
//   const gate = useProGate();
//   onPress={() => gate.gate('exercise_swap', () => openSwapModal())}
//
// If the user has the "Pro Access" entitlement, `onAllowed` runs immediately.
// Otherwise the native ConversionPaywall opens directly, with the carousel
// slide for this feature shown first — one tap from locked control to
// purchase button. No page-level gates: this hook is invoked from individual
// button handlers so the rest of the screen stays usable for free users.

import { useCallback } from 'react';
import { useSubscription } from '../context/SubscriptionContext';
import { useProGateContext } from '../context/ProGateContext';
import { PAYWALL_COPY, type GatedFeature, type PaywallCopy } from './proGateCopy';

export { PAYWALL_COPY, type GatedFeature, type PaywallCopy };

export interface ProGate {
  /** The single unified "has Pro access" signal (see SubscriptionContext.isPro). */
  isPro: boolean;
  /** Run `onAllowed` if Pro; otherwise present the in-app upgrade sheet. */
  gate: (feature: GatedFeature, onAllowed: () => void | Promise<void>) => void;
  /** Open the upgrade sheet directly (e.g. from a "Pro" badge tap). */
  showPaywall: (feature: GatedFeature) => void;
}

export function useProGate(): ProGate {
  const { isPro } = useSubscription();
  const { requestUpgrade } = useProGateContext();

  const showPaywall = useCallback(
    (feature: GatedFeature) => {
      requestUpgrade(feature);
    },
    [requestUpgrade]
  );

  const gate = useCallback(
    (feature: GatedFeature, onAllowed: () => void | Promise<void>) => {
      if (isPro) {
        void onAllowed();
        return;
      }
      requestUpgrade(feature);
    },
    [isPro, requestUpgrade]
  );

  return { isPro, gate, showPaywall };
}
