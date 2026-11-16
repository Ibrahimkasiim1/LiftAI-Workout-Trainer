// modules/lift-depth-camera/index.ts
/**
 * JS API for the LiftDepthCamera native module (iOS, LiDAR devices only).
 *
 * On LiDAR iPhones (12 Pro and later Pro models), `captureMealWithDepth()`
 * presents a native camera and returns the photo plus real-world scale
 * metadata measured by the LiDAR scanner. Everywhere else —  Android,
 * non-Pro iPhones, Expo Go, or builds that predate the module —
 * `isLiDARAvailable()` returns false and callers use the regular
 * expo-camera flow. Import safely from anywhere; nothing here throws when
 * the native side is missing.
 */
import { Platform } from 'react-native';

export interface MealDepthMeta {
  lidar: boolean;
  /** Median LiDAR distance from camera to the food, in cm. */
  subjectDistanceCm: number;
  /** Real-world width the full image spans at the food's distance, in cm. */
  fieldWidthCm: number | null;
  /** Coarse row-major depth grid in meters (-1 = no reading). */
  grid?: number[];
  gridCols?: number;
  gridRows?: number;
}

export interface DepthCaptureResult {
  uri: string;
  width: number;
  height: number;
  depth: MealDepthMeta | null;
}

interface NativeModuleShape {
  isLiDARAvailable(): boolean;
  captureMeal(): Promise<DepthCaptureResult | null>;
}

let nativeModule: NativeModuleShape | null = null;
if (Platform.OS === 'ios') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeModule } = require('expo-modules-core');
    nativeModule = requireNativeModule('LiftDepthCamera');
  } catch {
    nativeModule = null; // Expo Go / stale build — camera-only fallback.
  }
}

/** True only on iOS devices with a rear LiDAR scanner and a build containing the module. */
export function isLiDARAvailable(): boolean {
  try {
    return nativeModule?.isLiDARAvailable() ?? false;
  } catch {
    return false;
  }
}

/**
 * Present the native LiDAR capture UI. Resolves null when the user cancels
 * (or the module is unavailable); rejects on a hard capture failure.
 */
export async function captureMealWithDepth(): Promise<DepthCaptureResult | null> {
  if (!nativeModule) return null;
  return nativeModule.captureMeal();
}
