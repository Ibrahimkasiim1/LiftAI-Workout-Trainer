// app/settings/coach-memory.tsx
/**
 * Coach Memory — "what I know about you"
 *
 * Route: /settings/coach-memory
 * Surfaces the categorized facts the AI coach has remembered (coach_memories)
 * and lets the user delete any of them. Trust + GDPR surface: the coach's
 * memory is always visible and always erasable.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { getThemeColors, theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { backendClient, CoachMemory } from '../../src/api/backendClient';
import { posthog } from '../../src/config/posthog';

const CATEGORY_META: Record<
    CoachMemory['category'],
    { label: string; icon: keyof typeof Ionicons.glyphMap }
> = {
    preference: { label: 'Preferences', icon: 'heart-outline' },
    goal: { label: 'Goals', icon: 'flag-outline' },
    injury: { label: 'Injuries & pain', icon: 'bandage-outline' },
    body_change: { label: 'Body changes', icon: 'trending-up-outline' },
    training_phase: { label: 'Training phase', icon: 'barbell-outline' },
    life_context: { label: 'Life context', icon: 'calendar-outline' },
    equipment: { label: 'Equipment', icon: 'construct-outline' },
    food_pattern: { label: 'Food patterns', icon: 'restaurant-outline' },
};

const CATEGORY_ORDER: CoachMemory['category'][] = [
    'goal',
    'injury',
    'preference',
    'training_phase',
    'equipment',
    'food_pattern',
    'body_change',
    'life_context',
];

export default function CoachMemoryScreen() {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    const [memories, setMemories] = useState<CoachMemory[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const load = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);
        setError(null);
        try {
            const rows = await backendClient.getCoachMemories();
            setMemories(rows);
        } catch (e) {
            console.error('Failed to load coach memories:', e);
            setError('Could not load your coach memory. Pull to retry.');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        posthog.capture('coach_memory_screen_opened');
        void load();
    }, [load]);

    const handleDelete = useCallback(async (memory: CoachMemory) => {
        const ok = await confirmSheet({
            title: 'Forget this?',
            message: `Your coach will no longer remember: "${memory.fact}"`,
            confirmLabel: 'Forget',
            destructive: true,
        });
        if (!ok) return;
        setDeletingId(memory.id);
        try {
            await backendClient.deleteCoachMemory(memory.id);
            setMemories(prev => prev.filter(m => m.id !== memory.id));
            posthog.capture('coach_memory_deleted', { category: memory.category });
            toast.success('Forgotten', 'Your coach will no longer use this.');
        } catch (e) {
            console.error('Failed to delete memory:', e);
            toast.error('Could not delete', 'Please try again.');
        } finally {
            setDeletingId(null);
        }
    }, []);

    const grouped = CATEGORY_ORDER
        .map(category => ({
            category,
            items: memories.filter(m => m.category === category),
        }))
        .filter(g => g.items.length > 0);

    return (
        <ScrollView
            style={[styles.container, { backgroundColor: colors.background }]}
            contentContainerStyle={styles.content}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => void load(true)}
                    tintColor={colors.primary}
                />
            }
        >
            <Text style={[styles.intro, { color: colors.textSecondary }]}>
                As you chat, your coach remembers what matters — goals, injuries,
                preferences — to personalize your training. You can remove anything here
                at any time.
            </Text>

            {loading ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : error ? (
                <View style={styles.center}>
                    <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{error}</Text>
                    <TouchableOpacity
                        style={[styles.retryButton, { backgroundColor: colors.text }]}
                        onPress={() => void load()}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading coach memory"
                    >
                        <Text style={[styles.retryButtonText, { color: colors.textInverse }]}>Retry</Text>
                    </TouchableOpacity>
                </View>
            ) : grouped.length === 0 ? (
                <View style={styles.center}>
                    <Ionicons name="sparkles-outline" size={48} color={colors.textSecondary} />
                    <Text style={[styles.emptyTitle, { color: colors.text }]}>Nothing yet</Text>
                    <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
                        Chat with your coach and it will start remembering what matters to
                        your training.
                    </Text>
                </View>
            ) : (
                grouped.map(({ category, items }) => (
                    <View key={category} style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons
                                name={CATEGORY_META[category].icon}
                                size={16}
                                color={colors.textSecondary}
                            />
                            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                                {CATEGORY_META[category].label}
                            </Text>
                        </View>
                        <View
                            style={[
                                styles.card,
                                { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                            ]}
                        >
                            {items.map((memory, idx) => (
                                <View
                                    key={memory.id}
                                    style={[
                                        styles.memoryRow,
                                        idx < items.length - 1 && [styles.memoryRowDivider, { borderBottomColor: colors.border }],
                                    ]}
                                >
                                    <Text style={[styles.memoryText, { color: colors.text }]}>
                                        {memory.fact}
                                    </Text>
                                    <TouchableOpacity
                                        onPress={() => void handleDelete(memory)}
                                        disabled={deletingId === memory.id}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Forget: ${memory.fact}`}
                                    >
                                        {deletingId === memory.id ? (
                                            <ActivityIndicator size="small" color={colors.textSecondary} />
                                        ) : (
                                            <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
                                        )}
                                    </TouchableOpacity>
                                </View>
                            ))}
                        </View>
                    </View>
                ))
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        padding: 20,
        paddingBottom: 48,
    },
    intro: {
        fontSize: 14,
        lineHeight: 20,
        fontFamily: theme.typography.fontFamily.regular,
        marginBottom: 20,
    },
    center: {
        alignItems: 'center',
        paddingVertical: 64,
        paddingHorizontal: 24,
    },
    emptyTitle: {
        fontSize: 17,
        fontFamily: theme.typography.fontFamily.semiBold,
        marginTop: 14,
        textAlign: 'center',
    },
    emptySubtitle: {
        fontSize: 14,
        lineHeight: 20,
        fontFamily: theme.typography.fontFamily.regular,
        marginTop: 6,
        textAlign: 'center',
    },
    retryButton: {
        marginTop: 16,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 12,
    },
    retryButtonText: {
        fontSize: 14,
        fontFamily: theme.typography.fontFamily.semiBold,
    },
    section: {
        marginBottom: 20,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
        paddingHorizontal: 4,
    },
    sectionTitle: {
        fontSize: 13,
        fontFamily: theme.typography.fontFamily.semiBold,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    card: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    memoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    memoryRowDivider: {
        borderBottomWidth: 1,
    },
    memoryText: {
        flex: 1,
        fontSize: 15,
        lineHeight: 21,
        fontFamily: theme.typography.fontFamily.regular,
    },
});
