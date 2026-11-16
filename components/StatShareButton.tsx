// components/StatShareButton.tsx
/**
 * A pill button that shares a celebratory stat (streak milestone / PR) as an
 * Instagram-Stories-ready image. It keeps the ShareableStatCard mounted but
 * off-screen so react-native-view-shot can snapshot it on demand.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

import { ShareableStatCard, ShareStat } from './ShareableStatCard';
import { shareStatImage } from '../utils/shareStat';

type Props = {
  stat: ShareStat;
  label?: string;
  /** Accent color for the pill (defaults to brand blue). */
  tint?: string;
  textColor?: string;
  style?: ViewStyle;
};

export default function StatShareButton({
  stat,
  label = 'Share',
  tint = '#2E90FA',
  textColor = '#FFFFFF',
  style,
}: Props) {
  const cardRef = useRef<View>(null);
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await shareStatImage(cardRef);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        onPress={onPress}
        disabled={busy}
        style={[styles.button, { borderColor: tint }, style]}
        accessibilityRole="button"
        accessibilityLabel={`Share ${stat.label.toLowerCase()}`}
      >
        {busy ? (
          <ActivityIndicator size="small" color={tint} />
        ) : (
          <>
            <Ionicons name="share-social" size={15} color={tint} />
            <Text style={[styles.label, { color: textColor }]}>{label}</Text>
          </>
        )}
      </Pressable>

      {/* Off-screen render target for the snapshot. */}
      <View style={styles.offscreen} pointerEvents="none" collapsable={false}>
        <ShareableStatCard ref={cardRef} stat={stat} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: 'rgba(46,144,250,0.10)',
  },
  label: {
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
  },
  // Rendered fully opaque but parked off-screen — view-shot snapshots blank
  // pixels if the capture target sits under a transparent/zero-opacity parent.
  offscreen: {
    position: 'absolute',
    left: -10000,
    top: -10000,
  },
});
