// app/settings/training-setup.tsx
/**
 * Training Setup Screen
 *
 * Route: /settings/training-setup
 * Function: Edit training locations, available equipment, and injuries AFTER
 * onboarding. Before this screen existed these answers were locked in forever
 * — a user who bought dumbbells or tweaked a shoulder had no way to tell the
 * app outside of redoing onboarding.
 *
 * Saves to user_profiles (location / available_equipment / injuries), the same
 * columns the plan generator and the chat coach already read.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { toast } from '../../components/ui/Toast';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { supabase } from '../../utils/supabase';

// Kept in sync with the onboarding equipment vocabulary (canonical buckets +
// the accessory chips the backend availability filter understands).
const EQUIPMENT_OPTIONS: Array<{ label: string; value: string }> = [
    { label: 'Bodyweight', value: 'body weight' },
    { label: 'Dumbbell', value: 'dumbbell' },
    { label: 'Barbell', value: 'barbell' },
    { label: 'EZ Barbell', value: 'ez barbell' },
    { label: 'Kettlebell', value: 'kettlebell' },
    { label: 'Cable', value: 'cable' },
    { label: 'Machine', value: 'machine' },
    { label: 'Smith Machine', value: 'smith machine' },
    { label: 'Resistance Band', value: 'band' },
    { label: 'Exercise Ball', value: 'ball' },
    { label: 'Bench', value: 'bench' },
    { label: 'Pull-up Bar', value: 'pull-up bar' },
];

const INJURY_OPTIONS = ['Knees', 'Shoulders', 'Lower Back', 'Wrists', 'Elbows', 'Ankles'];

function locationsToDbValue(locations: string[]): string {
    if (locations.includes('home') && locations.includes('gym')) return 'hybrid';
    return locations[0] ?? 'gym';
}

function dbValueToLocations(location: string | null | undefined): string[] {
    if (location === 'hybrid') return ['home', 'gym'];
    return location ? [location] : ['gym'];
}

export default function TrainingSetupScreen() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const { session, loading: authLoading } = useRequireAuth();

    const [dataLoading, setDataLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    const [locations, setLocations] = useState<string[]>(['gym']);
    const [equipment, setEquipment] = useState<string[]>([]);
    const [injuries, setInjuries] = useState<string[]>([]);
    const [injuryNotes, setInjuryNotes] = useState('');

    useEffect(() => {
        if (!authLoading && session) {
            void loadProfile();
        }
    }, [authLoading, session]);

    const loadProfile = async () => {
        if (!session) return;
        try {
            setDataLoading(true);
            const { data } = await supabase
                .from('user_profiles')
                .select('location, available_equipment, injuries')
                .eq('id', session.user.id)
                .maybeSingle();

            setLocations(dbValueToLocations(data?.location));
            setEquipment(Array.isArray(data?.available_equipment) ? data.available_equipment : []);

            // injuries is stored as one comma-joined string: split back into
            // known chips + free-text remainder.
            const parts = String(data?.injuries ?? '')
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean);
            const chips = parts.filter((p) => INJURY_OPTIONS.includes(p));
            const rest = parts.filter((p) => !INJURY_OPTIONS.includes(p));
            setInjuries(chips);
            setInjuryNotes(rest.join(', '));
        } catch (error) {
            console.error('Error loading training setup:', error);
        } finally {
            setDataLoading(false);
        }
    };

    const toggleLocation = (loc: 'home' | 'gym') => {
        const isOn = locations.includes(loc);
        if (isOn && locations.length === 1) return; // keep at least one
        setLocations(isOn ? locations.filter((l) => l !== loc) : [...locations, loc]);
        setDirty(true);
    };

    const toggleEquipment = (value: string) => {
        setEquipment((prev) =>
            prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]
        );
        setDirty(true);
    };

    const toggleInjury = (value: string) => {
        setInjuries((prev) =>
            prev.includes(value) ? prev.filter((i) => i !== value) : [...prev, value]
        );
        setDirty(true);
    };

    const handleSave = async () => {
        if (!session) return;
        if (equipment.length === 0) {
            toast.error('Select at least one piece of equipment');
            return;
        }
        try {
            setSaving(true);
            const { error } = await supabase
                .from('user_profiles')
                .update({
                    location: locationsToDbValue(locations),
                    available_equipment: equipment,
                    injuries: [...injuries, injuryNotes.trim()].filter(Boolean).join(', '),
                })
                .eq('id', session.user.id);
            if (error) {
                toast.error('Could not save', 'Please try again.');
                return;
            }
            setDirty(false);
            toast.success(
                'Training setup saved',
                'Future workouts use this. Ask your coach in Chat to rebuild your plan with it.'
            );
        } catch (error) {
            console.error('Error saving training setup:', error);
            toast.error('Could not save', 'Please try again.');
        } finally {
            setSaving(false);
        }
    };

    if (authLoading || dataLoading) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.text }]}>Loading training setup...</Text>
                </View>
            </SafeAreaView>
        );
    }

    const chipStyle = (on: boolean) => [
        styles.chip,
        {
            backgroundColor: on ? `${colors.primary}22` : colors.backgroundSecondary,
            borderColor: on ? colors.primary : colors.border,
        },
    ];
    const chipTextStyle = (on: boolean) => [
        styles.chipText,
        { color: on ? colors.primary : colors.text },
    ];

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Locations */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Where you train</Text>
                    <Text style={[styles.sectionDescription, { color: colors.textMuted }]}>
                        Pick one or both. Selecting both keeps home days doable with your home gear.
                    </Text>
                    <View style={styles.chipRow}>
                        {(['home', 'gym'] as const).map((loc) => {
                            const on = locations.includes(loc);
                            return (
                                <TouchableOpacity
                                    key={loc}
                                    style={[...chipStyle(on), styles.locationChip]}
                                    onPress={() => toggleLocation(loc)}
                                >
                                    <Ionicons
                                        name={loc === 'home' ? 'home' : 'barbell'}
                                        size={18}
                                        color={on ? colors.primary : colors.textMuted}
                                    />
                                    <Text style={chipTextStyle(on)}>{loc === 'home' ? 'Home' : 'Gym'}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>

                {/* Equipment */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Your equipment</Text>
                    <Text style={[styles.sectionDescription, { color: colors.textMuted }]}>
                        Workouts only use gear you select here.
                    </Text>
                    <View style={styles.chipRow}>
                        {EQUIPMENT_OPTIONS.map((item) => {
                            const on = equipment.includes(item.value);
                            return (
                                <TouchableOpacity
                                    key={item.value}
                                    style={chipStyle(on)}
                                    onPress={() => toggleEquipment(item.value)}
                                >
                                    <Text style={chipTextStyle(on)}>{item.label}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>

                {/* Injuries */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>Injuries & concerns</Text>
                    <Text style={[styles.sectionDescription, { color: colors.textMuted }]}>
                        We exclude risky movements and add modification cues for anything flagged here.
                    </Text>
                    <View style={styles.chipRow}>
                        {INJURY_OPTIONS.map((injury) => {
                            const on = injuries.includes(injury);
                            return (
                                <TouchableOpacity
                                    key={injury}
                                    style={chipStyle(on)}
                                    onPress={() => toggleInjury(injury)}
                                >
                                    <Text style={chipTextStyle(on)}>{injury}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                    <TextInput
                        style={[styles.notesInput, {
                            backgroundColor: colors.backgroundSecondary,
                            borderColor: colors.border,
                            color: colors.text,
                        }]}
                        value={injuryNotes}
                        onChangeText={(t) => { setInjuryNotes(t); setDirty(true); }}
                        placeholder="Anything else we should know? (optional)"
                        placeholderTextColor={colors.textMuted}
                        multiline
                        numberOfLines={3}
                        textAlignVertical="top"
                    />
                </View>

                <TouchableOpacity
                    style={[styles.saveButton, {
                        backgroundColor: dirty ? colors.text : colors.backgroundSecondary,
                        borderColor: colors.border,
                    }]}
                    onPress={handleSave}
                    disabled={saving || !dirty}
                >
                    {saving ? (
                        <ActivityIndicator size="small" color={dirty ? colors.textInverse : colors.textMuted} />
                    ) : (
                        <Text style={[styles.saveButtonText, { color: dirty ? colors.textInverse : colors.textMuted }]}>
                            {dirty ? 'Save Changes' : 'Saved'}
                        </Text>
                    )}
                </TouchableOpacity>

                <Text style={[styles.infoText, { color: colors.textMuted }]}>
                    Changes apply to newly generated workouts. To rebuild your current plan around
                    them, ask your coach in Chat.
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
    section: {
        marginBottom: 28,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 6,
    },
    sectionDescription: {
        fontSize: 14,
        marginBottom: 14,
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 20,
        borderWidth: 1,
    },
    locationChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 22,
    },
    chipText: {
        fontSize: 14,
        fontWeight: '600',
    },
    notesInput: {
        marginTop: 14,
        borderRadius: 12,
        borderWidth: 1,
        padding: 12,
        fontSize: 14,
        minHeight: 72,
    },
    saveButton: {
        borderRadius: 14,
        borderWidth: 1,
        paddingVertical: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    saveButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    infoText: {
        fontSize: 13,
        textAlign: 'center',
        marginTop: 4,
    },
});
