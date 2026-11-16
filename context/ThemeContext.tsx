import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Appearance, useColorScheme } from 'react-native';

type ThemeContextType = {
    isDark: boolean;
    toggleTheme: () => void;
    setTheme: (isDark: boolean) => void;
};

const ThemeContext = createContext<ThemeContextType>({
    isDark: true,
    toggleTheme: () => { },
    setTheme: () => { },
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const systemColorScheme = useColorScheme();
    const [isDark, setIsDark] = useState(true); // Default to dark mode
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        loadThemePreference();
    }, []);

    // Keep NATIVE chrome (tab bar, stack headers, sheets, alerts) in the same
    // appearance as the app theme. Without this, a user running the dark app
    // on a light-mode phone would get a light glass tab bar over black UI.
    useEffect(() => {
        Appearance.setColorScheme(isDark ? 'dark' : 'light');
    }, [isDark]);

    const loadThemePreference = async () => {
        try {
            const savedTheme = await AsyncStorage.getItem('theme_preference');
            if (savedTheme !== null) {
                setIsDark(savedTheme === 'dark');
            } else {
                // If no preference, default to dark (per app design) or system preference
                // For LiftAI, we seem to prefer dark mode by default
                setIsDark(true);
            }
        } catch (error) {
            console.error('Failed to load theme preference:', error);
        } finally {
            setIsLoaded(true);
        }
    };

    const toggleTheme = async () => {
        const newIsDark = !isDark;
        setIsDark(newIsDark);
        try {
            await AsyncStorage.setItem('theme_preference', newIsDark ? 'dark' : 'light');
        } catch (error) {
            console.error('Failed to save theme preference:', error);
        }
    };

    const setTheme = async (dark: boolean) => {
        setIsDark(dark);
        try {
            await AsyncStorage.setItem('theme_preference', dark ? 'dark' : 'light');
        } catch (error) {
            console.error('Failed to save theme preference:', error);
        }
    };

    return (
        <ThemeContext.Provider value={{ isDark, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
};
