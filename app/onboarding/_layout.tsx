// app/onboarding/_layout.tsx
import { Stack } from 'expo-router';
import { getThemeColors } from '../../constants/theme';

export default function OnboardingLayout() {
    const colors = getThemeColors(true); // Always dark mode for onboarding

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                headerStyle: {
                    backgroundColor: colors.background,
                },
                headerTintColor: colors.text,
                headerTitleStyle: {
                    fontFamily: 'Montserrat_700Bold',
                },
                presentation: 'card',
                gestureEnabled: false,
            }}
        >
            <Stack.Screen name="index" />
            <Stack.Screen name="paywall" />
            <Stack.Screen name="plan-generation" />
            <Stack.Screen name="plan-review" />
            <Stack.Screen name="first-workout" />
            <Stack.Screen name="notification-setup" />
        </Stack>
    );
}