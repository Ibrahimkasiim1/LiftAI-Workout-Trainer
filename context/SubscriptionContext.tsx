// /context/SubscriptionContext.tsx

/**
 * Subscription Context
 * 
 * Provides global subscription state management using RevenueCat.
 * 
 * Features:
 * - Initialize RevenueCat SDK on app start
 * - Track subscription status (isSubscribed)
 * - Cache subscription status for fast access
 * - Listen for subscription updates automatically
 * - Provide methods for checking and restoring purchases
 * - Handle the "pro" entitlement for LiftAI Pro
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RealtimeChannel } from '@supabase/supabase-js';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import Purchases, { CustomerInfo, LOG_LEVEL, PurchasesOffering } from 'react-native-purchases';
import { appEnv } from '../config/env';
import type { TierType } from '../hooks/useUserQuota';
import { setLiveActivityEntitlement } from '../utils/liveActivity';
import { supabase } from '../utils/supabase';

const SUBSCRIPTION_LAST_KNOWN_KEY = '@liftai_was_subscribed';

// Entitlement identifier configured in RevenueCat dashboard
const ENTITLEMENT_ID = 'Pro Access';

// Context type definition
interface SubscriptionContextType {
  // Subscription state
  isSubscribed: boolean;
  /** The server-verified tier from `user_quotas.tier_type`, kept live via a
   * realtime subscription. This is the materialized source of truth that the
   * backend also reads. Null until loaded or when signed out. */
  tier: TierType | null;
  /**
   * The single derived "is this user Pro?" signal for all client gating and UI.
   *
   * `tier === 'premium'` is the canonical (server-verified) answer; `isSubscribed`
   * (the live RevenueCat SDK entitlement) is OR-ed in only as an *optimistic*
   * signal so a fresh purchase unlocks instantly during the ~1s it takes the
   * sync/webhook to write the new tier to the DB. Because the tier self-heals
   * (webhook + sync-subscription-tier), this can no longer get stuck high.
   */
  isPro: boolean;
  isLoading: boolean;
  customerInfo: CustomerInfo | null;
  currentOffering: PurchasesOffering | null;

  // Methods
  checkSubscription: (forceRefresh?: boolean) => Promise<boolean>;
  restorePurchases: () => Promise<{ success: boolean; isSubscribed: boolean; error?: string }>;
  refreshOfferings: () => Promise<void>;

  // SDK initialization state
  isInitialized: boolean;
  /** True only after a successful Purchases.configure() — native SDK calls are safe */
  revenueCatUsable: boolean;
}

// Create context with default values
const SubscriptionContext = createContext<SubscriptionContextType>({
  isSubscribed: false,
  tier: null,
  isPro: false,
  isLoading: true,
  customerInfo: null,
  currentOffering: null,
  checkSubscription: async () => false,
  restorePurchases: async () => ({ success: false, isSubscribed: false }),
  refreshOfferings: async () => { },
  isInitialized: false,
  revenueCatUsable: false,
});

// Custom hook to use subscription context
export const useSubscription = () => {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error('useSubscription must be used within a SubscriptionProvider');
  }
  return context;
};

// Provider component props
interface SubscriptionProviderProps {
  children: ReactNode;
}

/**
 * SubscriptionProvider
 * 
 * Wraps the app and provides subscription state to all components.
 * Initializes RevenueCat SDK and listens for subscription changes.
 */
export const SubscriptionProvider: React.FC<SubscriptionProviderProps> = ({ children }) => {
  // State
  const [isSubscribed, setIsSubscribed] = useState(false);
  /** Server-verified tier mirrored from `user_quotas.tier_type` (realtime). */
  const [dbTier, setDbTier] = useState<TierType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [currentOffering, setCurrentOffering] = useState<PurchasesOffering | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [revenueCatUsable, setRevenueCatUsable] = useState(false);
  /** Tracks whether we've ever observed an active subscription this session, so we can detect
   * the active → expired transition and notify the user exactly once. */
  const lastKnownSubscribedRef = useRef<boolean | null>(null);
  const expirationAlertShownRef = useRef(false);
  /** The last `subscribed` value we reconciled to the backend, so we only invoke the
   * sync edge function on the first observation and on each subsequent transition —
   * not on every CustomerInfo refresh. */
  const lastSyncedSubscribedRef = useRef<boolean | null>(null);

  /**
   * Reconcile `user_quotas.tier_type` with RevenueCat's live entitlement state.
   *
   * The RevenueCat → Supabase webhook is the primary path, but it can be missed
   * (dropped delivery) or simply never fire (StoreKit local/sandbox testing).
   * Without reconciliation the DB tier stays stale: a user whose Pro plan has
   * expired still reads as `premium` in the DB, so Settings shows the Pro card
   * (with no upgrade path) and the backend grants the premium daily budget.
   *
   * This calls the `sync-subscription-tier` edge function, which fetches the
   * authoritative subscriber state from RevenueCat's REST API (resolved from the
   * caller's JWT, server-side) and writes the correct tier. Fire-and-forget;
   * only invoked when the entitlement actually changes (see callers).
   */
  const syncTierToBackend = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) return; // signed out — nothing to reconcile
      const { error } = await supabase.functions.invoke('sync-subscription-tier', {
        body: {},
      });
      if (error && __DEV__) {
        // For non-2xx the body carries our diagnostic ({ error, status }) where
        // `status` is RevenueCat's upstream status (401/403 → bad/wrong API key).
        let detail = error.message;
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx && typeof ctx.json === 'function') {
            detail = JSON.stringify(await ctx.json());
          }
        } catch { /* ignore */ }
        console.warn('[Subscription] tier reconciliation failed:', detail);
      }
    } catch (err) {
      if (__DEV__) console.warn('[Subscription] tier reconciliation error:', err);
    }
  }, []);

  /** One-shot read of the caller's server-verified tier. */
  const fetchDbTier = useCallback(async (userId: string): Promise<void> => {
    try {
      const { data, error } = await (supabase as any)
        .from('user_quotas')
        .select('tier_type')
        .eq('user_id', userId)
        .maybeSingle();
      if (!error) setDbTier((data?.tier_type as TierType | undefined) ?? null);
    } catch (err) {
      if (__DEV__) console.warn('[Subscription] tier fetch failed:', err);
    }
  }, []);

  /**
   * Check if user has active "pro" entitlement
   */
  const hasProEntitlement = useCallback((info: CustomerInfo | null): boolean => {
    if (!info) return false;

    // Debug: log what entitlements RevenueCat actually returns
    if (__DEV__) {
      const activeIds = Object.keys(info.entitlements.active);
      console.log(`[Entitlements] Looking for: "${ENTITLEMENT_ID}"`);
      console.log(`[Entitlements] Active entitlements: [${activeIds.join(', ')}]`);
      if (activeIds.length > 0) {
        activeIds.forEach(id => {
          const ent = info.entitlements.active[id];
          console.log(`[Entitlements] "${id}" => isActive: ${ent.isActive}, productId: ${ent.productIdentifier}`);
        });
      }
    }

    const entitlement = info.entitlements.active[ENTITLEMENT_ID];
    return entitlement !== undefined && entitlement.isActive;
  }, []);

  /**
   * Update subscription state from CustomerInfo.
   *
   * Also detects the "subscription just expired" transition by comparing against the
   * last persisted state in AsyncStorage. When a previously-subscribed user is no
   * longer entitled, we surface a one-time alert so they know they've been moved
   * to the free plan.
   */
  const updateSubscriptionState = useCallback((info: CustomerInfo | null) => {
    setCustomerInfo(info);
    const subscribed = hasProEntitlement(info);
    setIsSubscribed(subscribed);

    // Reconcile the backend tier whenever the entitlement is first observed or
    // changes value (e.g. active → expired). Guarded against firing on every
    // CustomerInfo refresh so we don't hammer the edge function.
    if (lastSyncedSubscribedRef.current !== subscribed) {
      lastSyncedSubscribedRef.current = subscribed;
      void syncTierToBackend();
    }

    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(SUBSCRIPTION_LAST_KNOWN_KEY);
        const wasSubscribed = stored === 'true';

        if (subscribed) {
          if (!wasSubscribed) {
            await AsyncStorage.setItem(SUBSCRIPTION_LAST_KNOWN_KEY, 'true');
          }
          lastKnownSubscribedRef.current = true;
          expirationAlertShownRef.current = false;
        } else if (wasSubscribed && !expirationAlertShownRef.current) {
          // active → expired transition: notify once and persist the new state
          expirationAlertShownRef.current = true;
          await AsyncStorage.setItem(SUBSCRIPTION_LAST_KNOWN_KEY, 'false');
          lastKnownSubscribedRef.current = false;
          Alert.alert(
            'Subscription ended',
            'Your Pro plan has ended and you\'ve been moved to the free plan. You can resubscribe anytime from Settings.',
            [{ text: 'OK' }]
          );
        } else {
          lastKnownSubscribedRef.current = false;
        }
      } catch (err) {
        if (__DEV__) console.warn('Subscription transition tracking failed:', err);
      }
    })();

    return subscribed;
  }, [hasProEntitlement, syncTierToBackend]);

  /**
   * Initialize RevenueCat SDK
   */
  const initializeRevenueCat = useCallback(async () => {
    // Watchdog: nothing in here has a native timeout — a hung configure/
    // getCustomerInfo/offerings call (dead network, StoreKit hiccup) would
    // otherwise leave isLoading=true forever, and every subscriptionReady
    // consumer hangs with it: the cold-start splash never routes, plan-review
    // never enables its CTA. After 10s, proceed initialized-but-degraded —
    // a late SDK success simply overwrites the degraded state.
    const watchdog = setTimeout(() => {
      console.warn('RevenueCat init watchdog fired — continuing in degraded mode');
      setIsInitialized(true);
      setIsLoading(false);
    }, 10_000);
    try {
      // Read API key directly from environment variable
      const apiKey = appEnv.revenueCatApiKey;

      if (__DEV__) {
        console.log('API Key from env:', apiKey ? `${apiKey.substring(0, 10)}...` : 'undefined');
      }

      if (!apiKey || apiKey === '') {
        console.error('RevenueCat API key not configured');
        console.error('Add EXPO_PUBLIC_REVENUECAT_API_KEY to your .env file and restart with: npx expo start -c');
        // Still set initialized to true so app doesn't hang
        setIsInitialized(true);
        setRevenueCatUsable(false);
        setIsLoading(false);
        updateSubscriptionState(null);
        return;
      }

      if (__DEV__) {
        Purchases.setLogLevel(LOG_LEVEL.DEBUG);
      }

      await Purchases.configure({
        apiKey: apiKey,
        appUserID: null,
      });

      setRevenueCatUsable(true);
      setIsInitialized(true);

      const info = await Purchases.getCustomerInfo();
      updateSubscriptionState(info);

      await refreshOfferingsInternal();

    } catch (error: any) {
      console.error('Error initializing RevenueCat:', error);
      setRevenueCatUsable(false);
      setIsInitialized(true);
      updateSubscriptionState(null);
    } finally {
      clearTimeout(watchdog);
      setIsLoading(false);
    }
  }, [updateSubscriptionState]);

  /**
   * Internal method to refresh offerings
   */
  const refreshOfferingsInternal = async () => {
    try {
      const offerings = await Purchases.getOfferings();

      if (offerings.current) {
        setCurrentOffering(offerings.current);
      } else {
        const firstOffering = Object.values(offerings.all)[0];
        if (firstOffering) {
          setCurrentOffering(firstOffering);
        }
      }
    } catch (error: any) {
      console.error('Error fetching offerings:', error);
    }
  };

  /**
   * Public method to refresh offerings
   */
  const refreshOfferings = useCallback(async () => {
    if (!revenueCatUsable) return;
    await refreshOfferingsInternal();
  }, [revenueCatUsable]);

  /**
   * Check current subscription status
   */
  const checkSubscription = useCallback(async (_forceRefresh: boolean = false): Promise<boolean> => {
    try {
      if (!isInitialized) return false;

      if (!revenueCatUsable) {
        return isSubscribed;
      }

      // Silent status check only - never restore automatically.
      // Restore should only happen from an explicit user action.
      const info = await Purchases.getCustomerInfo();
      return updateSubscriptionState(info);
    } catch (error) {
      console.error('Error checking subscription:', error);
      return false;
    }
  }, [isInitialized, revenueCatUsable, isSubscribed, updateSubscriptionState]);

  /**
   * Restore previous purchases
   * Returns success status and whether user is now subscribed
   */
  const restorePurchases = useCallback(async (): Promise<{
    success: boolean;
    isSubscribed: boolean;
    error?: string
  }> => {
    try {
      if (!isInitialized || !revenueCatUsable) {
        return {
          success: false,
          isSubscribed: false,
          error: !revenueCatUsable
            ? 'Subscriptions are not available right now. Check your connection or try again later.'
            : 'RevenueCat not initialized'
        };
      }

      const info = await Purchases.restorePurchases();
      const subscribed = updateSubscriptionState(info);

      return {
        success: true,
        isSubscribed: subscribed
      };
    } catch (error: any) {
      console.error('Error restoring purchases:', error);

      let errorMessage = 'Failed to restore purchases. Please try again.';
      if (error.code === 'PURCHASE_CANCELLED') {
        errorMessage = 'Restore cancelled.';
      } else if (error.code === 'NETWORK_ERROR') {
        errorMessage = 'Network error. Please check your connection.';
      }

      return {
        success: false,
        isSubscribed: false,
        error: errorMessage
      };
    }
  }, [isInitialized, revenueCatUsable, updateSubscriptionState]);

  /**
   * Initialize SDK on mount
   */
  useEffect(() => {
    initializeRevenueCat();
  }, [initializeRevenueCat]);

  /**
   * Mirror entitlement state into the Live Activity (Dynamic Island) module.
   * The widget is Pro-only — free users still get the in-app rest timer but
   * not the lock-screen / Dynamic Island presentation. Sync happens at the
   * boundary so individual callers don't need to know about gating.
   */
  useEffect(() => {
    setLiveActivityEntitlement(isSubscribed);
  }, [isSubscribed]);

  /**
   * Listen for subscription updates
   */
  useEffect(() => {
    if (!isInitialized || !revenueCatUsable) return;

    const customerInfoListener = (info: CustomerInfo) => {
      updateSubscriptionState(info);
    };

    Purchases.addCustomerInfoUpdateListener(customerInfoListener);

    return () => {
      Purchases.removeCustomerInfoUpdateListener(customerInfoListener);
    };
  }, [isInitialized, revenueCatUsable, updateSubscriptionState]);

  /**
   * Mirror Supabase auth identity into RevenueCat. Without this, RevenueCat
   * tracks an anonymous `$RCAnonymousID:…` user, so webhook events arrive
   * without our Supabase user_id and we can't sync `user_quotas.tier_type`.
   * On sign-in: alias the anonymous customer to the Supabase UUID.
   * On sign-out: reset to a fresh anonymous customer to avoid leaking
   * subscription state across users on the same device.
   */
  useEffect(() => {
    if (!isInitialized || !revenueCatUsable) return;

    let active = true;
    const sync = async (userId: string | undefined) => {
      try {
        if (userId) {
          await Purchases.logIn(userId);
          // Now that RevenueCat is identified with the Supabase UUID, reconcile
          // the DB tier — the resolved entitlement may differ from the anonymous
          // session's, and on a fresh launch the DB row may be stale.
          lastSyncedSubscribedRef.current = null;
          void syncTierToBackend();
        } else {
          const currentAppUserId = await Purchases.getAppUserID();
          if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
            await Purchases.logOut();
          }
        }
      } catch (err) {
        console.error('Error syncing RevenueCat identity:', err);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active) void sync(session?.user?.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) void sync(session?.user?.id);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [isInitialized, revenueCatUsable, syncTierToBackend]);

  /**
   * Keep `dbTier` (the server-verified source of truth) live.
   *
   * On sign-in we read the current tier once, then subscribe to realtime changes
   * on the user's `user_quotas` row. This means a tier flip — whether written by
   * the RevenueCat webhook or by sync-subscription-tier — propagates to client
   * gating within a second, with no polling. On sign-out we clear it.
   */
  useEffect(() => {
    let active = true;
    let channel: RealtimeChannel | null = null;

    const teardownChannel = () => {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    };

    const setup = (userId: string | undefined) => {
      teardownChannel();
      if (!userId) {
        setDbTier(null);
        return;
      }
      void fetchDbTier(userId);
      channel = supabase
        .channel(`user_quotas:${userId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'user_quotas',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const next = (payload.new as { tier_type?: TierType } | null)?.tier_type;
            if (next) setDbTier(next);
          }
        )
        .subscribe();
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active) setup(session?.user?.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setup(session?.user?.id);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
      teardownChannel();
    };
  }, [fetchDbTier]);

  // The single derived Pro signal — canonical DB tier, with the live SDK
  // entitlement OR-ed in as an optimistic post-purchase unlock. See type docs.
  const isPro = isSubscribed || dbTier === 'premium';

  // Context value
  const value: SubscriptionContextType = {
    isSubscribed,
    tier: dbTier,
    isPro,
    isLoading,
    customerInfo,
    currentOffering,
    checkSubscription,
    restorePurchases,
    refreshOfferings,
    isInitialized,
    revenueCatUsable,
  };

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
};

export default SubscriptionContext;
