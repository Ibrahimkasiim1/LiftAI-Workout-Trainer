// utils/workoutExit.ts
//
// The single imperative exit path out of the workout player. Wraps the pure
// decision logic in utils/navigationGuards.ts (kept React-free so it stays
// unit-testable in plain Node) with the root-navigator walk and the
// replace-to-home fallback. Every workout exit — back/X, consent decline,
// Finish, completion callback, error-boundary exit — MUST route through
// this one function so the logic never drifts between hand-synced copies.

import { router } from 'expo-router';

import { resolveWorkoutExitAction, type StackStateLike } from './navigationGuards';

interface NavigationLike {
    getParent?: () => NavigationLike | null | undefined;
    getState?: () => StackStateLike | undefined;
    canGoBack: () => boolean;
    goBack: () => void;
}

/**
 * Pop when the player was pushed from a real in-app screen (returns to it
 * with state intact and no duplicate root entry); replace to home when it
 * wasn't — the player can be the ONLY screen in the stack (first-workout
 * onboarding path enters via replace), or sit above a stale pre-auth entry
 * that a pop must never reveal.
 */
export function performGuardedWorkoutExit(navigation: NavigationLike): void {
    let rootNav: NavigationLike | null | undefined = navigation;
    while (rootNav?.getParent?.()) {
        rootNav = rootNav.getParent!();
    }
    const action = resolveWorkoutExitAction(
        navigation.getState?.(),
        rootNav?.getState?.()
    );
    if (action === 'goBack' && navigation.canGoBack()) {
        navigation.goBack();
    } else {
        router.replace('/(tabs)');
    }
}
