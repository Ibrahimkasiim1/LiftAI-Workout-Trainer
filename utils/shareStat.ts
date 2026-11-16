// utils/shareStat.ts
/**
 * Captures an off-screen ShareableStatCard to a PNG and opens the native share
 * sheet (from which the user can post to Instagram Stories, Messages, etc.).
 */
import * as Sharing from 'expo-sharing';
import type { RefObject, Component } from 'react';
import { captureRef } from 'react-native-view-shot';

import { CARD_HEIGHT, CARD_WIDTH } from '../components/ShareableStatCard';

const SCALE = 3; // 360×640 → 1080×1920, Instagram Stories' native resolution

export async function shareStatImage(
  ref: RefObject<Component | null>,
): Promise<boolean> {
  try {
    if (!ref.current) return false;
    if (!(await Sharing.isAvailableAsync())) return false;

    const uri = await captureRef(ref, {
      format: 'png',
      quality: 1,
      result: 'tmpfile',
      width: CARD_WIDTH * SCALE,
      height: CARD_HEIGHT * SCALE,
    });

    await Sharing.shareAsync(uri, {
      mimeType: 'image/png',
      dialogTitle: 'Share your progress',
      UTI: 'public.png',
    });
    return true;
  } catch (error) {
    console.warn('shareStatImage failed:', error);
    return false;
  }
}
