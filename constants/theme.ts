/**
 * Brand Kit Theme Configuration
 * 
 * Centralized theme file for LiftAI app with Montserrat font and purple accent color.
 * This ensures consistent styling across all screens and components.
 * Supports both light and dark modes.
 */

// Dark mode color palette
export const darkColors = {
  // Primary colors
  primary: '#2E90FA',           // Electric blue accent color
  primaryLight: '#5AA6FF',      // Lighter blue for hover states
  primaryDark: '#1A6FE0',        // Darker blue for pressed states
  
  // Background colors — "stage" aesthetic: true black with translucent
  // white-alpha surfaces so cards derive from the background instead of
  // sitting next to it (matches the ConversionPaywall look).
  background: '#000000',        // True black (OLED stage)
  backgroundLight: '#FFFFFF',   // White background (for light mode)
  backgroundSecondary: 'rgba(255,255,255,0.05)', // Cards/containers
  backgroundTertiary: 'rgba(255,255,255,0.08)',  // Elevated surfaces

  // Text colors
  text: '#FFFFFF',              // Primary text (white)
  textSecondary: '#CCCCCC',     // Secondary text (light gray)
  textTertiary: '#999999',      // Tertiary text (medium gray)
  textMuted: '#666666',         // Muted text (dark gray)
  textInverse: '#121212',       // Text on light backgrounds

  // Border colors — hairline translucent white, not solid gray
  border: 'rgba(255,255,255,0.10)',     // Primary border color
  borderLight: 'rgba(255,255,255,0.14)', // Light border
  borderDark: 'rgba(255,255,255,0.06)',  // Dark border
  
  // Status colors — monochrome + brand-blue system. Blue marks success/info,
  // gray marks warnings; red is reserved for errors/destructive actions only.
  success: '#2E90FA',
  warning: '#999999',
  error: '#EF4444',
  info: '#2E90FA',

  // Legacy colors (for gradual migration)
  legacy: {
    red: '#FF0050',             // Original red color (to be replaced)
    black: '#000000',           // Original black (to be replaced)
  }
};

// Light mode color palette
export const lightColors = {
  // Primary colors
  primary: '#2E90FA',           // Electric blue accent color (same as dark)
  primaryLight: '#5AA6FF',     // Lighter blue for hover states
  primaryDark: '#1A6FE0',      // Darker blue for pressed states
  
  // Background colors — light-mode mirror of the stage aesthetic:
  // white base with translucent black-alpha surfaces and hairline borders.
  background: '#FFFFFF',        // White background
  backgroundLight: '#FFFFFF',  // White background
  backgroundSecondary: 'rgba(0,0,0,0.03)', // Cards/containers
  backgroundTertiary: 'rgba(0,0,0,0.06)',  // Elevated surfaces

  // Text colors
  text: '#121212',              // Primary text (dark)
  textSecondary: '#4A4A4A',     // Secondary text (medium gray)
  textTertiary: '#6B6B6B',      // Tertiary text (lighter gray)
  textMuted: '#999999',         // Muted text (light gray)
  textInverse: '#FFFFFF',      // Text on dark backgrounds

  // Border colors — hairline translucent black
  border: 'rgba(0,0,0,0.08)',            // Primary border color (light)
  borderLight: 'rgba(0,0,0,0.05)',       // Lighter border
  borderDark: 'rgba(0,0,0,0.12)',        // Darker border
  
  // Status colors (same as dark mode) — blue/monochrome, red only for errors
  success: '#2E90FA',
  warning: '#6B6B6B',
  error: '#EF4444',
  info: '#2E90FA',
  
  // Legacy colors
  legacy: {
    red: '#FF0050',             // Original red color
    black: '#000000',           // Original black
  }
};

// Default to dark colors for backward compatibility
export const colors = darkColors;

// Typography Configuration
export const typography = {
  // Font families
  fontFamily: {
    regular: 'Montserrat_400Regular',
    medium: 'Montserrat_500Medium',
    semiBold: 'Montserrat_600SemiBold',
    bold: 'Montserrat_700Bold',
    extraBold: 'Montserrat_800ExtraBold',
    black: 'Montserrat_900Black',
  },
  
  // Font sizes
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 28,
    '4xl': 32,
    '5xl': 36,
    '6xl': 48,
  },
  
  // Line heights
  lineHeight: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.6,
    loose: 1.8,
  },
  
  // Font weights
  fontWeight: {
    normal: '400',
    medium: '500',
    semiBold: '600',
    bold: '700',
    extraBold: '800',
    black: '900',
  },
};

// Spacing and Sizing
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
};

export const borderRadius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
};

// Shadow configurations (theme-aware)
export const getShadows = (isDark: boolean) => ({
  sm: {
    shadowColor: isDark ? '#000' : '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.1 : 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: isDark ? '#000' : '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.15 : 0.08,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor: isDark ? '#000' : '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.2 : 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  xl: {
    shadowColor: isDark ? '#000' : '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.25 : 0.15,
    shadowRadius: 16,
    elevation: 16,
  },
  primary: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
});

// Default shadows for backward compatibility
export const shadows = getShadows(true);

// Common style patterns (theme-aware)
export const getCommonStyles = (isDark: boolean) => {
  const currentColors = isDark ? darkColors : lightColors;
  const currentShadows = getShadows(isDark);
  
  return {
    // Container styles
    container: {
      flex: 1,
      backgroundColor: currentColors.background,
    },
    
    // Card styles
    card: {
      backgroundColor: currentColors.backgroundSecondary,
      borderRadius: borderRadius.lg,
      padding: spacing.lg,
      borderWidth: 1,
      borderColor: currentColors.border,
    },
    
    // Button styles
    button: {
      primary: {
        backgroundColor: currentColors.primary,
        borderRadius: borderRadius.lg,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xl,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        ...currentShadows.primary,
      },
      secondary: {
        backgroundColor: currentColors.backgroundSecondary,
        borderRadius: borderRadius.lg,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xl,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: currentColors.border,
      },
    },
    
    // Text styles
    text: {
      heading: {
        fontFamily: typography.fontFamily.bold,
        fontSize: typography.fontSize['3xl'],
        color: currentColors.text,
        lineHeight: typography.lineHeight.tight * typography.fontSize['3xl'],
      },
      subheading: {
        fontFamily: typography.fontFamily.semiBold,
        fontSize: typography.fontSize.xl,
        color: currentColors.text,
        lineHeight: typography.lineHeight.normal * typography.fontSize.xl,
      },
      body: {
        fontFamily: typography.fontFamily.regular,
        fontSize: typography.fontSize.base,
        color: currentColors.text,
        lineHeight: typography.lineHeight.normal * typography.fontSize.base,
      },
      caption: {
        fontFamily: typography.fontFamily.regular,
        fontSize: typography.fontSize.sm,
        color: currentColors.textSecondary,
        lineHeight: typography.lineHeight.normal * typography.fontSize.sm,
      },
    },
    
    // Input styles
    input: {
      backgroundColor: currentColors.backgroundSecondary,
      borderRadius: borderRadius.lg,
      padding: spacing.lg,
      color: currentColors.text,
      fontSize: typography.fontSize.base,
      fontFamily: typography.fontFamily.regular,
      borderWidth: 1,
      borderColor: currentColors.border,
    },
  };
};

// Default common styles for backward compatibility
export const commonStyles = getCommonStyles(true);

// Helper function to get theme colors
export const getThemeColors = (isDark: boolean) => {
  return isDark ? darkColors : lightColors;
};

// Export default theme object (dark mode for backward compatibility)
export const theme = {
  colors,
  typography,
  spacing,
  borderRadius,
  shadows,
  commonStyles,
  getThemeColors,
  getShadows,
  getCommonStyles,
};

export default theme;


