// app/settings/units.tsx
/**
 * Units Screen
 * 
 * Route: /settings/units
 * Function: Manage measurement unit preferences
 * 
 * Features:
 * - Weight units selection (kg/lbs)
 * - Height units selection (cm/ft-in)
 * - Auto-save on selection change
 * - Persists to Supabase and AsyncStorage
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { toast } from '../../components/ui/Toast';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { supabase } from '../../utils/supabase';
import { getWeightUnit, setWeightUnit } from '../../utils/weightConverter';

const WEIGHT_UNITS = [
    { label: 'Kilograms (kg)', value: 'kg' as const },
    { label: 'Pounds (lbs)', value: 'lbs' as const },
];

const HEIGHT_UNITS = [
    { label: 'Centimeters (cm)', value: 'cm' as const },
    { label: 'Feet & Inches (ft/in)', value: 'ft' as const },
];

const HEIGHT_UNIT_KEY = '@liftai_height_unit';

export default function UnitsScreen() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const { session, loading: authLoading } = useRequireAuth();

    const [dataLoading, setDataLoading] = useState(true);
    const [savingWeight, setSavingWeight] = useState(false);
    const [savingHeight, setSavingHeight] = useState(false);
    const [weightUnit, setWeightUnitState] = useState<'kg' | 'lbs'>('kg');
    const [heightUnit, setHeightUnitState] = useState<'cm' | 'ft'>('cm');

    useEffect(() => {
        if (!authLoading && session) {
            loadUnits();
        }
    }, [authLoading, session]);

    const loadUnits = async () => {
        if (!session) return;

        try {
            setDataLoading(true);

            // Load weight unit from database
            const weight = await getWeightUnit();
            setWeightUnitState(weight);

            // Load height unit from AsyncStorage (and potentially database)
            const storedHeight = await AsyncStorage.getItem(HEIGHT_UNIT_KEY);
            if (storedHeight === 'cm' || storedHeight === 'ft') {
                setHeightUnitState(storedHeight);
            } else {
                // Try to load from database
                const { data } = await supabase
                    .from('user_profiles')
                    .select('height_unit')
                    .eq('id', session.user.id)
                    .single();

                if (data?.height_unit === 'cm' || data?.height_unit === 'ft') {
                    setHeightUnitState(data.height_unit);
                    await AsyncStorage.setItem(HEIGHT_UNIT_KEY, data.height_unit);
                }
            }
        } catch (error) {
            console.error('Error loading units:', error);
        } finally {
            setDataLoading(false);
        }
    };

    const handleWeightUnitChange = async (unit: 'kg' | 'lbs') => {
        if (unit === weightUnit) return;

        try {
            setSavingWeight(true);
            setWeightUnitState(unit);

            const result = await setWeightUnit(unit);

            if (!result.success) {
                // Revert on error
                setWeightUnitState(weightUnit);
                toast.error('Failed to save weight unit preference');
            }
        } catch (error) {
            console.error('Error saving weight unit:', error);
            setWeightUnitState(weightUnit);
            toast.error('Failed to save weight unit preference');
        } finally {
            setSavingWeight(false);
        }
    };

    const handleHeightUnitChange = async (unit: 'cm' | 'ft') => {
        if (unit === heightUnit || !session) return;

        try {
            setSavingHeight(true);
            setHeightUnitState(unit);

            // Save to AsyncStorage
            await AsyncStorage.setItem(HEIGHT_UNIT_KEY, unit);

            // Save to database
            const { error } = await supabase
                .from('user_profiles')
                .update({ height_unit: unit })
                .eq('id', session.user.id);

            if (error) {
                console.error('Error saving height unit to database:', error);
                // Still keep local preference even if database fails
            }
        } catch (error) {
            console.error('Error saving height unit:', error);
            setHeightUnitState(heightUnit);
            toast.error('Failed to save height unit preference');
        } finally {
            setSavingHeight(false);
        }
    };

    if (authLoading || dataLoading) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.text }]}>Loading preferences...</Text>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Header is the native stack header (see settings/_layout.tsx) */}

                {/* Weight Units Section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Weight</Text>
                    <Text style={[styles.sectionDescription, { color: colors.textMuted }]}>
                        Choose how weight is displayed throughout the app
                    </Text>

                    <View style={[styles.optionsCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border,
                    }]}>
                        {WEIGHT_UNITS.map((option, index) => (
                            <TouchableOpacity
                                key={option.value}
                                style={[styles.optionItem,
                                index < WEIGHT_UNITS.length - 1 && {
                                    borderBottomWidth: 1,
                                    borderBottomColor: colors.border
                                }
                                ]}
                                onPress={() => handleWeightUnitChange(option.value)}
                                disabled={savingWeight}
                            >
                                <Text style={[styles.optionText, { color: colors.text }]}>
                                    {option.label}
                                </Text>
                                {weightUnit === option.value && (
                                    savingWeight ? (
                                        <ActivityIndicator size="small" color={colors.primary} />
                                    ) : (
                                        <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                                    )
                                )}
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>

                {/* Height Units Section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Height</Text>
                    <Text style={[styles.sectionDescription, { color: colors.textMuted }]}>
                        Choose how height is displayed throughout the app
                    </Text>

                    <View style={[styles.optionsCard, {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.border,
                    }]}>
                        {HEIGHT_UNITS.map((option, index) => (
                            <TouchableOpacity
                                key={option.value}
                                style={[styles.optionItem,
                                index < HEIGHT_UNITS.length - 1 && {
                                    borderBottomWidth: 1,
                                    borderBottomColor: colors.border
                                }
                                ]}
                                onPress={() => handleHeightUnitChange(option.value)}
                                disabled={savingHeight}
                            >
                                <Text style={[styles.optionText, { color: colors.text }]}>
                                    {option.label}
                                </Text>
                                {heightUnit === option.value && (
                                    savingHeight ? (
                                        <ActivityIndicator size="small" color={colors.primary} />
                                    ) : (
                                        <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                                    )
                                )}
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>

                {/* Info Text */}
                <Text style={[styles.infoText, { color: colors.textMuted }]}>
                    Changes are saved automatically and will apply throughout the app.
                </Text>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        fontSize: 16,
        marginTop: 12,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
        paddingBottom: 40,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 32,
    },
    backButton: {
        padding: 4,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
    },
    placeholder: {
        width: 32,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
    },
    sectionDescription: {
        fontSize: 14,
        marginBottom: 16,
    },
    optionsCard: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    optionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
    },
    optionText: {
        fontSize: 16,
        fontWeight: '500',
    },
    infoText: {
        fontSize: 13,
        textAlign: 'center',
        marginTop: 8,
    },
});
