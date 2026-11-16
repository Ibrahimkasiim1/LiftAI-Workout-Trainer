import { useMemo } from 'react';
import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';

/**
 * Custom hook to get memoized theme colors
 * 
 * This hook consolidates the repeated pattern of:
 * ```
 * const { isDark } = useTheme();
 * const colors = getThemeColors(isDark);
 * ```
 * 
 * into a single, memoized call:
 * ```
 * const colors = useColors();
 * ```
 * 
 * The colors are memoized to prevent unnecessary recalculations
 * when components re-render for unrelated reasons.
 */
export function useColors() {
    const { isDark } = useTheme();
    return useMemo(() => getThemeColors(isDark), [isDark]);
}
