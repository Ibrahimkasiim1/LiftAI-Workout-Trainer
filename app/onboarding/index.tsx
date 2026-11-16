// app/onboarding/index.tsx
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    Image,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, {
    Defs,
    LinearGradient as SvgLinearGradient,
    Path,
    Stop,
} from 'react-native-svg';

import {
    OnboardingChoiceCard,
    OnboardingListChoiceRow,
} from '../../components/onboarding/OnboardingChoiceCard';
import { HorizontalSnapPicker } from '../../components/onboarding/HorizontalSnapPicker';
import { OnboardingProgressHeader } from '../../components/onboarding/OnboardingProgressHeader';
import { VerticalRulerPicker } from '../../components/onboarding/VerticalRulerPicker';
import { toast } from '../../components/ui/Toast';
import { getApiUrl } from '../../config/api';
import { getFirstName } from '../../utils/nameUtils';
import { replaceWithSignedOutRoot } from '../../utils/authNavigation';
import {
    formatWeeklyRate,
    isPaceKey,
    projectGoal,
    weeklyRateKg,
    type PaceKey,
} from '../../utils/paceProjection';
import { posthog } from '../../src/config/posthog';
import { getSession, supabase } from '../../utils/supabase';
import { writeFunnelSnapshot } from '../../utils/funnelState';
import { savePartialOnboardingProfile, saveUserProfile } from '../../utils/userProfile';

const TEMP_DATA_KEY = '@onboarding_temp_data';
const PENDING_COMPLETE_KEY = '@onboarding_pending_complete';

/**
 * Single resolver for the user's preferred name across all auth providers.
 * Priority: explicit DB profile → OAuth user_metadata → AsyncStorage cache.
 * Returns { full, first } — empty strings when nothing is found.
 */
async function resolveUserName(
    userMetadata: Record<string, string | undefined> | undefined,
    profileNameFromDb: string,
): Promise<{ full: string; first: string }> {
    const fromMeta =
        [userMetadata?.given_name, userMetadata?.family_name].filter(Boolean).join(' ').trim() ||
        userMetadata?.full_name?.trim() ||
        userMetadata?.name?.trim() ||
        '';

    const [savedFirst, savedFull] = await Promise.all([
        AsyncStorage.getItem('@user_name'),
        AsyncStorage.getItem('@user_full_name'),
    ]);

    const full =
        profileNameFromDb.trim() ||
        fromMeta ||
        savedFull?.trim() ||
        savedFirst?.trim() ||
        '';
    const first = getFirstName(full);
    return { full, first };
}

interface OnboardingData {
    name: string;
    birthday: string;
    gender: string;
    goal: string;
    workout_days_per_week: number;
    selected_workout_days?: { [day: string]: boolean };
    workout_split_type: string;
    location: string;
    available_equipment: string[];
    injuries?: string;
    height_cm: number;
    weight_kg: number;
    goal_weight_kg: number;
    pace: string;
    fitness_level: string;
    workout_duration_minutes: number;
}

const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// Canonical equipment buckets (match exercises.equipment_canonical so the
// workout generator's equipment filter resolves cleanly). "Machine" covers all
// plate-loaded/selectorized/leverage/assisted variants — no more ambiguous
// "leverage machine", and no duplicate band/ball entries.
const SUPPORTED_ONBOARDING_EQUIPMENT: Array<{ label: string; value: string }> = [
    // Bodyweight is always an option and is what "Home" pre-selects, so it must
    // be a visible, toggleable chip — otherwise home users see zero selected
    // chips while validation silently passes.
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
    // Not a search bucket — it gates accessory-dependent moves (pull-ups,
    // chin-ups, hanging work) that are bodyweight-bucketed but need a bar.
    { label: 'Pull-up Bar', value: 'pull-up bar' },
];

/** Equipment preset applied when a location is toggled on. */
const LOCATION_EQUIPMENT_PRESETS: Record<string, string[]> = {
    // Home starts honest: bodyweight only — users add what they actually own.
    home: ['body weight'],
    // A commercial gym has everything — preselect all so the user deselects
    // exceptions instead of enumerating gear.
    gym: SUPPORTED_ONBOARDING_EQUIPMENT.map((e) => e.value),
};

/** Multi-select locations → the single DB value ('home' | 'gym' | 'hybrid'). */
function locationsToDbValue(locations: string[]): string {
    if (locations.includes('home') && locations.includes('gym')) return 'hybrid';
    return locations[0] ?? '';
}

/** DB value → multi-select locations (restores 'hybrid' as both cards on). */
function dbValueToLocations(location: string): string[] {
    if (location === 'hybrid') return ['home', 'gym'];
    return location ? [location] : [];
}

// ============================================================================
// Step order (goal-first, like the highest-converting onboarding funnels):
//   "Your goal":  1 goal · 2 gender · 3 fitness level · 4 training days
//   "About you":  5 age · 6 height · 7 weight · 8 goal weight · 9 pace
//   (momentum interstitial)
//   "Your plan":  10 split · 11 duration · 12 equipment · 13 injuries
// Steps 8–9 are skipped for goal === 'maintain'. Step 0 = name-only recovery.
// ============================================================================
const TOTAL_STEPS = 13;
/** First step of the "Your plan" section — resume target for users who already answered 1–9. */
const PLAN_SECTION_START = 10;

/** FlatList (wheel pickers) must not sit inside a scrolling parent — disable outer scroll on these steps. */
const STEPS_WITH_SNAPPING_WHEEL = new Set([5, 6, 7, 8]);

// Workout splits, with the minimum number of training days each one needs to be
// coherent. A "Bro Split" on 2 days makes no sense, so we ask days FIRST (step 4)
// and then only let the user pick a split that fits their day count (step 10).
type SplitDef = { key: string; label: string; subtitle: string; minDays: number };
const WORKOUT_SPLITS: SplitDef[] = [
    { key: 'full_body', label: 'Full Body', subtitle: 'Work everything each session', minDays: 1 },
    { key: 'upper_lower', label: 'Upper/Lower', subtitle: 'Alternate upper and lower body', minDays: 2 },
    { key: 'ppl', label: 'Push/Pull/Legs', subtitle: 'Popular 3-day split', minDays: 3 },
    { key: 'bro_split', label: 'Bro Split', subtitle: 'One muscle group per day', minDays: 4 },
];

/** Recommended split for a given number of training days per week. */
function recommendedSplitForDays(dayCount: number): SplitDef {
    if (dayCount <= 2) return WORKOUT_SPLITS[0]; // full_body
    if (dayCount === 3) return WORKOUT_SPLITS[2]; // ppl
    if (dayCount === 4) return WORKOUT_SPLITS[1]; // upper_lower
    return WORKOUT_SPLITS[2]; // 5+ days → ppl
}

/** Human-readable label for the chosen goal, used to mirror it back in copy. */
function goalNoun(goal: string): string {
    switch (goal) {
        case 'lose': return 'fat-loss';
        case 'gain': return 'muscle-building';
        case 'maintain': return 'maintenance';
        default: return 'fitness';
    }
}

export default function OnboardingScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ restart?: string; nameEntry?: string }>();
    const shouldRestartFromStepOne = params.restart === '1';
    const forceNameEntry = params.nameEntry === '1';
    const insets = useSafeAreaInsets();

    const [currentStep, setCurrentStep] = useState(1);
    const [showIntro, setShowIntro] = useState(true);
    const [loading, setLoading] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [checkingAuth, setCheckingAuth] = useState(true);
    const [needsNameEntry, setNeedsNameEntry] = useState(false);
    /** Momentum beat shown between "About you" (step 9) and "Your plan" (step 10). */
    const [showInterstitial, setShowInterstitial] = useState(false);
    /** True only when an authenticated user resumed at the plan section (steps 10–13). */
    const [resumedAtPlanSection, setResumedAtPlanSection] = useState(false);
    /** Where the name-entry step (0) should land after a name is provided. */
    const postNameResumeStepRef = React.useRef(1);

    const [selectedAge, setSelectedAge] = useState(25);
    const [selectedInjuries, setSelectedInjuries] = useState<string[]>([]);
    const [ageError, setAgeError] = useState<string | null>(null);

    // Warm the backend as soon as the user hits the momentum interstitial or
    // the "Your plan" section: a cold pod (deploy/restart) adds tens of
    // seconds to plan generation, and generation now starts at paywall mount
    // (see onboarding/paywall.tsx) — one throwaway /health ping here means
    // that request lands on a warm server. Fire-and-forget, once per visit.
    const backendWarmedRef = React.useRef(false);
    useEffect(() => {
        if (backendWarmedRef.current) return;
        if (!showInterstitial && currentStep < PLAN_SECTION_START) return;
        backendWarmedRef.current = true;
        void fetch(`${getApiUrl()}/health`).catch(() => {
            // Purely a warm-up; generation has its own retries.
        });
    }, [currentStep, showInterstitial]);

    // Today is a locked-in training day (see renderStepSchedule) — make sure
    // the DATA agrees with the UI the moment the schedule step is reached, so
    // the generated plan always has a workout on day one even if the user
    // never taps a day card.
    useEffect(() => {
        if (currentStep !== 4) return;
        const todayKey = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
        setData((prev) => {
            const days = prev.selected_workout_days || {};
            if (todayKey in days) return prev;
            return { ...prev, selected_workout_days: { ...days, [todayKey]: true } };
        });
    }, [currentStep]);

    const [customComment, setCustomComment] = useState('');

    // Jan 1 of the birth year. Build the string directly so a UTC conversion
    // can't roll it back to Dec 31 of the previous year for users ahead of UTC.
    const defaultBirthday = `${new Date().getFullYear() - 25}-01-01`;

    const [data, setData] = useState<OnboardingData>({
        name: '',
        birthday: defaultBirthday,
        gender: '',
        goal: '',
        workout_days_per_week: 0,
        selected_workout_days: {},
        workout_split_type: '',
        location: 'gym',
        // Matches the Gym preselect (full set) — location defaults to gym, so the
        // chips must start in the same state a fresh Gym tap would produce.
        available_equipment: SUPPORTED_ONBOARDING_EQUIPMENT.map((e) => e.value),
        injuries: '',
        height_cm: 170,
        weight_kg: 70,
        goal_weight_kg: 70,
        pace: 'medium',
        fitness_level: '',
        workout_duration_minutes: 60,
    });

    // Units default from the DEVICE locale (US/Liberia/Myanmar → imperial,
    // everyone else → metric) instead of always assuming the US. Stored values
    // stay metric (height_cm / weight_kg); a restored saved unit still wins.
    const localeIsImperial = React.useMemo(() => {
        try {
            const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
            return /[-_](US|LR|MM)\b/i.test(locale) || locale.toLowerCase() === 'en';
        } catch {
            return true;
        }
    }, []);
    const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>(localeIsImperial ? 'lbs' : 'kg');
    const [heightUnit, setHeightUnit] = useState<'ft' | 'cm'>(localeIsImperial ? 'ft' : 'cm');

    // Multi-select training locations (Home and/or Gym). `data.location` keeps
    // the single DB value ('hybrid' when both) so every downstream consumer is
    // unchanged; equipment presets union when both are on.
    const [selectedLocations, setSelectedLocations] = useState<string[]>(['gym']);
    useEffect(() => {
        // Keep the cards in sync when data.location arrives from a restored
        // snapshot/profile (same values → no feedback loop with toggles).
        setSelectedLocations(dbValueToLocations(data.location));
    }, [data.location]);

    const toggleLocation = (loc: 'home' | 'gym') => {
        const isOn = selectedLocations.includes(loc);
        if (isOn && selectedLocations.length === 1) return; // keep at least one
        const next = isOn
            ? selectedLocations.filter((l) => l !== loc)
            : [...selectedLocations, loc];
        setSelectedLocations(next);
        updateData('location', locationsToDbValue(next));
        // Recompute chips as the union of active presets — the user can still
        // hand-edit them afterwards.
        const preset = [...new Set(next.flatMap((l) => LOCATION_EQUIPMENT_PRESETS[l] ?? []))];
        updateData('available_equipment', preset);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    };

    // Auto-advance for single-select steps: fire nextStep ~300ms after a choice.
    // nextStep is re-created every render, so the timer goes through a ref that always
    // points at the latest closure (otherwise it would validate stale state).
    const nextStepRef = React.useRef<() => Promise<void> | void>(() => {});
    const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearAutoAdvance = () => {
        if (autoAdvanceTimerRef.current) {
            clearTimeout(autoAdvanceTimerRef.current);
            autoAdvanceTimerRef.current = null;
        }
    };
    const selectAndAutoAdvance = (field: keyof OnboardingData, value: any) => {
        updateDataWithHaptic(field, value);
        clearAutoAdvance();
        autoAdvanceTimerRef.current = setTimeout(() => {
            autoAdvanceTimerRef.current = null;
            void nextStepRef.current();
        }, 300);
    };
    useEffect(() => clearAutoAdvance, []);

    useEffect(() => {
        checkAuthStatus();
    }, []);

    useEffect(() => {
        writeFunnelSnapshot('onboarding_questions', {
            route: '/onboarding',
            reason: 'onboarding_questions_screen',
        });
    }, []);

    // =========================================================================
    // Auth check + name resolution + temp data restore.
    // Name fallback collapsed to one path via resolveUserName().
    // After post-onboarding auth, auto-completes if PENDING_COMPLETE_KEY is set.
    // =========================================================================
    const checkAuthStatus = async () => {
        try {
            setCheckingAuth(true);
            const session = await getSession();

            if (!session) {
                setIsAuthenticated(false);
                setNeedsNameEntry(false);
                setCurrentStep(1);
                return;
            }

            setIsAuthenticated(true);
            setShowIntro(false);

            const meta = session.user?.user_metadata as Record<string, string | undefined> | undefined;
            // Pull the core answers too: they decide whether this user may skip
            // straight to the plan section or must answer steps 1–9 first.
            const { data: profileData } = await supabase
                .from('user_profiles')
                .select('name, gender, goal, fitness_level, birthday, height_cm, weight_kg, goal_weight_kg, pace, selected_workout_days')
                .eq('id', session.user.id)
                .single();
            const profileNameFromDb = profileData?.name ?? '';

            const { full: resolvedFullName, first: resolvedFirstName } =
                await resolveUserName(meta, profileNameFromDb);

            // Cache the resolved name so downstream screens don't re-resolve.
            if (resolvedFirstName) {
                await AsyncStorage.multiSet([
                    ['@user_name', resolvedFirstName],
                    ['@user_full_name', resolvedFullName || resolvedFirstName],
                ]);
            }

            // Load temp data from pre-auth onboarding steps
            const tempDataRaw = await AsyncStorage.getItem(TEMP_DATA_KEY);
            let parsedTemp: (Partial<OnboardingData> & { weight_unit?: 'kg' | 'lbs' }) | null = null;
            if (tempDataRaw) {
                try {
                    parsedTemp = JSON.parse(tempDataRaw);
                } catch {
                    parsedTemp = null;
                }
            }
            // Keep weight_unit (display-only) out of the OnboardingData state.
            const savedUnit = parsedTemp?.weight_unit;
            const tempFields: Partial<OnboardingData> | null = parsedTemp
                ? (({ weight_unit: _unit, ...rest }) => rest)(parsedTemp)
                : null;
            if (savedUnit === 'kg' || savedUnit === 'lbs') {
                setWeightUnit(savedUnit);
            }
            // Does this user actually have the "goal + about you" answers (steps
            // 1–9) anywhere? Without this gate, an authenticated user with no
            // saved answers used to jump straight to the plan section and end up
            // with a profile (and plan) built from defaults.
            const tempHasCoreAnswers = Boolean(
                tempFields?.gender &&
                tempFields?.goal &&
                tempFields?.fitness_level &&
                Object.keys(tempFields?.selected_workout_days ?? {}).length > 0,
            );
            const profileDays: string[] = Array.isArray(profileData?.selected_workout_days)
                ? (profileData.selected_workout_days as string[])
                : [];
            const profileHasCoreAnswers = Boolean(
                profileData?.gender &&
                profileData?.goal &&
                profileData?.fitness_level &&
                profileDays.length > 0,
            );

            if (tempFields) {
                setData(prev => ({
                    ...prev,
                    ...tempFields,
                    name: resolvedFullName || tempFields.name || prev.name,
                }));
            } else if (profileHasCoreAnswers && profileData) {
                // Rehydrate from the saved profile so the remaining steps (and
                // the final save) build on their real answers, not defaults.
                setData(prev => ({
                    ...prev,
                    name: resolvedFullName || prev.name,
                    gender: profileData.gender ?? prev.gender,
                    goal: profileData.goal ?? prev.goal,
                    fitness_level: profileData.fitness_level ?? prev.fitness_level,
                    birthday: profileData.birthday ?? prev.birthday,
                    height_cm: profileData.height_cm ?? prev.height_cm,
                    weight_kg: profileData.weight_kg ?? prev.weight_kg,
                    goal_weight_kg: profileData.goal_weight_kg ?? prev.goal_weight_kg,
                    pace: isPaceKey(profileData.pace) ? profileData.pace : prev.pace,
                    selected_workout_days: Object.fromEntries(profileDays.map(d => [d, true])),
                }));
            } else if (resolvedFullName) {
                setData(prev => ({ ...prev, name: resolvedFullName }));
            }

            const canResumeAtPlanSection = tempHasCoreAnswers || profileHasCoreAnswers;
            const resumeStep = canResumeAtPlanSection ? PLAN_SECTION_START : 1;
            postNameResumeStepRef.current = resumeStep;

            const hasNameForFlow = Boolean(resolvedFirstName || tempFields?.name?.trim());

            // If user came back from sign-up after completing all 13 questions,
            // run handleComplete immediately — no need to re-walk steps 8–12.
            // The restored answers are passed explicitly: this closure's
            // handleComplete still sees the INITIAL data state (setData above
            // hasn't committed into it), so relying on state here would save a
            // profile full of defaults.
            const pendingComplete = await AsyncStorage.getItem(PENDING_COMPLETE_KEY);
            if (pendingComplete === '1' && hasNameForFlow && tempFields) {
                await AsyncStorage.removeItem(PENDING_COMPLETE_KEY);
                setCheckingAuth(false);
                void handleComplete(
                    { ...tempFields, name: resolvedFullName || tempFields.name || '' },
                    savedUnit === 'kg' || savedUnit === 'lbs' ? savedUnit : undefined,
                );
                return;
            }

            if (forceNameEntry) {
                if (!hasNameForFlow) {
                    setNeedsNameEntry(true);
                    setCurrentStep(0);
                    return;
                }
                setNeedsNameEntry(false);
                setResumedAtPlanSection(canResumeAtPlanSection);
                setCurrentStep(resumeStep);
                return;
            }

            if (shouldRestartFromStepOne) {
                setNeedsNameEntry(false);
                setShowIntro(false);
                setCurrentStep(1);
                return;
            }
            if (!hasNameForFlow) {
                setNeedsNameEntry(true);
                setCurrentStep(0); // Name entry step
            } else {
                setNeedsNameEntry(false);
                // Resume at the plan section ONLY when their goal/about-you
                // answers actually exist; otherwise they start from step 1.
                setResumedAtPlanSection(canResumeAtPlanSection);
                setCurrentStep(resumeStep);
                // Say the quiet part out loud: their answers were restored, not
                // lost — reinstalling used to FEEL like starting from scratch.
                if (canResumeAtPlanSection && resumeStep === PLAN_SECTION_START) {
                    toast.info('Welcome back', 'Your earlier answers are saved — just the plan questions left.');
                }
            }
        } catch (error) {
            console.error('Error checking auth:', error);
            setIsAuthenticated(false);
            setCurrentStep(1);
        } finally {
            setCheckingAuth(false);
        }
    };

    const updateData = (field: keyof OnboardingData, value: any) => {
        setData(prev => ({ ...prev, [field]: value }));
    };

    const updateDataWithHaptic = (field: keyof OnboardingData, value: any) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        updateData(field, value);
    };

    const calculateAge = (birthday: string): number | null => {
        if (!birthday) return null;
        try {
            const birthDate = new Date(birthday);
            const today = new Date();
            let age = today.getFullYear() - birthDate.getFullYear();
            const m = today.getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
            return age;
        } catch (e) {
            return null;
        }
    };

    useEffect(() => {
        const parsedAge = calculateAge(data.birthday);
        if (parsedAge && parsedAge >= 13 && parsedAge <= 100) {
            setSelectedAge(parsedAge);
        }
    }, [data.birthday]);

    // Pure, side-effect-free validator. Returns an inline error message for the
    // given step, or null when the step is satisfied. This drives BOTH the
    // disabled state of the Next button and the inline hint text — no more
    // blocking Alert.alert popups on every step (smoother, lower drop-off).
    // NOTE: step 4 = days, step 10 = split (days are asked before split so we
    // can validate the split against the chosen day count).
    const stepError = (step: number): string | null => {
        const dayCount = Object.keys(data.selected_workout_days || {}).length;
        switch (step) {
            case 0:
                return data.name?.trim() ? null : 'Enter your name';
            case 1:
                return data.goal ? null : 'Select a goal to continue';
            case 2:
                return data.gender ? null : 'Select an option to continue';
            case 3:
                return data.fitness_level ? null : 'Select your fitness level';
            case 4:
                return dayCount >= 1 ? null : 'Select at least one workout day';
            case 5: {
                const age = calculateAge(data.birthday);
                if (!age || age < 13) return 'You must be at least 13 years old';
                return null;
            }
            case 6:
                return data.height_cm > 0 ? null : 'Select your height';
            case 7:
                return data.weight_kg > 0 ? null : 'Select your current weight';
            case 8: {
                if (!data.goal_weight_kg || data.goal_weight_kg <= 0) return 'Select your goal weight';
                // Goal weight must be coherent with the chosen direction.
                if (data.goal === 'lose' && data.goal_weight_kg >= data.weight_kg) {
                    return 'For weight loss, your goal should be below your current weight';
                }
                if (data.goal === 'gain' && data.goal_weight_kg <= data.weight_kg) {
                    return 'To gain, your goal should be above your current weight';
                }
                return null;
            }
            case 9:
                return isPaceKey(data.pace) ? null : 'Choose a pace';
            case 10: {
                if (!data.workout_split_type) return 'Choose a workout split';
                const split = WORKOUT_SPLITS.find(s => s.key === data.workout_split_type);
                if (split && dayCount > 0 && dayCount < split.minDays) {
                    return `${split.label} needs at least ${split.minDays} training days`;
                }
                return null;
            }
            case 11:
                return data.workout_duration_minutes >= 15 ? null : 'Select a workout duration';
            case 12:
                if (!data.location) return 'Select where you train';
                if (data.available_equipment.length === 0) return 'Select at least one piece of equipment';
                return null;
            default:
                return null;
        }
    };

    /** Silent guard used by nextStep (the Next button is already disabled when invalid). */
    const validateCurrentStep = () => {
        const err = stepError(currentStep);
        if (currentStep === 5) setAgeError(err);
        return err === null;
    };

    const saveTempData = async () => {
        try {
            // Persist EVERY field — the user may complete all 13 questions
            // pre-auth and we need to restore them after sign-up.
            const snapshot = {
                ...data,
                weight_unit: weightUnit,
                injuries: selectedInjuries.length || customComment
                    ? [...selectedInjuries, customComment].filter(Boolean).join(', ')
                    : '',
            };
            await AsyncStorage.setItem(TEMP_DATA_KEY, JSON.stringify(snapshot));
        } catch (e) {
            console.error('Error saving temp data:', e);
        }
    };

    const nextStep = async () => {
        clearAutoAdvance();
        if (!validateCurrentStep()) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            return;
        }

        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

        // Quiz funnel instrumentation: one event per successfully completed
        // step (1–13) so PostHog can show exactly where people drop off.
        posthog.capture('onboarding_step_completed', {
            step: currentStep,
            total_steps: TOTAL_STEPS,
        });

        // Step 0: Name entry for authenticated users without a name
        if (currentStep === 0 && needsNameEntry) {
            if (data.name?.trim()) {
                await AsyncStorage.setItem('@user_name', getFirstName(data.name));
                await AsyncStorage.setItem('@user_full_name', data.name.trim());
            }
            setNeedsNameEntry(false);
            // Resume where checkAuthStatus decided this user belongs: the plan
            // section if their core answers exist, otherwise step 1.
            setResumedAtPlanSection(postNameResumeStepRef.current === PLAN_SECTION_START);
            setCurrentStep(postNameResumeStepRef.current);
            return;
        }

        // Step 4 (training days): end of the "Your goal" section — checkpoint
        // it server-side for signed-in users (see step 9 note below).
        if (currentStep === 4 && isAuthenticated) {
            void (async () => {
                const session = await getSession();
                if (session?.user?.id) {
                    void savePartialOnboardingProfile(session.user.id, data);
                }
            })();
        }

        // Step 7 (current weight): maintain users skip goal weight + pace and go
        // straight to the interstitial; lose/gain users get a directional
        // prefill so the goal-weight wheel never opens on an invalid value.
        if (currentStep === 7) {
            if (data.goal === 'maintain') {
                updateData('goal_weight_kg', data.weight_kg);
                setShowInterstitial(true);
                return;
            }
            if (data.goal === 'lose' && data.goal_weight_kg >= data.weight_kg) {
                updateData('goal_weight_kg', Math.round(data.weight_kg * 0.92 * 10) / 10);
            } else if (data.goal === 'gain' && data.goal_weight_kg <= data.weight_kg) {
                updateData('goal_weight_kg', Math.round(data.weight_kg * 1.08 * 10) / 10);
            }
        }

        // Step 9 (pace): end of "About you" — show the momentum interstitial
        // before the plan section.
        if (currentStep === 9) {
            setShowInterstitial(true);
            // Checkpoint the section server-side for signed-in users so a
            // delete/reinstall never sends them back to question 1.
            if (isAuthenticated) {
                void (async () => {
                    const session = await getSession();
                    if (session?.user?.id) {
                        void savePartialOnboardingProfile(session.user.id, data);
                    }
                })();
            }
            return;
        }

        // Final step — auth gate. Users answer everything before sign-up.
        if (currentStep === TOTAL_STEPS) {
            if (!isAuthenticated) {
                await saveTempData();
                await AsyncStorage.setItem(PENDING_COMPLETE_KEY, '1');
                router.replace('/auth/sign-up');
                return;
            }
            await handleComplete();
            return;
        }

        setCurrentStep(prev => prev + 1);
    };
    nextStepRef.current = nextStep;

    /** Continue from the interstitial into the "Your plan" section. */
    const continueFromInterstitial = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setShowInterstitial(false);
        setCurrentStep(PLAN_SECTION_START);
    };

    const prevStep = () => {
        clearAutoAdvance();
        if (showInterstitial) {
            // Back from the interstitial lands on the step that triggered it.
            setShowInterstitial(false);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            return;
        }
        if (currentStep > 1) {
            if (resumedAtPlanSection && currentStep === PLAN_SECTION_START) {
                toast.info('Cannot go back', 'Complete the remaining questions or sign out to start over.');
                return;
            }
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

            // Back from the plan section skips the steps maintain users never saw.
            if (currentStep === PLAN_SECTION_START && data.goal === 'maintain') {
                setCurrentStep(7);
                return;
            }

            setCurrentStep(prev => prev - 1);
        }
    };

    // =========================================================================
    // handleComplete: unified name recovery (no stuck loops); selected_workout_days
    // is always saved as a string[] array.
    // =========================================================================
    const handleComplete = async (
        overrides?: Partial<OnboardingData>,
        unitOverride?: 'kg' | 'lbs',
    ) => {
        // Restored-from-signup path passes the answers explicitly because this
        // function may run from a closure whose `data` state is still defaults.
        const effective: OnboardingData = { ...data, ...overrides };
        const effectiveUnit = unitOverride ?? weightUnit;
        setLoading(true);
        try {
            const session = await getSession();
            if (!session) {
                toast.error('Please sign in to continue');
                replaceWithSignedOutRoot();
                return;
            }

            const storedFull = await AsyncStorage.getItem('@user_full_name');
            const um = session.user?.user_metadata as Record<string, string | undefined> | undefined;
            const composedMeta = [um?.given_name, um?.family_name].filter(Boolean).join(' ');
            const metaFull = um?.full_name || um?.name;
            const resolvedProfileName =
                (effective.name && effective.name.trim()) ||
                (storedFull && storedFull.trim()) ||
                (composedMeta && composedMeta.trim()) ||
                (metaFull && metaFull.trim()) ||
                '';

            let firstName = getFirstName(resolvedProfileName || effective.name);

            if (!firstName || !firstName.trim()) {
                const savedGreeting = await AsyncStorage.getItem('@user_name');
                if (savedGreeting?.trim()) {
                    firstName = getFirstName(savedGreeting);
                }
            }

            // FIX: If name is STILL missing, redirect to name entry step
            // instead of showing an error alert that creates a stuck loop.
            // This handles Apple Sign-In 2nd+ sign-in gracefully.
            if (!firstName || !firstName.trim()) {
                setCurrentStep(0);
                setNeedsNameEntry(true);
                setLoading(false);
                return;
            }

            const nameForProfile = resolvedProfileName.trim() || firstName;

            // Combine injuries and custom comment. The restored snapshot already
            // contains the joined injuries string; the live flow builds it here.
            const injuriesText = overrides
                ? (effective.injuries ?? '')
                : [...selectedInjuries, customComment].filter(Boolean).join(', ');

            // Always save selected_workout_days as a string[] array
            const selectedDaysArray = Object.keys(effective.selected_workout_days || {});

            const finalData = {
                ...effective,
                name: nameForProfile,
                injuries: injuriesText,
                workout_days_per_week: selectedDaysArray.length,
                selected_workout_days: selectedDaysArray, // Always array format
                fitness_level: effective.fitness_level || 'intermediate',
            };

            const { error } = await saveUserProfile(session.user.id, finalData);
            if (error) {
                console.error('Save error:', error);
                toast.error('Failed to save your information', 'Please try again.');
                return;
            }

            await AsyncStorage.multiRemove([
                '@user_name',
                '@user_full_name',
                '@user_given_name',
                '@user_family_name',
                '@auth_provider',
            ]);

            // Straight to the soft paywall, carrying the outcome (goal weight +
            // projected date at the chosen pace) so the paywall sells the
            // result, not the app.
            const pace: PaceKey = isPaceKey(finalData.pace) ? finalData.pace : 'medium';
            const projection = projectGoal(
                finalData.goal,
                finalData.weight_kg,
                finalData.goal_weight_kg,
                pace,
            );
            await writeFunnelSnapshot('soft_paywall', {
                route: '/onboarding/paywall',
                reason: 'onboarding_questions_completed',
            });
            router.replace({
                pathname: '/onboarding/paywall',
                params: {
                    goal: finalData.goal,
                    goalKg: String(finalData.goal_weight_kg),
                    unit: effectiveUnit,
                    name: firstName,
                    targetDate: projection?.dateLabel ?? '',
                },
            });
        } catch (error) {
            console.error('Complete error:', error);
            toast.error('Something went wrong', 'Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // =========================================================================
    // Progress: unified scale for the full flow (13 steps); 4-step subset for
    // returning users who resumed at the plan section; step 0 = name recovery.
    // =========================================================================
    const getProgressMeta = () => {
        if (checkingAuth) {
            return { percent: 0, currentIndex: 0, totalSteps: 1, subtitle: '' };
        }
        if (currentStep === 0) {
            return { percent: 100, currentIndex: 1, totalSteps: 1, subtitle: 'Almost there' };
        }
        if (resumedAtPlanSection && currentStep >= PLAN_SECTION_START) {
            const totalSteps = TOTAL_STEPS - PLAN_SECTION_START + 1;
            const currentIndex = currentStep - PLAN_SECTION_START + 1;
            const percent = Math.max(0, Math.min(100, (currentIndex / totalSteps) * 100));
            return { percent, currentIndex, totalSteps, subtitle: 'Your plan' };
        }
        const percent = Math.max(0, Math.min(100, (currentStep / TOTAL_STEPS) * 100));
        const subtitle = currentStep <= 4 ? 'Your goal' : currentStep <= 9 ? 'About you' : 'Your plan';
        return { percent, currentIndex: currentStep, totalSteps: TOTAL_STEPS, subtitle };
    };

    const renderStepHeader = (title: string, subtitle?: string) => (
        <View style={styles.stepHeaderContainer}>
            <Text style={styles.stepTitle}>{title}</Text>
            {subtitle && <Text style={styles.stepSubtitle}>{subtitle}</Text>}
        </View>
    );

    // STEP RENDERERS

    const renderStepName = () => (
        <View style={styles.stepContainer}>
            {renderStepHeader("What's your name?", "Just your first name is fine")}
            <View style={styles.inputContainer}>
                <TextInput
                    style={styles.largeInput}
                    value={data.name}
                    onChangeText={(text) => {
                        const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
                        updateData('name', capitalized);
                    }}
                    placeholder="Enter your name"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    autoFocus
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={() => void nextStep()}
                />
            </View>
        </View>
    );

    const renderStepBirthday = () => {
        const updateAge = (age: number) => {
            setSelectedAge(age);
            const year = new Date().getFullYear() - age;
            const dateStr = `${year}-01-01`; // local-safe; avoids UTC roll-back to Dec 31
            updateData('birthday', dateStr);
        };

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("How old are you?", "This lets us tailor your plan safely")}
                <View style={styles.horizontalPickerContainer}>
                    <HorizontalSnapPicker
                        min={13}
                        max={100}
                        initialValue={selectedAge}
                        onValueChange={updateAge}
                    />
                </View>
                {ageError && <Text style={styles.errorText}>{ageError}</Text>}
            </View>
        );
    };

    const renderStepGender = () => (
        <View style={styles.stepContainer}>
            {renderStepHeader("How do you identify?", "This helps us optimize your workout plan")}
            <View style={styles.genderRow}>
                {[
                    { key: 'Male', label: 'Man', icon: 'male' as const },
                    { key: 'Female', label: 'Woman', icon: 'female' as const },
                    { key: 'Other', label: 'Other', icon: 'infinite' as const },
                ].map((option) => {
                    const selected = data.gender === option.key;
                    return (
                        <OnboardingChoiceCard
                            key={option.key}
                            selected={selected}
                            onPress={() => {
                                selectAndAutoAdvance('gender', option.key);
                            }}
                            style={styles.genderCard}
                        >
                            <View style={styles.genderCardInner}>
                                <Ionicons
                                    name={option.icon}
                                    size={30}
                                    color={selected ? '#2E90FA' : 'rgba(255,255,255,0.85)'}
                                />
                                <Text style={[styles.genderLabel, selected && styles.genderLabelSelected]}>
                                    {option.label}
                                </Text>
                            </View>
                        </OnboardingChoiceCard>
                    );
                })}
            </View>
        </View>
    );

    const renderStepHeight = () => {
        const displayCm = data.height_cm || 170;
        const displayIn = Math.round(displayCm / 2.54);
        const formatFtIn = (inches: number) => `${Math.floor(inches / 12)}'${inches % 12}"`;

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("How tall are you?", "Help us personalize your plan")}
                <View style={styles.compactUnitToggle}>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, heightUnit === 'ft' && styles.compactUnitButtonSelected]}
                        onPress={() => { setHeightUnit('ft'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, heightUnit === 'ft' && styles.compactUnitTextSelected]}>ft/in</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, heightUnit === 'cm' && styles.compactUnitButtonSelected]}
                        onPress={() => { setHeightUnit('cm'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, heightUnit === 'cm' && styles.compactUnitTextSelected]}>cm</Text>
                    </TouchableOpacity>
                </View>
                <View style={styles.verticalRulerContainer}>
                    {heightUnit === 'cm' ? (
                        <VerticalRulerPicker
                            key="height-cm"
                            min={100}
                            max={250}
                            initialValue={displayCm}
                            unit="cm"
                            fullScreen
                            onValueChange={(value) => updateData('height_cm', value)}
                        />
                    ) : (
                        <VerticalRulerPicker
                            key="height-ft"
                            min={40} // 3'4"
                            max={98} // 8'2"
                            initialValue={displayIn}
                            unit=""
                            fullScreen
                            majorEvery={12}
                            midEvery={6}
                            formatDisplay={formatFtIn}
                            formatTickLabel={formatFtIn}
                            onValueChange={(inches) => updateData('height_cm', Math.round(inches * 2.54))}
                        />
                    )}
                </View>
            </View>
        );
    };

    const renderStepCurrentWeight = () => {
        const kgToLbs = (kg: number) => Math.round(kg * 2.20462);
        // Keep one decimal of kg precision: rounding to whole kg made the lbs
        // round-trip drift (180 lbs → 82 kg → 181 lbs), so the picker visibly
        // jumped one notch after every selection in lbs mode.
        const lbsToKg = (lbs: number) => Math.round((lbs / 2.20462) * 10) / 10;

        const weights = weightUnit === 'kg'
            ? Array.from({ length: 200 }, (_, i) => 30 + i)
            : Array.from({ length: 440 }, (_, i) => 66 + i);

        const currentWeight = weightUnit === 'kg'
            ? Math.round(data.weight_kg || 70)
            : kgToLbs(data.weight_kg || 70);

        const handleWeightChange = (value: number) => {
            const kgValue = weightUnit === 'kg' ? value : lbsToKg(value);
            updateData('weight_kg', kgValue);
        };

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("What's your current weight?", "Help us personalize your plan")}
                <View style={styles.compactUnitToggle}>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, weightUnit === 'lbs' && styles.compactUnitButtonSelected]}
                        onPress={() => { setWeightUnit('lbs'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, weightUnit === 'lbs' && styles.compactUnitTextSelected]}>lbs</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, weightUnit === 'kg' && styles.compactUnitButtonSelected]}
                        onPress={() => { setWeightUnit('kg'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, weightUnit === 'kg' && styles.compactUnitTextSelected]}>kg</Text>
                    </TouchableOpacity>
                </View>
                <View style={styles.singlePickerContainer}>
                    <HorizontalSnapPicker
                        min={weights[0] ?? 66}
                        max={weights[weights.length - 1] ?? 300}
                        initialValue={currentWeight}
                        onValueChange={handleWeightChange}
                    />
                </View>
            </View>
        );
    };

    const renderStepGoalWeight = () => {
        const kgToLbs = (kg: number) => Math.round(kg * 2.20462);
        // Same 1-decimal kg precision as the current-weight step (see comment there).
        const lbsToKg = (lbs: number) => Math.round((lbs / 2.20462) * 10) / 10;

        const weights = weightUnit === 'kg'
            ? Array.from({ length: 200 }, (_, i) => 30 + i)
            : Array.from({ length: 440 }, (_, i) => 66 + i);

        const goalWeight = weightUnit === 'kg'
            ? Math.round(data.goal_weight_kg || 70)
            : kgToLbs(data.goal_weight_kg || 70);

        const handleWeightChange = (value: number) => {
            const kgValue = weightUnit === 'kg' ? value : lbsToKg(value);
            updateData('goal_weight_kg', kgValue);
        };

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("What's your goal weight?", "We'll help you get there")}
                <View style={styles.compactUnitToggle}>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, weightUnit === 'lbs' && styles.compactUnitButtonSelected]}
                        onPress={() => { setWeightUnit('lbs'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, weightUnit === 'lbs' && styles.compactUnitTextSelected]}>lbs</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.compactUnitButton, weightUnit === 'kg' && styles.compactUnitButtonSelected]}
                        onPress={() => { setWeightUnit('kg'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                        <Text style={[styles.compactUnitText, weightUnit === 'kg' && styles.compactUnitTextSelected]}>kg</Text>
                    </TouchableOpacity>
                </View>
                <View style={styles.singlePickerContainer}>
                    <HorizontalSnapPicker
                        min={weights[0] ?? 66}
                        max={weights[weights.length - 1] ?? 300}
                        initialValue={goalWeight}
                        onValueChange={handleWeightChange}
                    />
                </View>
            </View>
        );
    };

    const renderStepPace = () => {
        const paceOptions: Array<{ key: PaceKey; label: string; subtitle: string }> = [
            { key: 'slow', label: 'Steady', subtitle: 'Gentler on your routine — easiest to sustain' },
            { key: 'medium', label: 'Recommended', subtitle: 'The sweet spot for lasting results' },
            { key: 'fast', label: 'Ambitious', subtitle: 'Faster results — needs real consistency' },
        ];
        const selectedPace: PaceKey = isPaceKey(data.pace) ? data.pace : 'medium';
        const projection = projectGoal(data.goal, data.weight_kg, data.goal_weight_kg, selectedPace);
        const goalDisplay = weightUnit === 'kg'
            ? Math.round(data.goal_weight_kg)
            : Math.round(data.goal_weight_kg * 2.20462);
        const verb = data.goal === 'gain' ? 'reach' : 'hit';

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader(
                    "How fast do you want to get there?",
                    "Rates are capped at safe, sustainable limits",
                )}
                <View style={styles.optionsList}>
                    {paceOptions.map((opt) => {
                        const selected = selectedPace === opt.key;
                        const rateKg = weeklyRateKg(data.goal, opt.key, data.weight_kg);
                        return (
                            <OnboardingListChoiceRow
                                key={opt.key}
                                selected={selected}
                                onPress={() => {
                                    updateDataWithHaptic('pace', opt.key);
                                }}
                                title={`${opt.label} · ${formatWeeklyRate(rateKg, weightUnit)}`}
                                subtitle={opt.subtitle}
                            />
                        );
                    })}
                </View>
                {projection && (
                    <View style={styles.scheduleNoteCard}>
                        <Ionicons
                            name="flag-outline"
                            size={18}
                            color="rgba(46, 144, 250, 0.85)"
                            style={styles.scheduleNoteIcon}
                        />
                        <Text style={styles.scheduleNoteText}>
                            At this pace you’ll {verb} {goalDisplay} {weightUnit} by{' '}
                            <Text style={styles.scheduleNoteEmphasis}>{projection.dateLabel}</Text>
                            {' '}({projection.weeks} weeks).
                        </Text>
                    </View>
                )}
            </View>
        );
    };

    const renderStepGoal = () => (
        <View style={styles.stepContainer}>
            {renderStepHeader("What's your goal?", "Choose your primary fitness objective")}
            <View style={styles.optionsList}>
                {[
                    { key: 'lose', label: 'Lose Weight', subtitle: 'Burn fat and get lean', icon: 'trending-down' as const },
                    { key: 'maintain', label: 'Maintain', subtitle: 'Stay in shape', icon: 'pause' as const },
                    { key: 'gain', label: 'Gain Muscle', subtitle: 'Build mass and strength', icon: 'trending-up' as const },
                ].map((goal) => {
                    const selected = data.goal === goal.key;
                    return (
                        <OnboardingListChoiceRow
                            key={goal.key}
                            selected={selected}
                            onPress={() => {
                                selectAndAutoAdvance('goal', goal.key);
                            }}
                            title={goal.label}
                            subtitle={goal.subtitle}
                            leading={
                                <Ionicons
                                    name={goal.icon}
                                    size={24}
                                    color={selected ? '#2E90FA' : 'rgba(255,255,255,0.75)'}
                                />
                            }
                        />
                    );
                })}
            </View>
        </View>
    );

    const renderStepFitnessLevel = () => (
        <View style={styles.stepContainer}>
            {renderStepHeader("What's your fitness level?", "Help us match the right workout intensity")}
            <View style={styles.optionsList}>
                {[
                    { key: 'beginner', label: 'Beginner', subtitle: 'New to working out or getting back into it', icon: 'leaf' as const },
                    { key: 'intermediate', label: 'Intermediate', subtitle: 'Comfortable with gym basics', icon: 'fitness' as const },
                    { key: 'expert', label: 'Advanced', subtitle: 'Experienced with training programs', icon: 'trophy' as const },
                ].map((level) => {
                    const selected = data.fitness_level === level.key;
                    return (
                        <OnboardingListChoiceRow
                            key={level.key}
                            selected={selected}
                            onPress={() => {
                                selectAndAutoAdvance('fitness_level', level.key);
                            }}
                            title={level.label}
                            subtitle={level.subtitle}
                            leading={
                                <Ionicons
                                    name={level.icon}
                                    size={24}
                                    color={selected ? '#2E90FA' : 'rgba(255,255,255,0.75)'}
                                />
                            }
                        />
                    );
                })}
            </View>
        </View>
    );

    const renderStepSchedule = () => {
        const selectedDays = data.selected_workout_days || {};
        const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        // Today is always a training day and can't be unselected — a brand-new
        // user must never land on a Rest Day as their first home screen.
        // They can edit days later.
        const todayKey = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader(
                    "Which days work best?",
                    data.goal
                        ? `Let's schedule your ${goalNoun(data.goal)} plan — pick your training days`
                        : "Select the days you can workout",
                )}
                <View style={styles.daysGrid}>
                    {DAYS_OF_WEEK.map((day, index) => {
                        const isToday = day === todayKey;
                        const isSelected = isToday || day in selectedDays;
                        return (
                            <OnboardingChoiceCard
                                key={day}
                                selected={isSelected}
                                style={styles.dayCard}
                                onPress={() => {
                                    if (isToday) {
                                        // Locked: first workout happens today.
                                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                        toast.info(
                                            'Today stays on',
                                            'Your first workout starts today — you can change your days anytime later.'
                                        );
                                        return;
                                    }
                                    const newDays = { ...selectedDays };
                                    if (day in newDays) {
                                        delete newDays[day];
                                    } else {
                                        newDays[day] = true;
                                    }
                                    updateData('selected_workout_days', newDays);
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                }}
                            >
                                <Text style={[styles.dayText, isSelected && styles.dayTextSelected]}>
                                    {dayLabels[index]}
                                </Text>
                                {isToday && (
                                    <Text style={[styles.dayTodayTag, isSelected && styles.dayTextSelected]}>
                                        today
                                    </Text>
                                )}
                            </OnboardingChoiceCard>
                        );
                    })}
                </View>
                <View style={styles.scheduleNoteCard}>
                    <Ionicons
                        name="information-circle-outline"
                        size={18}
                        color="rgba(46, 144, 250, 0.85)"
                        style={styles.scheduleNoteIcon}
                    />
                    <Text style={styles.scheduleNoteText}>
                        Today is included so your plan starts right away — you can always change your days later.
                    </Text>
                </View>
            </View>
        );
    };

    const renderStepSplit = () => {
        const dayCount = Object.keys(data.selected_workout_days || {}).length;
        const recommended = recommendedSplitForDays(dayCount);

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader(
                    "What workout split?",
                    dayCount > 0
                        ? `Based on your ${dayCount} day${dayCount === 1 ? '' : 's'} per week`
                        : "Choose how you want to organize your workouts",
                )}
                <TouchableOpacity
                    style={styles.recommendChip}
                    onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        updateData('workout_split_type', recommended.key);
                        // Through the ref: the fresh closure sees the split we just set.
                        setTimeout(() => { void nextStepRef.current(); }, 60);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Use recommended split"
                >
                    <Ionicons name="sparkles" size={15} color="#2E90FA" style={styles.recommendChipIcon} />
                    <Text style={styles.recommendChipText}>Use recommended ({recommended.label})</Text>
                </TouchableOpacity>
                <View style={styles.optionsList}>
                    {WORKOUT_SPLITS.map((split) => {
                        const selected = data.workout_split_type === split.key;
                        // A split that needs more days than the user picked can't be
                        // chosen — show it dimmed with the reason instead of allowing
                        // an incoherent plan (e.g. Bro Split on 2 days).
                        const unfit = dayCount > 0 && dayCount < split.minDays;
                        return (
                            <OnboardingListChoiceRow
                                key={split.key}
                                selected={selected}
                                disabled={unfit}
                                disabledHint={`Needs at least ${split.minDays} training days`}
                                onPress={() => {
                                    updateDataWithHaptic('workout_split_type', split.key);
                                }}
                                title={split.label}
                                subtitle={split.subtitle}
                            />
                        );
                    })}
                </View>
            </View>
        );
    };

    const renderStepDuration = () => {
        const durations = [
            { value: 30, label: '30 min', subtitle: 'Quick & efficient' },
            { value: 45, label: '45 min', subtitle: 'Balanced workout' },
            { value: 60, label: '60 min', subtitle: 'Standard session' },
            { value: 90, label: '90 min', subtitle: 'Extended training' },
        ];
        const RECOMMENDED_DURATION = 60;

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("How long can you workout?", "Choose your typical workout duration")}
                <TouchableOpacity
                    style={styles.recommendChip}
                    onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        updateData('workout_duration_minutes', RECOMMENDED_DURATION);
                        // Through the ref: the fresh closure sees the duration we just set.
                        setTimeout(() => { void nextStepRef.current(); }, 60);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Use recommended duration"
                >
                    <Ionicons name="sparkles" size={15} color="#2E90FA" style={styles.recommendChipIcon} />
                    <Text style={styles.recommendChipText}>Use recommended (60 min)</Text>
                </TouchableOpacity>
                <View style={styles.optionsList}>
                    {durations.map((duration) => {
                        const selected = data.workout_duration_minutes === duration.value;
                        return (
                            <OnboardingListChoiceRow
                                key={duration.value}
                                selected={selected}
                                onPress={() => {
                                    updateDataWithHaptic('workout_duration_minutes', duration.value);
                                }}
                                title={duration.label}
                                subtitle={duration.subtitle}
                            />
                        );
                    })}
                </View>
            </View>
        );
    };

    const renderStepEquipment = () => {
        const isHome = selectedLocations.includes('home');
        const isGym = selectedLocations.includes('gym');
        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("Where do you train?", "Pick one or both — your plan only uses gear you actually have")}
                <View style={styles.locationToggle}>
                    <OnboardingChoiceCard
                        selected={isHome}
                        style={styles.locationCard}
                        onPress={() => toggleLocation('home')}
                    >
                        <View style={styles.locationCardInner}>
                            <Ionicons
                                name="home"
                                size={24}
                                color={isHome ? '#2E90FA' : 'rgba(255,255,255,0.85)'}
                            />
                            <Text
                                style={[
                                    styles.locationCardLabel,
                                    isHome && styles.locationCardLabelSelected,
                                ]}
                            >
                                Home
                            </Text>
                        </View>
                    </OnboardingChoiceCard>
                    <OnboardingChoiceCard
                        selected={isGym}
                        style={styles.locationCard}
                        onPress={() => toggleLocation('gym')}
                    >
                        <View style={styles.locationCardInner}>
                            <Ionicons
                                name="barbell"
                                size={24}
                                color={isGym ? '#2E90FA' : 'rgba(255,255,255,0.85)'}
                            />
                            <Text
                                style={[
                                    styles.locationCardLabel,
                                    isGym && styles.locationCardLabelSelected,
                                ]}
                            >
                                Gym
                            </Text>
                        </View>
                    </OnboardingChoiceCard>
                </View>
                {isHome && isGym ? (
                    <Text style={styles.locationHybridHint}>
                        Hybrid it is — we'll keep home days doable with your home gear.
                    </Text>
                ) : null}

                {!!data.location && (
                    <>
                        <Text style={styles.equipmentSectionLabel}>What equipment do you have?</Text>
                        <View style={styles.equipmentGrid}>
                            {SUPPORTED_ONBOARDING_EQUIPMENT.map((item) => {
                                const isOn = data.available_equipment.includes(item.value);
                                return (
                                    <OnboardingChoiceCard
                                        key={item.value}
                                        selected={isOn}
                                        style={styles.equipmentChipCard}
                                        onPress={() => {
                                            const newEquipment = isOn
                                                ? data.available_equipment.filter(e => e !== item.value)
                                                : [...data.available_equipment, item.value];
                                            updateData('available_equipment', newEquipment);
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                        }}
                                    >
                                        <Text style={[styles.equipmentChipText, isOn && styles.equipmentChipTextSelected]}>
                                            {item.label}
                                        </Text>
                                    </OnboardingChoiceCard>
                                );
                            })}
                        </View>
                    </>
                )}
            </View>
        );
    };

    const renderStepInjuries = () => {
        const commonInjuries = ['Knees', 'Shoulders', 'Lower Back', 'Wrists', 'Elbows', 'Ankles'];

        return (
            <View style={styles.stepContainer}>
                {renderStepHeader("Any injuries or concerns?", "Select all that apply (optional)")}
                <View style={styles.injuriesGrid}>
                    {commonInjuries.map((injury) => {
                        const isOn = selectedInjuries.includes(injury);
                        return (
                            <OnboardingChoiceCard
                                key={injury}
                                selected={isOn}
                                style={styles.equipmentChipCard}
                                onPress={() => {
                                    const newInjuries = isOn
                                        ? selectedInjuries.filter(i => i !== injury)
                                        : [...selectedInjuries, injury];
                                    setSelectedInjuries(newInjuries);
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                }}
                            >
                                <Text style={[styles.equipmentChipText, isOn && styles.equipmentChipTextSelected]}>
                                    {injury}
                                </Text>
                            </OnboardingChoiceCard>
                        );
                    })}
                </View>
                <View style={styles.commentSection}>
                    <Text style={styles.commentLabel}>Additional notes (optional)</Text>
                    <TextInput
                        style={styles.commentInput}
                        value={customComment}
                        onChangeText={setCustomComment}
                        placeholder="Any other concerns or preferences?"
                        placeholderTextColor="rgba(255,255,255,0.35)"
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                    />
                </View>
            </View>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 0: return renderStepName();
            case 1: return renderStepGoal();
            case 2: return renderStepGender();
            case 3: return renderStepFitnessLevel();
            case 4: return renderStepSchedule();
            case 5: return renderStepBirthday();
            case 6: return renderStepHeight();
            case 7: return renderStepCurrentWeight();
            case 8: return renderStepGoalWeight();
            case 9: return renderStepPace();
            case 10: return renderStepSplit();
            case 11: return renderStepDuration();
            case 12: return renderStepEquipment();
            case 13: return renderStepInjuries();
            default: return null;
        }
    };

    const progressMeta = getProgressMeta();
    const currentError = checkingAuth ? null : stepError(currentStep);
    // Show the inline error only where it's explanatory rather than nagging:
    // the age/goal-weight wheels (a value is always present but may be invalid),
    // and a previously-selected split that no longer fits the chosen days.
    const showInlineError =
        !!currentError &&
        (currentStep === 5 ||
            currentStep === 8 ||
            (currentStep === 10 && !!data.workout_split_type));

    if (!checkingAuth && showIntro && !isAuthenticated) {
        return (
            <View style={styles.container}>
                <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
                    <View style={styles.introTopBar}>
                        <TouchableOpacity
                            style={styles.introBackButton}
                            onPress={() => {
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                if (router.canGoBack()) {
                                    router.back();
                                } else {
                                    router.replace('/auth/welcome');
                                }
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                            hitSlop={10}
                        >
                            <Ionicons
                                name="chevron-back"
                                size={22}
                                color="rgba(255,255,255,0.85)"
                            />
                        </TouchableOpacity>
                    </View>
                    <View style={styles.introContainer}>
                        <View style={styles.introTextBlock}>
                            <Text style={styles.introHeading}>
                                Let’s build a training plan made for your body and goals
                            </Text>
                            <Text style={styles.introSubheading}>
                                Answer a few quick questions and we’ll design a plan around your goal, schedule, and equipment.
                            </Text>
                        </View>
                        <View style={styles.introImageWrap}>
                            <Image
                                source={require('../../img/workout-intro.png')}
                                style={styles.introImage}
                                resizeMode="contain"
                            />
                        </View>
                        <View style={styles.introButtonWrap}>
                            <TouchableOpacity
                                style={styles.nextButton}
                                onPress={() => {
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                    setShowIntro(false);
                                }}
                                activeOpacity={0.88}
                            >
                                <Text style={styles.nextButtonText}>Great! Let’s go!</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </SafeAreaView>
            </View>
        );
    }

    // ------------------------------------------------------------------
    // Momentum interstitial between "About you" and "Your plan": a
    // qualitative LiftAI-vs-generic trajectory chart (no invented stats)
    // that mirrors the user's own answers back before the final stretch.
    // ------------------------------------------------------------------
    if (showInterstitial) {
        const dayCount = Object.keys(data.selected_workout_days || {}).length;
        const chartW = Math.min(Dimensions.get('window').width - 96, 360);
        const chartH = 160;
        const interPace: PaceKey = isPaceKey(data.pace) ? data.pace : 'medium';
        const interProjection = projectGoal(data.goal, data.weight_kg, data.goal_weight_kg, interPace);
        const liftLine = `M 0 ${chartH * 0.82} C ${chartW * 0.35} ${chartH * 0.74}, ${chartW * 0.55} ${chartH * 0.38}, ${chartW} ${chartH * 0.1}`;
        const liftArea = `${liftLine} L ${chartW} ${chartH} L 0 ${chartH} Z`;
        const genericLine = `M 0 ${chartH * 0.82} C ${chartW * 0.25} ${chartH * 0.62}, ${chartW * 0.45} ${chartH * 0.58}, ${chartW} ${chartH * 0.56}`;
        const levelLabel =
            data.fitness_level === 'beginner' ? 'Beginner' :
            data.fitness_level === 'expert' ? 'Advanced' : 'Intermediate';

        return (
            <View style={styles.container}>
                <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
                    <View style={styles.introTopBar}>
                        <TouchableOpacity
                            style={styles.introBackButton}
                            onPress={prevStep}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                            hitSlop={10}
                        >
                            <Ionicons name="chevron-back" size={22} color="rgba(255,255,255,0.85)" />
                        </TouchableOpacity>
                    </View>
                    <ScrollView
                        contentContainerStyle={styles.interstitialContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <View style={styles.interstitialBadge}>
                            <Ionicons name="sparkles" size={14} color="#2E90FA" />
                            <Text style={styles.interstitialBadgeText}>Almost there</Text>
                        </View>
                        <Text style={styles.interstitialHeadline}>
                            Your {goalNoun(data.goal)} plan is taking shape
                        </Text>
                        <Text style={styles.interstitialSub}>
                            A plan built around your schedule and equipment is far easier to
                            stick to than a generic program. Here’s the difference over time:
                        </Text>
                        <View style={styles.interstitialChartCard}>
                            <Svg width={chartW} height={chartH}>
                                <Defs>
                                    <SvgLinearGradient id="interGrad" x1="0" y1="0" x2="0" y2="1">
                                        <Stop offset="0" stopColor="#2E90FA" stopOpacity={0.3} />
                                        <Stop offset="1" stopColor="#2E90FA" stopOpacity={0} />
                                    </SvgLinearGradient>
                                </Defs>
                                <Path d={liftArea} fill="url(#interGrad)" />
                                <Path d={liftLine} stroke="#2E90FA" strokeWidth={3} fill="none" strokeLinecap="round" />
                                <Path
                                    d={genericLine}
                                    stroke="rgba(255,255,255,0.35)"
                                    strokeWidth={2.5}
                                    strokeDasharray="6 6"
                                    fill="none"
                                    strokeLinecap="round"
                                />
                            </Svg>
                            <View style={styles.interstitialLegend}>
                                <View style={styles.interstitialLegendItem}>
                                    <View style={[styles.interstitialLegendDot, { backgroundColor: '#2E90FA' }]} />
                                    <Text style={styles.interstitialLegendText}>Your LiftAI plan</Text>
                                </View>
                                <View style={styles.interstitialLegendItem}>
                                    <View style={[styles.interstitialLegendDot, { backgroundColor: 'rgba(255,255,255,0.35)' }]} />
                                    <Text style={styles.interstitialLegendText}>Generic plan</Text>
                                </View>
                            </View>
                        </View>
                        <View style={styles.interstitialRecapRow}>
                            <View style={styles.interstitialRecapChip}>
                                <Text style={styles.interstitialRecapText}>
                                    {dayCount} day{dayCount === 1 ? '' : 's'}/week
                                </Text>
                            </View>
                            <View style={styles.interstitialRecapChip}>
                                <Text style={styles.interstitialRecapText}>{levelLabel}</Text>
                            </View>
                            <View style={styles.interstitialRecapChip}>
                                <Text style={styles.interstitialRecapText}>
                                    {interProjection ? `Goal by ${interProjection.dateLabel}` : 'Strength focus'}
                                </Text>
                            </View>
                        </View>
                    </ScrollView>
                    <View style={styles.introButtonWrap}>
                        <TouchableOpacity
                            style={styles.nextButton}
                            onPress={continueFromInterstitial}
                            activeOpacity={0.88}
                        >
                            <Text style={styles.nextButtonText}>Build my plan</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <SafeAreaView style={styles.safeArea} edges={['top']}>
                {!checkingAuth && (
                    <OnboardingProgressHeader
                        progressPercent={progressMeta.percent}
                        currentIndex={progressMeta.currentIndex}
                        totalSteps={progressMeta.totalSteps}
                        subtitle={progressMeta.subtitle}
                    />
                )}

                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.keyboardView}
                    keyboardVerticalOffset={
                        Platform.OS === 'ios' ? Math.max(insets.top, 12) + 6 : 0
                    }
                >
                    {/*
                      FlatList pickers must not be under ScrollView — RN warns even
                      when scrollEnabled={false}. Use a plain View on wheel steps only.
                    */}
                    {!checkingAuth && STEPS_WITH_SNAPPING_WHEEL.has(currentStep) ? (
                        <View style={[styles.scrollFlex, styles.contentContainer]}>
                            <Animated.View
                                key={currentStep}
                                entering={FadeInDown.duration(420)
                                    .springify()
                                    .damping(22)
                                    .stiffness(200)}
                                style={styles.animatedStep}
                            >
                                {renderStepContent()}
                            </Animated.View>
                        </View>
                    ) : (
                        <ScrollView
                            style={styles.scrollFlex}
                            contentContainerStyle={styles.contentContainer}
                            showsVerticalScrollIndicator={false}
                            keyboardShouldPersistTaps="handled"
                        >
                            {checkingAuth ? (
                                <View style={styles.loadingContainer}>
                                    <ActivityIndicator size="large" color="#2E90FA" />
                                </View>
                            ) : (
                                <Animated.View
                                    key={currentStep}
                                    entering={FadeInDown.duration(420)
                                        .springify()
                                        .damping(22)
                                        .stiffness(200)}
                                    style={styles.animatedStep}
                                >
                                    {renderStepContent()}
                                </Animated.View>
                            )}
                        </ScrollView>
                    )}

                    {!checkingAuth && showInlineError && (
                        <Text style={styles.inlineFooterError}>{currentError}</Text>
                    )}
                    <View
                        style={[
                            styles.footerNav,
                            { paddingBottom: Math.max(insets.bottom, 14) + 6 },
                        ]}
                    >
                        {currentStep > 1 && !(resumedAtPlanSection && currentStep === PLAN_SECTION_START) ? (
                            <TouchableOpacity
                                style={styles.backButtonInline}
                                onPress={prevStep}
                                accessibilityRole="button"
                                accessibilityLabel="Back"
                            >
                                <Ionicons
                                    name="chevron-back"
                                    size={22}
                                    color="rgba(255,255,255,0.65)"
                                />
                            </TouchableOpacity>
                        ) : (
                            <View style={styles.backButtonPlaceholder} />
                        )}

                        <View style={styles.nextButtonWrap}>
                            <TouchableOpacity
                                style={[styles.nextButton, (loading || !!currentError) && styles.nextButtonDisabled]}
                                onPress={() => void nextStep()}
                                disabled={loading || !!currentError}
                                activeOpacity={0.88}
                            >
                                {loading ? (
                                    <ActivityIndicator color="#121212" />
                                ) : (
                                    <Text style={styles.nextButtonText}>
                                        {currentStep === TOTAL_STEPS
                                            ? (isAuthenticated ? 'Finish' : 'Save your plan')
                                            : 'Next'}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        </View>

                        <View style={styles.backButtonPlaceholder} />
                    </View>
                </KeyboardAvoidingView>
            </SafeAreaView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000000' },
    safeArea: { flex: 1 },
    keyboardView: { flex: 1 },
    scrollFlex: { flex: 1 },
    animatedStep: { flex: 1 },
    contentContainer: {
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingTop: 8,
        paddingBottom: 28,
    },
    loadingContainer: {
        flex: 1,
        minHeight: 280,
        justifyContent: 'center',
        alignItems: 'center',
    },
    stepContainer: { flex: 1, paddingBottom: 8 },
    stepHeaderContainer: { marginBottom: 28 },
    stepTitle: {
        fontSize: 30,
        lineHeight: 38,
        color: '#FFFFFF',
        fontFamily: 'Montserrat_700Bold',
        marginBottom: 12,
        letterSpacing: -0.3,
    },
    stepSubtitle: {
        fontSize: 16,
        lineHeight: 24,
        color: 'rgba(255,255,255,0.55)',
        fontFamily: 'Montserrat_400Regular',
    },
    inputContainer: { marginTop: 12 },
    largeInput: {
        fontSize: 26,
        color: '#FFF',
        fontFamily: 'Montserrat_600SemiBold',
        paddingVertical: 20,
        paddingHorizontal: 20,
        borderRadius: 20,
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    errorText: {
        color: '#EF4444',
        textAlign: 'center',
        marginTop: 16,
        fontSize: 14,
        fontFamily: 'Montserrat_500Medium',
    },
    inlineFooterError: {
        color: '#EF4444',
        textAlign: 'center',
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: 24,
        paddingBottom: 8,
        fontFamily: 'Montserrat_500Medium',
    },
    genderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 12,
    },
    genderCard: {
        flex: 1,
        minHeight: 108,
        paddingVertical: 16,
        paddingHorizontal: 8,
        justifyContent: 'center',
    },
    genderCardInner: { alignItems: 'center', justifyContent: 'center', gap: 12 },
    genderLabel: {
        color: 'rgba(255,255,255,0.88)',
        fontSize: 14,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
    genderLabelSelected: { color: '#FFFFFF' },
    optionsList: { gap: 12, marginTop: 12 },
    recommendChip: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 999,
        backgroundColor: 'rgba(46, 144, 250, 0.12)',
        borderWidth: 1,
        borderColor: 'rgba(46, 144, 250, 0.4)',
        marginTop: 4,
        marginBottom: 4,
    },
    recommendChipIcon: { marginRight: 6 },
    recommendChipText: {
        color: '#2E90FA',
        fontSize: 13,
        fontFamily: 'Montserrat_600SemiBold',
    },
    daysGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 12,
        marginTop: 12,
    },
    dayCard: {
        width: 56,
        height: 56,
        borderRadius: 999,
        paddingVertical: 0,
        paddingHorizontal: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },
    dayText: {
        color: 'rgba(255,255,255,0.88)',
        fontSize: 14,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
    dayTextSelected: { color: '#FFFFFF' },
    dayTodayTag: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 8.5,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginTop: 1,
    },
    scheduleNoteCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        marginTop: 20,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 16,
        backgroundColor: 'rgba(46, 144, 250, 0.10)',
        borderWidth: 1,
        borderColor: 'rgba(46, 144, 250, 0.35)',
    },
    scheduleNoteIcon: {
        marginTop: 2,
    },
    scheduleNoteText: {
        flex: 1,
        color: 'rgba(255,255,255,0.85)',
        fontSize: 13,
        lineHeight: 18,
        fontFamily: 'Montserrat_500Medium',
    },
    scheduleNoteEmphasis: {
        color: '#2E90FA',
        fontFamily: 'Montserrat_700Bold',
    },
    interstitialContent: {
        flexGrow: 1,
        paddingHorizontal: 28,
        paddingTop: 12,
        paddingBottom: 16,
    },
    interstitialBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: 'rgba(46,144,250,0.12)',
        borderWidth: 1,
        borderColor: 'rgba(46,144,250,0.4)',
        marginBottom: 16,
    },
    interstitialBadgeText: {
        color: '#2E90FA',
        fontSize: 13,
        fontFamily: 'Montserrat_600SemiBold',
    },
    interstitialHeadline: {
        fontSize: 27,
        lineHeight: 35,
        color: '#FFFFFF',
        fontFamily: 'Montserrat_700Bold',
        letterSpacing: -0.3,
        marginBottom: 12,
    },
    interstitialSub: {
        fontSize: 15,
        lineHeight: 22,
        color: 'rgba(255,255,255,0.6)',
        fontFamily: 'Montserrat_400Regular',
        marginBottom: 24,
    },
    interstitialChartCard: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        paddingTop: 20,
        paddingBottom: 16,
        paddingHorizontal: 16,
        alignItems: 'center',
        marginBottom: 20,
    },
    interstitialLegend: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 20,
        marginTop: 12,
    },
    interstitialLegendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    interstitialLegendDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    interstitialLegendText: {
        color: 'rgba(255,255,255,0.65)',
        fontSize: 12,
        fontFamily: 'Montserrat_500Medium',
    },
    interstitialRecapRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        justifyContent: 'center',
    },
    interstitialRecapChip: {
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
    },
    interstitialRecapText: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 13,
        fontFamily: 'Montserrat_600SemiBold',
    },
    locationToggle: { flexDirection: 'row', gap: 12, marginTop: 12, marginBottom: 16 },
    locationCard: { flex: 1, paddingVertical: 20, paddingHorizontal: 12 },
    locationCardInner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
    },
    locationCardLabel: {
        color: 'rgba(255,255,255,0.88)',
        fontSize: 16,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
    locationCardLabelSelected: { color: '#FFFFFF' },
    equipmentGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        justifyContent: 'center',
    },
    equipmentChipCard: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 24,
        marginBottom: 2,
    },
    equipmentChipText: {
        color: 'rgba(255,255,255,0.88)',
        fontSize: 14,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
        textAlign: 'center',
    },
    equipmentChipTextSelected: { color: '#FFFFFF' },
    injuriesGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        justifyContent: 'center',
        marginTop: 12,
        marginBottom: 24,
    },
    commentSection: { marginTop: 4 },
    commentLabel: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
        marginBottom: 12,
        fontFamily: 'Montserrat_500Medium',
    },
    commentInput: {
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: 20,
        padding: 16,
        color: '#FFF',
        fontSize: 16,
        minHeight: 100,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        fontFamily: 'Montserrat_400Regular',
    },
    // Full-width segmented control: the unit choice is a first-class decision
    // (testers reported the old pill pair read as decoration and got missed).
    compactUnitToggle: {
        flexDirection: 'row',
        gap: 0,
        marginTop: 12,
        marginBottom: 16,
        alignSelf: 'stretch',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        padding: 4,
    },
    compactUnitButton: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactUnitButtonSelected: {
        backgroundColor: 'rgba(46, 144, 250, 0.25)',
        borderWidth: 1,
        borderColor: 'rgba(46, 144, 250, 0.85)',
    },
    compactUnitText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 16,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
    },
    compactUnitTextSelected: { color: '#FFFFFF' },
    locationHybridHint: {
        color: 'rgba(46, 144, 250, 0.95)',
        fontSize: 13,
        fontFamily: 'Montserrat_500Medium',
        textAlign: 'center',
        marginTop: 10,
    },
    equipmentSectionLabel: {
        color: 'rgba(255,255,255,0.9)',
        fontSize: 16,
        fontWeight: '600',
        fontFamily: 'Montserrat_600SemiBold',
        marginTop: 20,
        marginBottom: 4,
        alignSelf: 'flex-start',
    },
    singlePickerContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 160,
        marginTop: 8,
        width: '100%',
    },
    horizontalPickerContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 140,
        marginTop: 20,
    },
    verticalRulerContainer: {
        marginTop: 0,
        flex: 1,
        justifyContent: 'center',
        minHeight: 260,
    },
    footerNav: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: 'rgba(255,255,255,0.08)',
        backgroundColor: '#000000',
    },
    backButtonInline: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(255,255,255,0.08)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    backButtonPlaceholder: { width: 48, height: 48 },
    nextButtonWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    nextButton: {
        minWidth: 168,
        paddingVertical: 16,
        paddingHorizontal: 36,
        backgroundColor: '#FFFFFF',
        borderRadius: 999,
        alignItems: 'center',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
        elevation: 6,
    },
    nextButtonDisabled: { opacity: 0.55 },
    nextButtonText: {
        color: '#0D0D0D',
        fontSize: 17,
        fontWeight: '700',
        fontFamily: 'Montserrat_700Bold',
    },
    introTopBar: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 4,
    },
    introBackButton: {
        width: 44,
        height: 44,
        borderRadius: 24,
        backgroundColor: 'rgba(255,255,255,0.08)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    introContainer: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 24,
        paddingBottom: 24,
        justifyContent: 'space-between',
    },
    introTextBlock: {
        alignItems: 'center',
        marginTop: 12,
    },
    introHeading: {
        fontSize: 28,
        lineHeight: 36,
        color: '#FFFFFF',
        fontFamily: 'Montserrat_700Bold',
        textAlign: 'center',
        letterSpacing: -0.3,
        marginBottom: 16,
    },
    introSubheading: {
        fontSize: 13,
        lineHeight: 19,
        color: 'rgba(255,255,255,0.55)',
        fontFamily: 'Montserrat_400Regular',
        textAlign: 'center',
    },
    introImageWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginVertical: 24,
    },
    introImage: {
        width: '100%',
        height: '100%',
        maxHeight: 360,
    },
    introButtonWrap: {
        alignItems: 'center',
        marginBottom: 8,
    },
});
