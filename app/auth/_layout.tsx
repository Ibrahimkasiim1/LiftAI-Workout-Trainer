// app/auth/_layout.tsx
/**
 * Auth Directory Layout
 * 
 * Function: Configuration for all authentication screens
 * 
 * Features:
 * - Hides headers for all auth screens (they have custom headers)
 * - Stack navigator configuration
 * - Consistent navigation styling
 */

import { Stack } from 'expo-router';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

export default function AuthLayout() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    return (
        <Stack
            screenOptions={{
                headerShown: false, // All auth screens have custom headers
                headerStyle: {
                    backgroundColor: colors.background,
                },
                headerTintColor: colors.text,
                headerTitleStyle: {
                    fontFamily: 'Montserrat_700Bold',
                },
                presentation: 'card',
            }}
        >
            <Stack.Screen name="index" />
            <Stack.Screen name="welcome" />
            <Stack.Screen name="reset-password" />
        </Stack>
    );
}
