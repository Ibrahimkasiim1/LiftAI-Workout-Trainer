// components/paywall/PaywallHost.tsx
//
// Root-mounted host that lets any non-React code (PaywallService) present the
// native ConversionPaywall imperatively and await the result — the same
// contract the RevenueCat modal used to provide.
//
// Mounted once inside ProGateProvider. `presentConversionPaywall()` resolves
// when the user purchases, restores, or dismisses. If the host isn't mounted
// (e.g. during app teardown) it resolves as cancelled instead of hanging.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ConversionPaywall, { ConversionPaywallResult } from './ConversionPaywall';

export interface PaywallRequest {
    contextKey: string;
    mode: 'soft' | 'hard';
    outcomeHeadline?: string;
}

type Presenter = (req: PaywallRequest) => Promise<ConversionPaywallResult>;

let activePresenter: Presenter | null = null;

export function presentConversionPaywall(req: PaywallRequest): Promise<ConversionPaywallResult> {
    if (!activePresenter) {
        if (__DEV__) {
            console.warn('[PaywallHost] No host mounted — resolving as cancelled');
        }
        return Promise.resolve({ purchased: false, restored: false, cancelled: true });
    }
    return activePresenter(req);
}

export function PaywallHost() {
    const [request, setRequest] = useState<PaywallRequest | null>(null);
    const resolveRef = useRef<((r: ConversionPaywallResult) => void) | null>(null);

    useEffect(() => {
        activePresenter = (req: PaywallRequest) => {
            // A presentation is already in flight — PaywallService's singleton
            // guard should prevent this, but never stack or orphan a promise.
            if (resolveRef.current) {
                return Promise.resolve({ purchased: false, restored: false, cancelled: true });
            }
            return new Promise<ConversionPaywallResult>((resolve) => {
                resolveRef.current = resolve;
                setRequest(req);
            });
        };
        return () => {
            activePresenter = null;
            resolveRef.current?.({ purchased: false, restored: false, cancelled: true });
            resolveRef.current = null;
        };
    }, []);

    const finish = useCallback((result: ConversionPaywallResult) => {
        setRequest(null);
        const resolve = resolveRef.current;
        resolveRef.current = null;
        resolve?.(result);
    }, []);

    return (
        <Modal
            visible={!!request}
            animationType="slide"
            statusBarTranslucent
            onRequestClose={() => finish({ purchased: false, restored: false, cancelled: true })}
        >
            {/* Safe-area insets do not propagate into a RN Modal — without a
                fresh provider here the paywall renders under the notch/home
                indicator (close button unreachable, footer clipped). */}
            <SafeAreaProvider>
                <View style={{ flex: 1, backgroundColor: '#000000' }}>
                    <StatusBar barStyle="light-content" />
                    {request && (
                        <ConversionPaywall
                            contextKey={request.contextKey}
                            mode={request.mode}
                            outcomeHeadline={request.outcomeHeadline}
                            onResult={finish}
                        />
                    )}
                </View>
            </SafeAreaProvider>
        </Modal>
    );
}
