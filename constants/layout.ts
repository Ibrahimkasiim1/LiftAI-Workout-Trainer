// constants/layout.ts
//
// Shared layout metrics that aren't part of the theme.

import { Platform } from 'react-native';

/**
 * Extra clearance for the NATIVE tab bar (expo-router NativeTabs).
 *
 * On iOS the Liquid Glass tab bar is a floating pill that hovers over screen
 * content and does NOT contribute to safe-area insets, so pinned bottom
 * elements (chat input, nutrition logger) and scroll content must add this
 * on top of `insets.bottom`. Sized for the icon-only (labels hidden) pill.
 *
 * On Android the native bottom navigation participates in layout, so no
 * extra allowance is needed.
 */
export const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 58 : 0;
