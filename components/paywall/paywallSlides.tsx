// components/paywall/paywallSlides.tsx
//
// Slide content for the native ConversionPaywall carousel.
//
// Each slide markets ONE Pro feature with a visual built entirely on-screen
// (no image assets): a mock Dynamic Island, a coach chat exchange, a smart
// food-log line, an analytics chart, and a workout-builder card. Every visual
// sits on a soft radial blue glow so the carousel reads as premium against
// the black paywall background.
//
// `getSlidesForContext(context)` reorders the deck so the feature the user
// just tried to use is the FIRST slide — the paywall answers the tap that
// opened it (Duolingo-style contextual ordering) instead of playing a
// generic ad.

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import Glow from '../ui/Glow';
import ProgressRing from '../ui/ProgressRing';

const BLUE = '#2E90FA';
const BLUE_LIGHT = '#5AA6FF';

export type PaywallSlideId = 'island' | 'coach' | 'food' | 'analytics' | 'workouts';

export interface PaywallSlide {
    id: PaywallSlideId;
    headline: string;
    sub: string;
    renderVisual: () => React.ReactElement;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slide visuals
// ---------------------------------------------------------------------------

function IslandVisual() {
    return (
        <View style={styles.stage}>
            <Glow />
            <View style={styles.islandPill}>
                <View style={styles.islandIcon}>
                    <Ionicons name="barbell" size={18} color="#FFFFFF" />
                </View>
                <View style={styles.islandCenter}>
                    <Text style={styles.islandLabel}>REST</Text>
                    <Text style={styles.islandTime}>0:47</Text>
                </View>
                <ProgressRing />
            </View>
            <View style={styles.islandCaptionRow}>
                <Ionicons name="lock-closed" size={12} color="rgba(255,255,255,0.45)" />
                <Text style={styles.islandCaption}>Live on your lock screen & Dynamic Island</Text>
            </View>
        </View>
    );
}

function CoachVisual() {
    return (
        <View style={styles.stage}>
            <Glow />
            <View style={styles.chatCol}>
                <View style={[styles.bubble, styles.bubbleUser]}>
                    <Text style={styles.bubbleUserText}>My knee hurts — can you swap leg press?</Text>
                </View>
                <View style={[styles.bubble, styles.bubbleCoach]}>
                    <View style={styles.coachTag}>
                        <Ionicons name="sparkles" size={11} color={BLUE_LIGHT} />
                        <Text style={styles.coachTagText}>LiftAI</Text>
                    </View>
                    <Text style={styles.bubbleCoachText}>
                        Swapped in Bulgarian split squats — same stimulus, zero knee stress.
                    </Text>
                </View>
            </View>
        </View>
    );
}

function FoodVisual() {
    return (
        <View style={styles.stage}>
            <Glow />
            <View style={styles.foodCol}>
                <View style={styles.foodInputRow}>
                    <Ionicons name="camera" size={16} color={BLUE_LIGHT} />
                    <Text style={styles.foodInputText}>Snap your plate — or just type it</Text>
                </View>
                <View style={styles.foodResultCard}>
                    <View style={styles.foodResultHeader}>
                        <View style={styles.foodCheck}>
                            <Ionicons name="checkmark" size={12} color="#000000" />
                        </View>
                        <Text style={styles.foodResultTitle}>Breakfast logged</Text>
                    </View>
                    <View style={styles.macroRow}>
                        <MacroChip value="412" label="cal" />
                        <MacroChip value="24g" label="protein" />
                        <MacroChip value="38g" label="carbs" />
                        <MacroChip value="16g" label="fat" />
                    </View>
                </View>
            </View>
        </View>
    );
}

function MacroChip({ value, label }: { value: string; label: string }) {
    return (
        <View style={styles.macroChip}>
            <Text style={styles.macroValue}>{value}</Text>
            <Text style={styles.macroLabel}>{label}</Text>
        </View>
    );
}

const BAR_HEIGHTS = [30, 42, 38, 54, 62, 58, 82];

function AnalyticsVisual() {
    return (
        <View style={styles.stage}>
            <Glow />
            <View style={styles.analyticsCard}>
                <View style={styles.analyticsHeader}>
                    <Text style={styles.analyticsTitle}>Bench Press · Volume</Text>
                    <View style={styles.analyticsDelta}>
                        <Ionicons name="trending-up" size={12} color={BLUE_LIGHT} />
                        <Text style={styles.analyticsDeltaText}>+18%</Text>
                    </View>
                </View>
                <View style={styles.barsRow}>
                    {BAR_HEIGHTS.map((h, i) => {
                        const isLast = i === BAR_HEIGHTS.length - 1;
                        return (
                            <View key={i} style={styles.barCol}>
                                {isLast && (
                                    <View style={styles.prBadge}>
                                        <Text style={styles.prBadgeText}>PR</Text>
                                    </View>
                                )}
                                <View
                                    style={[
                                        styles.bar,
                                        {
                                            height: h,
                                            backgroundColor: isLast ? BLUE : 'rgba(46,144,250,0.32)',
                                        },
                                    ]}
                                />
                            </View>
                        );
                    })}
                </View>
            </View>
        </View>
    );
}

function WorkoutsVisual() {
    return (
        <View style={styles.stage}>
            <Glow />
            <View style={styles.workoutCard}>
                <View style={styles.workoutHeader}>
                    <Text style={styles.workoutTitle}>Hotel Push Day</Text>
                    <Text style={styles.workoutMeta}>45 min · no machines</Text>
                </View>
                <View style={styles.exerciseRow}>
                    <Text style={styles.exerciseName}>Incline DB Press</Text>
                    <Text style={styles.exerciseSets}>4 × 10</Text>
                </View>
                <View style={[styles.exerciseRow, styles.swapRow]}>
                    <Text style={styles.exerciseNameMuted}>Leg Press</Text>
                    <Ionicons name="swap-horizontal" size={15} color={BLUE_LIGHT} />
                    <Text style={styles.exerciseName}>Split Squats</Text>
                </View>
                <View style={styles.generateRow}>
                    <Ionicons name="add" size={14} color={BLUE_LIGHT} />
                    <Text style={styles.generateText}>Generate a new workout</Text>
                </View>
            </View>
        </View>
    );
}

// ---------------------------------------------------------------------------
// Slide deck + contextual ordering
// ---------------------------------------------------------------------------

export const PAYWALL_SLIDES: PaywallSlide[] = [
    {
        id: 'island',
        headline: 'Your rest timer, on the Dynamic Island',
        sub: 'Lock your phone — the countdown stays live so you never miss the start of a set.',
        renderVisual: () => <IslandVisual />,
    },
    {
        id: 'coach',
        headline: 'A real coach in your pocket, 24/7',
        sub: 'Unlimited questions — swaps, form checks, programming. Free stops at 3 a day; Pro never does.',
        renderVisual: () => <CoachVisual />,
    },
    {
        id: 'food',
        headline: 'Point your camera at your food. Logged.',
        sub: 'Snap a photo — itemized calories and macros in seconds. Unlimited scans and AI logs.',
        renderVisual: () => <FoodVisual />,
    },
    {
        id: 'analytics',
        headline: 'See the progress you can’t feel yet',
        sub: 'Volume trends, PRs, and muscle balance across every single lift you do.',
        renderVisual: () => <AnalyticsVisual />,
    },
    {
        id: 'workouts',
        headline: 'Unlimited workouts, swaps & plan edits',
        sub: 'Generate the perfect session in one tap — add, swap, and reshape your week.',
        renderVisual: () => <WorkoutsVisual />,
    },
];

/**
 * Which slide should lead for a given paywall context. Contexts are either a
 * `GatedFeature` (user tapped a locked feature) or a `PaywallSource`
 * (onboarding, settings, quota…). Unknown contexts keep the default order,
 * which leads with the Dynamic Island — the most differentiated feature.
 */
const CONTEXT_LEAD_SLIDE: Record<string, PaywallSlideId> = {
    // GatedFeature values
    chat: 'coach',
    voice_coach: 'coach',
    nutrition_ai: 'food',
    photo_logging: 'food',
    dynamic_island: 'island',
    progress_analytics: 'analytics',
    saved_workouts_limit: 'workouts',
    plan_modifications: 'workouts',
    manual_edit: 'workouts',
    workout_generation: 'workouts',
    exercise_swap: 'workouts',
    // PaywallSource values that imply a feature
    quota_chat: 'coach',
    quota_nutrition: 'food',
};

export function getSlidesForContext(
    context: string,
    fallbackLead?: PaywallSlideId | null
): PaywallSlide[] {
    const lead = CONTEXT_LEAD_SLIDE[context] ?? fallbackLead ?? null;
    if (!lead) return PAYWALL_SLIDES;
    const leadSlide = PAYWALL_SLIDES.find((s) => s.id === lead);
    if (!leadSlide) return PAYWALL_SLIDES;
    return [leadSlide, ...PAYWALL_SLIDES.filter((s) => s.id !== lead)];
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
    stage: {
        height: 230,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // Dynamic Island
    islandPill: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#060606',
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
        paddingVertical: 14,
        paddingHorizontal: 18,
        gap: 14,
        width: 272,
        shadowColor: BLUE,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.45,
        shadowRadius: 24,
        elevation: 10,
    },
    islandIcon: {
        width: 38,
        height: 38,
        borderRadius: 999,
        backgroundColor: 'rgba(46,144,250,0.22)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    islandCenter: {
        flex: 1,
    },
    islandLabel: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 10,
        letterSpacing: 2.5,
        color: BLUE_LIGHT,
    },
    islandTime: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 26,
        color: '#FFFFFF',
        marginTop: 1,
    },
    islandCaptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 18,
    },
    islandCaption: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 12,
        color: 'rgba(255,255,255,0.45)',
    },

    // Coach chat
    chatCol: {
        width: 290,
        gap: 10,
    },
    bubble: {
        borderRadius: 16,
        paddingVertical: 11,
        paddingHorizontal: 14,
        maxWidth: 252,
    },
    bubbleUser: {
        alignSelf: 'flex-end',
        backgroundColor: BLUE,
        borderBottomRightRadius: 4,
    },
    bubbleUserText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        lineHeight: 18,
        color: '#FFFFFF',
    },
    bubbleCoach: {
        alignSelf: 'flex-start',
        backgroundColor: 'rgba(255,255,255,0.07)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderBottomLeftRadius: 4,
    },
    coachTag: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
    },
    coachTagText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 9,
        letterSpacing: 1.5,
        color: BLUE_LIGHT,
    },
    bubbleCoachText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        lineHeight: 18,
        color: 'rgba(255,255,255,0.92)',
    },

    // Smart food logging
    foodCol: {
        width: 300,
        gap: 10,
    },
    foodInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: 'rgba(255,255,255,0.07)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderRadius: 999,
        paddingVertical: 12,
        paddingHorizontal: 16,
    },
    foodInputText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        color: 'rgba(255,255,255,0.85)',
    },
    foodResultCard: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderRadius: 16,
        padding: 14,
        gap: 12,
    },
    foodResultHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    foodCheck: {
        width: 18,
        height: 18,
        borderRadius: 999,
        backgroundColor: BLUE_LIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    foodResultTitle: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13,
        color: '#FFFFFF',
    },
    macroRow: {
        flexDirection: 'row',
        gap: 8,
    },
    macroChip: {
        flex: 1,
        alignItems: 'center',
        backgroundColor: 'rgba(46,144,250,0.10)',
        borderWidth: 1,
        borderColor: 'rgba(46,144,250,0.28)',
        borderRadius: 12,
        paddingVertical: 8,
    },
    macroValue: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 13,
        color: '#FFFFFF',
    },
    macroLabel: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 10,
        color: 'rgba(255,255,255,0.5)',
        marginTop: 1,
    },

    // Analytics
    analyticsCard: {
        width: 300,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderRadius: 16,
        padding: 16,
    },
    analyticsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    analyticsTitle: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13,
        color: '#FFFFFF',
    },
    analyticsDelta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    analyticsDeltaText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 12,
        color: BLUE_LIGHT,
    },
    barsRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        height: 104,
    },
    barCol: {
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
    },
    bar: {
        width: 26,
        borderRadius: 8,
    },
    prBadge: {
        backgroundColor: BLUE,
        borderRadius: 8,
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    prBadgeText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 9,
        color: '#FFFFFF',
        letterSpacing: 0.5,
    },

    // Workouts
    workoutCard: {
        width: 300,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        borderRadius: 16,
        padding: 16,
        gap: 12,
    },
    workoutHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
    },
    workoutTitle: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 14,
        color: '#FFFFFF',
    },
    workoutMeta: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 11,
        color: 'rgba(255,255,255,0.5)',
    },
    exerciseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    swapRow: {
        borderWidth: 1,
        borderColor: 'rgba(46,144,250,0.35)',
        backgroundColor: 'rgba(46,144,250,0.08)',
        gap: 8,
        justifyContent: 'flex-start',
    },
    exerciseName: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13,
        color: '#FFFFFF',
    },
    exerciseNameMuted: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        color: 'rgba(255,255,255,0.45)',
        textDecorationLine: 'line-through',
    },
    exerciseSets: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 12,
        color: 'rgba(255,255,255,0.55)',
    },
    generateRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(255,255,255,0.22)',
        borderRadius: 12,
        paddingVertical: 9,
    },
    generateText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 12,
        color: BLUE_LIGHT,
    },
});
