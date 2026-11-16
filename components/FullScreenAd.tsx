import { useEffect, useRef, useState } from 'react';
import { AdEventType, InterstitialAd } from 'react-native-google-mobile-ads';
import { useSubscription } from '../context/SubscriptionContext';
import { isPaywallVisible } from '../services/PaywallService';
import { useAdGovernor } from '../stores/useAdGovernor';
import { INTERSTITIAL_AD_UNIT_ID as AD_UNIT_ID } from '../utils/adUnits';
import { maybeShowRemoveAdsNudge } from '../utils/removeAdsNudge';

export default function useInterstitialAd() {
  const { isPro, checkSubscription } = useSubscription();
  const adRef = useRef<InterstitialAd | null>(null);
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (isPro) return;
    // No real unit ID configured for this platform — don't request test ads.
    if (!AD_UNIT_ID) return;
    const ad = InterstitialAd.createForAdRequest(AD_UNIT_ID);
    adRef.current = ad;

    const unsubLoaded = ad.addAdEventListener(AdEventType.LOADED, () => {
      loadedRef.current = true;
      setLoaded(true);
    });
    const unsubClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      loadedRef.current = false;
      setLoaded(false);
      ad.load();
      // The moment they dismissed an ad is when "remove ads" lands honestly.
      void maybeShowRemoveAdsNudge(() => checkSubscription(true));
    });
    const unsubError = ad.addAdEventListener(AdEventType.ERROR, () => {
      loadedRef.current = false;
      setLoaded(false);
      setTimeout(() => ad.load(), 30_000);
    });

    ad.load();

    return () => {
      unsubLoaded();
      unsubClosed();
      unsubError();
    };
  }, [isPro]);

  const showAd = () => {
    if (isPro) return;
    // Never fire over the paywall — it's a modal, so route checks can't catch it.
    if (isPaywallVisible()) return;
    if (!loadedRef.current || !adRef.current) return;
    if (!useAdGovernor.getState().canShowInterstitial()) return;
    const ad = adRef.current;
    loadedRef.current = false;
    setLoaded(false);
    useAdGovernor.getState().recordInterstitialShown();
    try {
      ad.show();
    } catch {
      ad.load();
    }
  };

  return { showAd, loaded };
}
