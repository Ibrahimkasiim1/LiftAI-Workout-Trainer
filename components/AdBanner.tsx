import { usePathname } from 'expo-router';
import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { useSubscription } from '../context/SubscriptionContext';
import { isAdFreeRoute } from '../utils/adRoutes';
import { BANNER_AD_UNIT_ID } from '../utils/adUnits';

type Props = {
  style?: ViewStyle;
  size?: BannerAdSize;
};

export default function AdBanner({ style, size = BannerAdSize.ANCHORED_ADAPTIVE_BANNER }: Props) {
  const { isPro } = useSubscription();
  const pathname = usePathname();

  if (isPro) return null;
  if (isAdFreeRoute(pathname)) return null;
  // No real unit ID configured for this platform (e.g. Android env var unset in
  // a production build) — render nothing rather than a test ad.
  if (!BANNER_AD_UNIT_ID) return null;

  return (
    <View style={[styles.container, style]}>
      <BannerAd
        unitId={BANNER_AD_UNIT_ID}
        size={size}
        requestOptions={{ requestNonPersonalizedAdsOnly: false }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
});
