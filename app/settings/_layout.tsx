// app/settings/_layout.tsx
//
// Settings stack. Child screens (profile, subscription, units) use the
// NATIVE stack header: system chevron back button, interactive swipe-back,
// and the system header material (Liquid Glass on iOS 26 builds). The native
// appearance is kept in sync with the app theme via Appearance.setColorScheme
// in ThemeContext, so the system header always matches.
//
// The stack root (index) keeps its inline header — it's the first screen of
// this stack, so a native header would have no back affordance to offer.
import { Stack } from 'expo-router';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

export default function SettingsLayout() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                // Explicit themed header colors — the system header material
                // follows the NATIVE color scheme, which doesn't reliably
                // track the in-app theme toggle (users saw light headers on
                // the dark app). Solid app-background header instead.
                headerStyle: {
                    backgroundColor: colors.background,
                },
                headerTintColor: colors.primary,
                headerTitleStyle: {
                    fontFamily: 'Montserrat_600SemiBold',
                    color: colors.text,
                },
                contentStyle: {
                    backgroundColor: colors.background,
                },
            }}
        >
            <Stack.Screen name="index" />
            <Stack.Screen
                name="profile-information"
                options={{
                    headerShown: true,
                    title: 'Profile',
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontFamily: 'Montserrat_600SemiBold',
                        color: colors.text,
                    },
                }}
            />
            <Stack.Screen
                name="subscription"
                options={{
                    headerShown: true,
                    title: 'Subscription',
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontFamily: 'Montserrat_600SemiBold',
                        color: colors.text,
                    },
                }}
            />
            <Stack.Screen
                name="units"
                options={{
                    headerShown: true,
                    title: 'Units',
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontFamily: 'Montserrat_600SemiBold',
                        color: colors.text,
                    },
                }}
            />
            <Stack.Screen
                name="coach-memory"
                options={{
                    headerShown: true,
                    title: 'Coach Memory',
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontFamily: 'Montserrat_600SemiBold',
                        color: colors.text,
                    },
                }}
            />
            <Stack.Screen
                name="training-setup"
                options={{
                    headerShown: true,
                    title: 'Training Setup',
                    headerBackButtonDisplayMode: 'minimal',
                    headerTintColor: colors.primary,
                    headerTitleStyle: {
                        fontFamily: 'Montserrat_600SemiBold',
                        color: colors.text,
                    },
                }}
            />
        </Stack>
    );
}
