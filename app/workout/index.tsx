// app/workout/index.tsx
/**
 * Workout Execution Screen
 *
 * Route: /workout
 * Function: TikTok-style vertical scrolling workout interface
 *
 * Features:
 * - Displays exercises in vertical scroll format
 * - Tracks workout progress with set completion
 * - Real-time rest timers
 * - Performance logging to Supabase
 * - Error boundary protection (no white screens)
 */

import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect } from 'react';

import ExerciseTikTokScroll from '../../components/ExerciseTikTokScroll';
import { WorkoutErrorBoundary } from '../../components/WorkoutErrorBoundary';
import { captureException } from '../../src/config/sentry';
import { posthog } from '../../src/config/posthog';
import { ExerciseCard } from '../../types/workoutPayload';
import { performGuardedWorkoutExit } from '../../utils/workoutExit';

export default function WorkoutScreen() {
    const navigation = useNavigation();
    const params = useLocalSearchParams();

    // Parse exercise structure from params
    const exerciseStructure = params.exerciseStructure
        ? JSON.parse(params.exerciseStructure as string)
        : [];

    const exercises: ExerciseCard[] = exerciseStructure;

    const workoutName = params.workoutName as string || 'Workout';
    const sessionId = params.sessionId as string | undefined;
    const workoutType = (params.workoutType as 'main_plan' | 'extra_workout' | 'saved_workout' | 'replacement_workout') || 'main_plan';

    // Disable the ROOT edge-swipe only while the PLAYER is mounted: a root
    // pop from under the player can land on a stale pre-auth entry, so its
    // exits must go through the guard.
    // Scoping it here — instead of `gestureEnabled: false` on the root
    // "workout" screen — keeps swipe-back alive for workout-group screens
    // opened WITHOUT the player (e.g. exercise-detail pushed from the
    // Progress tab, where the root pop back to tabs is both safe and
    // expected).
    useEffect(() => {
        const parent = navigation.getParent();
        parent?.setOptions({ gestureEnabled: false });
        return () => parent?.setOptions({ gestureEnabled: true });
    }, [navigation]);

    return (
        <WorkoutErrorBoundary
            onError={(error) => {
                // A render crash mid-workout is the worst possible moment to
                // be invisible — report it on both channels.
                captureException(error, { surface: 'workout_player', workoutName });
                posthog.capture('workout_render_crash', {
                    workout_type: workoutType,
                    error: error.message,
                });
            }}
            onExit={() => performGuardedWorkoutExit(navigation)}
        >
            <ExerciseTikTokScroll
                exercises={exercises}
                sessionId={sessionId}
                workoutType={workoutType}
                onComplete={() => {
                    console.log('Workout completed!');
                    performGuardedWorkoutExit(navigation);
                }}
            />
        </WorkoutErrorBoundary>
    );
}
