// context/ProGateContext.tsx
//
// Pro feature gating entry point. When a free user taps a Pro-gated control,
// we present the native ConversionPaywall DIRECTLY with that feature's slide
// leading the carousel — one tap from locked feature to purchase button.
//
// (Previously this showed an intermediate "upgrade" bottom sheet that then
// opened the generic RevenueCat paywall — a two-step flow that lost intent
// between taps. The contextual story now lives inside the paywall itself.)
//
// Also mounts the PaywallHost so PaywallService can present the paywall from
// anywhere (settings, quota sheets, plan-expired), and keeps the
// BottomSheetModalProvider that downstream sheets rely on.

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import React, { ReactNode, createContext, useCallback, useContext, useMemo } from 'react';

import { PaywallHost } from '../components/paywall/PaywallHost';
import type { GatedFeature } from '../hooks/proGateCopy';
import { presentPaywall } from '../services/PaywallService';
import { useSubscription } from './SubscriptionContext';

interface ProGateContextValue {
  /** Present the conversion paywall, leading with `feature`'s slide. */
  requestUpgrade: (feature: GatedFeature) => void;
}

const ProGateContext = createContext<ProGateContextValue | null>(null);

export function useProGateContext(): ProGateContextValue {
  const ctx = useContext(ProGateContext);
  if (!ctx) throw new Error('useProGateContext must be inside ProGateProvider');
  return ctx;
}

interface Props {
  children: ReactNode;
}

export function ProGateProvider({ children }: Props) {
  const { checkSubscription } = useSubscription();

  const requestUpgrade = useCallback(
    (feature: GatedFeature) => {
      void presentPaywall('soft', feature, async () => checkSubscription(true));
    },
    [checkSubscription]
  );

  const value = useMemo(() => ({ requestUpgrade }), [requestUpgrade]);

  return (
    <ProGateContext.Provider value={value}>
      <BottomSheetModalProvider>
        {children}
        <PaywallHost />
      </BottomSheetModalProvider>
    </ProGateContext.Provider>
  );
}
