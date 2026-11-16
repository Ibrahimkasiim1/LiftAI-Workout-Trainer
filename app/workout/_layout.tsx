// app/workout/_layout.tsx
import { Stack } from 'expo-router';
import { View } from 'react-native';
import WorkoutCircularTimer from '../../components/WorkoutCircularTimer';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

export default function WorkoutLayout() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    return (
        <View style={{ flex: 1 }}>
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
                }}
            >
                <Stack.Screen name="index" />
                <Stack.Screen name="day-detail" />
                <Stack.Screen name="edit-day" />
                <Stack.Screen name="edit-week" />
                <Stack.Screen name="exercise-detail" />
            </Stack>
            <WorkoutCircularTimer />
        </View>
    );
}
