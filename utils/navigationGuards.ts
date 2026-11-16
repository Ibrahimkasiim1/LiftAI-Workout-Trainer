// utils/navigationGuards.ts
//
// Pure decision logic for exits that use goBack(). Kept free of React/expo-router
// imports so it can be unit-tested in plain Node.
//
// Context: goBack() pops the DEEPEST navigator that can pop. From the workout
// player the nearest (workout group) stack usually has a single route, so the
// pop happens at the ROOT stack — and whatever sits below the current root
// entry is where the user lands. If that entry is a pre-auth/funnel group
// (auth, onboarding), a signed-in user gets dumped onto a logged-out screen.

/** Minimal structural view of a react-navigation stack state. */
export interface StackStateLike {
    index?: number;
    routes?: ({ name?: string } | null | undefined)[] | null;
}

/**
 * Root-stack route names a signed-in user must never be sent BACK to.
 * `index` is the cold-start splash redirector; `auth` and `onboarding` are the
 * pre-auth funnel groups.
 */
const PRE_AUTH_ROOT_ROUTES = new Set(['index', 'auth', 'onboarding']);

/** True when a stack has somewhere of its own to pop to. */
export function stackCanPop(state: StackStateLike | null | undefined): boolean {
    if (!state?.routes?.length) return false;
    const index = typeof state.index === 'number' ? state.index : state.routes.length - 1;
    return index > 0;
}

/**
 * True when popping the ROOT stack would land on a pre-auth/funnel route.
 * Defensive about partial states: with no routes (state not ready) it returns
 * false — callers must still prefer an explicit destination over goBack() when
 * unsure.
 */
export function rootPopLandsOnPreAuthRoute(
    rootState: StackStateLike | null | undefined
): boolean {
    if (!rootState?.routes?.length) return false;
    const index =
        typeof rootState.index === 'number' ? rootState.index : rootState.routes.length - 1;
    if (index <= 0) return false;
    const below = rootState.routes[index - 1]?.name ?? '';
    return PRE_AUTH_ROOT_ROUTES.has(below);
}

/**
 * Pathname variant of the pre-auth check, for the notification deep-link
 * guard: while the funnel is unresolved the pathname is '/' (the cold-start
 * splash) — that counts as pre-auth too, or a push during the boot delay
 * stacks an app route on top of the splash's root entry.
 */
export function isPreAuthPathname(pathname: string | null | undefined): boolean {
    if (!pathname || pathname === '/') return true;
    return pathname.startsWith('/auth') || pathname.startsWith('/onboarding');
}

export type WorkoutExitAction = 'goBack' | 'replaceHome';

/**
 * Decide how the workout player should exit.
 *
 * - If the workout group's own stack can pop (e.g. returning from a nested
 *   detail screen), goBack stays inside the group → safe.
 * - Otherwise goBack would pop the root stack: only allow it when the entry
 *   below is a real in-app destination; if it is a pre-auth/funnel route (or
 *   there is nothing to pop to, or state is unavailable), leave via an
 *   explicit replace to home instead.
 */
export function resolveWorkoutExitAction(
    nearestState: StackStateLike | null | undefined,
    rootState: StackStateLike | null | undefined
): WorkoutExitAction {
    if (stackCanPop(nearestState)) return 'goBack';
    if (!stackCanPop(rootState)) return 'replaceHome';
    if (rootPopLandsOnPreAuthRoute(rootState)) return 'replaceHome';
    return 'goBack';
}
