// app/settings/profile-information.tsx
/**
 * Profile Information Screen
 * 
 * Route: /settings/profile-information
 * Function: View and edit user profile information
 * 
 * Features:
 * - Display and edit name
 * - Display email (read-only)
 * - Edit gender (optional)
 * - Edit date of birth (optional)
 * - Save Changes button with form validation
 * - Connect to Supabase to update user metadata
 */

import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
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
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { replaceWithSignedOutRoot } from '../../utils/authNavigation';
import { getLocalDateString } from '../../utils/date';
import { getSession } from '../../utils/supabase';
import {
    deleteUserAccount,
    getUserProfile,
    updateUserProfile,
    type UserProfile,
    type UserProfileUpdate,
} from '../../utils/userProfile';



export default function ProfileInformationScreen() {
    const router = useRouter();
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [email, setEmail] = useState('');

    // Form fields
    const [name, setName] = useState('');
    const [gender, setGender] = useState('');
    const [birthday, setBirthday] = useState<Date | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);

    // Track if form has changes
    const [hasChanges, setHasChanges] = useState(false);

    useEffect(() => {
        loadProfile();
    }, []);

    // Track form changes
    useEffect(() => {
        if (!profile) return;

        const nameChanged = name !== (profile.name || '');
        const birthdayChanged = (birthday ? getLocalDateString(birthday) : undefined) !== profile.birthday?.split('T')[0];

        setHasChanges(nameChanged || birthdayChanged);
    }, [name, gender, birthday, profile]);

    const loadProfile = async () => {
        try {
            setLoading(true);
            const session = await getSession();

            if (!session) {
                toast.error('Please sign in to view your profile.');
                router.back();
                return;
            }

            setEmail(session.user.email || '');

            const { profile: userProfile, error } = await getUserProfile(session.user.id);

            if (error) {
                console.error('Error loading profile:', error);
                toast.error('Failed to load profile information.');
                return;
            }

            if (userProfile) {
                setProfile(userProfile);
                setName(userProfile.name || '');
                if (userProfile.birthday) {
                    setBirthday(new Date(userProfile.birthday));
                }
            }
        } catch (error) {
            console.error('Error loading profile:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!name.trim()) {
            toast.error('Name is required');
            return;
        }

        try {
            setSaving(true);
            const session = await getSession();

            if (!session) {
                toast.error('Session expired', 'Please sign in again.');
                replaceWithSignedOutRoot();
                return;
            }

            const updates: Partial<UserProfileUpdate> = {
                name: name.trim(),
                ...(birthday ? { birthday: getLocalDateString(birthday) } : {}),
            };

            const { error } = await updateUserProfile(session.user.id, updates);

            if (error) {
                toast.error('Failed to save changes', 'Please try again.');
                return;
            }

            toast.success('Profile updated');
            setHasChanges(false);

            // Reload profile to get updated data
            await loadProfile();
        } catch (error) {
            console.error('Error saving profile:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setSaving(false);
        }
    };

    const handleDateChange = (event: any, selectedDate?: Date) => {
        setShowDatePicker(Platform.OS === 'ios');
        if (selectedDate) {
            setBirthday(selectedDate);
        }
    };

    const formatDate = (date: Date | null) => {
        if (!date) return 'Not set';
        return date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    };

    const handleDeleteAccount = async () => {
        // First confirmation
        const proceed = await confirmSheet({
            title: 'Delete Account?',
            message: 'This will permanently delete your account and all your data including workout plans, exercise history, and chat messages. This action cannot be undone.',
            confirmLabel: 'Continue',
            destructive: true,
        });
        if (!proceed) return;

        // Second confirmation
        const confirmed = await confirmSheet({
            title: 'Are You Absolutely Sure?',
            message: 'This is your last chance. Once you confirm, your account and all data will be permanently deleted and cannot be recovered.',
            confirmLabel: 'Delete My Account',
            destructive: true,
        });
        if (!confirmed) return;

        try {
            setDeleting(true);
            const session = await getSession();

            if (!session) {
                toast.error('Session expired', 'Please sign in again.');
                replaceWithSignedOutRoot();
                return;
            }

            const { error } = await deleteUserAccount(session.user.id);

            if (error) {
                toast.error('Failed to delete account', String(error));
                setDeleting(false);
                return;
            }

            toast.success('Account deleted', 'Your account has been permanently deleted.');
            replaceWithSignedOutRoot();
        } catch (error) {
            console.error('Error deleting account:', error);
            toast.error('Something went wrong', 'Please try again.');
            setDeleting(false);
        }
    };



    if (loading) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.text }]}>Loading profile...</Text>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardAvoid}
            >
                <ScrollView
                    style={styles.scrollView}
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {/* Header is the native stack header (see settings/_layout.tsx) */}

                    {/* Form */}
                    <View style={styles.formContainer}>
                        {/* Name Field */}
                        <View style={styles.fieldContainer}>
                            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Name</Text>
                            <TextInput
                                style={[styles.textInput, {
                                    backgroundColor: colors.backgroundSecondary,
                                    color: colors.text,
                                    borderColor: colors.border,
                                }]}
                                value={name}
                                onChangeText={setName}
                                placeholder="Enter your name"
                                placeholderTextColor={colors.textMuted}
                            />
                        </View>

                        {/* Email Field (Read-only) */}
                        <View style={styles.fieldContainer}>
                            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Email</Text>
                            <View style={[styles.readOnlyField, {
                                backgroundColor: colors.backgroundSecondary,
                                borderColor: colors.border,
                            }]}>
                                <Text style={[styles.readOnlyText, { color: colors.textMuted }]}>{email}</Text>
                                <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
                            </View>
                            <Text style={[styles.fieldHint, { color: colors.textMuted }]}>
                                Email cannot be changed
                            </Text>
                        </View>

                        {/* Gender Field (Read-only) */}
                        <View style={styles.fieldContainer}>
                            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Gender</Text>
                            <View style={[styles.readOnlyField, {
                                backgroundColor: colors.backgroundSecondary,
                                borderColor: colors.border,
                            }]}>
                                <Text style={[styles.readOnlyText, { color: colors.text }]}>
                                    {profile?.gender || 'Not set'}
                                </Text>
                                <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
                            </View>
                            <Text style={[styles.fieldHint, { color: colors.textMuted }]}>
                                Gender is set during onboarding and cannot be changed
                            </Text>
                        </View>

                        {/* Date of Birth Field */}
                        <View style={styles.fieldContainer}>
                            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Date of Birth (Optional)</Text>
                            <TouchableOpacity
                                style={[styles.selectField, {
                                    backgroundColor: colors.backgroundSecondary,
                                    borderColor: colors.border,
                                }]}
                                onPress={() => setShowDatePicker(true)}
                            >
                                <Text style={[styles.selectText, {
                                    color: birthday ? colors.text : colors.textMuted
                                }]}>
                                    {formatDate(birthday)}
                                </Text>
                                <Ionicons name="calendar-outline" size={20} color={colors.textMuted} />
                            </TouchableOpacity>
                        </View>

                        {showDatePicker && (
                            <DateTimePicker
                                value={birthday || new Date(2000, 0, 1)}
                                mode="date"
                                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                                onChange={handleDateChange}
                                maximumDate={new Date()}
                                minimumDate={new Date(1920, 0, 1)}
                            />
                        )}
                    </View>

                    {/* Save Button */}
                    <TouchableOpacity
                        style={[styles.saveButton, {
                            backgroundColor: hasChanges ? colors.text : colors.textMuted,
                            opacity: hasChanges ? 1 : 0.5,
                        }]}
                        onPress={handleSave}
                        disabled={!hasChanges || saving}
                    >
                        {saving ? (
                            <ActivityIndicator size="small" color={colors.background} />
                        ) : (
                            <Text style={[styles.saveButtonText, { color: colors.background }]}>
                                Save Changes
                            </Text>
                        )}
                    </TouchableOpacity>

                    {/* Delete Account Section */}
                    <View style={styles.dangerZone}>
                        <Text style={[styles.dangerZoneTitle, { color: colors.textSecondary }]}>
                            Danger Zone
                        </Text>
                        <Text style={[styles.dangerZoneDescription, { color: colors.textMuted }]}>
                            Once you delete your account, there is no going back. Please be certain.
                        </Text>
                        <TouchableOpacity
                            style={[styles.deleteButton, {
                                backgroundColor: isDark ? '#B91C1C' : '#EF4444',
                                opacity: deleting ? 0.5 : 1,
                            }]}
                            onPress={handleDeleteAccount}
                            disabled={deleting}
                        >
                            {deleting ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                            ) : (
                                <>
                                    <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                                    <Text style={styles.deleteButtonText}>
                                        Delete My Account
                                    </Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    keyboardAvoid: {
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
    formContainer: {
        gap: 24,
    },
    fieldContainer: {
        gap: 8,
    },
    fieldLabel: {
        fontSize: 14,
        fontWeight: '500',
    },
    textInput: {
        borderRadius: 12,
        padding: 16,
        fontSize: 16,
        borderWidth: 1,
    },
    readOnlyField: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    readOnlyText: {
        fontSize: 16,
        flex: 1,
    },
    fieldHint: {
        fontSize: 12,
        marginTop: 4,
    },
    selectField: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    selectText: {
        fontSize: 16,
    },
    pickerContainer: {
        borderRadius: 12,
        borderWidth: 1,
        marginTop: 8,
        overflow: 'hidden',
    },
    pickerOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(128, 128, 128, 0.2)',
    },
    pickerOptionText: {
        fontSize: 16,
    },
    saveButton: {
        marginTop: 32,
        borderRadius: 12,
        padding: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    saveButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    dangerZone: {
        marginTop: 48,
        paddingTop: 24,
        borderTopWidth: 1,
        borderTopColor: 'rgba(220, 20, 60, 0.2)',
    },
    dangerZoneTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
    },
    dangerZoneDescription: {
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 16,
    },
    deleteButton: {
        borderRadius: 12,
        padding: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
    },
    deleteButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
});
