import { router } from 'expo-router';

import { resolveGuardedRoute } from './funnelGuard';

/**
 * After sign-out (or forced unauthenticated state), reset the navigation stack so the user
 * cannot iOS gesture-back into protected routes (e.g. tabs) that remain under the current screen.
 * Aligns with the cold-start entry route in app/index.tsx.
 */
export function replaceWithSignedOutRoot(): void {
  try {
    router.dismissAll();
  } catch {
    // No-op if nothing to dismiss (varies by navigator state).
  }
  router.replace('/auth/welcome');
}

/**
 * After a successful sign-in or sign-up (email, Google, Apple, magic link),
 * land the user on the exact funnel stage the guard resolves — never on a
 * hard-coded screen. Branching on `onboarding_completed` alone used to
 * restart mid-funnel users (questions done, plan already generated) at the
 * beginning of the quiz, recreating the plan-review-stuck cohort through the
 * sign-in door.
 *
 * Failure semantics mirror app/index.tsx: guard resolved → its stage route;
 * no session → welcome; guard threw (network flake) → fail OPEN into the
 * app, where the tabs-layout failsafe re-verifies once the connection
 * recovers.
 */
export async function replaceWithPostAuthRoute(): Promise<void> {
  try {
    const resolution = await resolveGuardedRouteWithRetry();
    router.replace((resolution ? resolution.route : '/auth/welcome') as any);
  } catch (error) {
    console.warn('Post-auth guard resolution failed twice, failing open to tabs:', error);
    router.replace('/(tabs)');
  }
}

/**
 * One retry absorbs the common transient flake in the seconds right after
 * sign-in (the guard deliberately throws rather than degrade); a second
 * failure falls through to the fail-open path above.
 */
async function resolveGuardedRouteWithRetry(): ReturnType<typeof resolveGuardedRoute> {
  try {
    return await resolveGuardedRoute();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return resolveGuardedRoute();
  }
}
