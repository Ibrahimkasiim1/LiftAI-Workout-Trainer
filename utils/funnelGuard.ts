import { getSession, supabase } from './supabase';
import {
  FunnelSnapshot,
  FunnelStage,
  clearFunnelSnapshot,
  readFunnelSnapshot,
  routeForFunnelStage,
  writeFunnelSnapshot,
} from './funnelState';

type ProfileGateData = {
  name: string | null;
  onboarding_completed: boolean | null;
  onboarding_questions_completed: boolean | null;
  notification_permission_requested: boolean | null;
  initial_plan_generation_status: InitialPlanGenerationStatus | null;
  initial_plan_generation_started_at: string | null;
};

export type InitialPlanGenerationStatus = 'idle' | 'running' | 'failed';
export const PLAN_GENERATION_RUNNING_TTL_MS = 45 * 60 * 1000;

export interface PlanGenerationState {
  status: InitialPlanGenerationStatus | null;
  startedAt: string | null;
}

export interface FunnelPrerequisites {
  hasName: boolean;
  hasCompletedOnboarding: boolean;
  hasCompletedOnboardingQuestions: boolean;
  hasGeneratedPlan: boolean;
  isInitialPlanGenerationPending: boolean;
  hasRequestedNotificationPermission: boolean;
  subscriptionStatus: 'active' | 'inactive' | 'unknown';
}

export interface GuardResolution {
  stage: FunnelStage;
  route: string;
  snapshot: FunnelSnapshot;
  prerequisites: FunnelPrerequisites;
}

interface ResolveGuardedRouteOptions {
  resolveSubscriptionStatus?: () => Promise<boolean>;
}

async function getProfileGateData(userId: string): Promise<ProfileGateData | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(
      'name,onboarding_completed,onboarding_questions_completed,notification_permission_requested,initial_plan_generation_status,initial_plan_generation_started_at'
    )
    .eq('id', userId)
    .single();

  // PGRST116 = no row: a genuinely brand-new user. Any OTHER error (network
  // flake, timeout) must throw — returning null here used to make the guard
  // treat a fully-onboarded user as "no profile" and dump them back into
  // onboarding on a transient failure.
  if (error?.code === 'PGRST116') {
    return null;
  }

  if (error) {
    throw error;
  }

  return (data as ProfileGateData | null) ?? null;
}

export async function hasActivePlan(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('workout_plans')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Throw instead of returning false: "false" reads as "user has no plan"
    // and re-routes a completed user into plan generation on a network flake.
    console.warn('Failed to resolve active plan for guard:', error);
    throw error;
  }

  return Boolean(data?.id);
}

export function isInitialPlanGenerationPending(
  status: InitialPlanGenerationStatus | null | undefined,
  startedAt: string | null | undefined
): boolean {
  if (status !== 'running' || !startedAt) {
    return false;
  }
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  return Date.now() - startedMs < PLAN_GENERATION_RUNNING_TTL_MS;
}

export async function getPlanGenerationState(userId: string): Promise<PlanGenerationState> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('initial_plan_generation_status,initial_plan_generation_started_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('Failed to fetch generation state from profile:', error);
    return { status: null, startedAt: null };
  }

  return {
    status: (data?.initial_plan_generation_status as InitialPlanGenerationStatus | null) ?? null,
    startedAt: data?.initial_plan_generation_started_at ?? null,
  };
}

function chooseMidFunnelStage(snapshot: FunnelSnapshot | null): FunnelStage {
  if (!snapshot) return 'soft_paywall';
  if (snapshot.stage === 'soft_paywall' || snapshot.stage === 'plan_generation') {
    return snapshot.stage;
  }
  return 'soft_paywall';
}

function resolveCanonicalStage(
  snapshot: FunnelSnapshot | null,
  prereqs: FunnelPrerequisites
): FunnelStage {
  // Once the funnel snapshot has reached main_app (written at onboarding
  // completion), a completed user with a plan is NEVER routed back into an
  // onboarding screen — the "start my first workout" path intentionally skips
  // the notification prompt, so the missing permission flag must not demote
  // them to notification_setup on the next launch/refresh.
  const reachedMainApp = snapshot?.stage === 'main_app';

  if (!prereqs.hasName) {
    return 'name_entry';
  }

  if (!prereqs.hasGeneratedPlan && prereqs.isInitialPlanGenerationPending) {
    return 'plan_generation';
  }

  // Strict sequential guard:
  // 1) hasName gate
  // 2) onboarding completion gate
  // 3) generated workout gate
  // 4) allow main app only when prerequisites are satisfied
  if (!prereqs.hasCompletedOnboarding) {
    if (!prereqs.hasCompletedOnboardingQuestions) {
      return 'onboarding_questions';
    }

    if (!prereqs.hasGeneratedPlan) {
      return chooseMidFunnelStage(snapshot);
    }

    return 'hard_paywall';
  }

  if (prereqs.hasCompletedOnboarding && !prereqs.hasGeneratedPlan) {
    return 'plan_generation';
  }

  // if (prereqs.subscriptionStatus !== 'active') {
  //   return 'hard_paywall';
  // }

  if (!prereqs.hasRequestedNotificationPermission && !reachedMainApp) {
    return 'notification_setup';
  }

  return 'main_app';
}

export function canAccessMainApp(prerequisites: FunnelPrerequisites): boolean {
  return (
    prerequisites.hasName &&
    prerequisites.hasCompletedOnboarding &&
    prerequisites.hasGeneratedPlan // &&
    // prerequisites.subscriptionStatus === 'active'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard-resolution cache. A full resolution costs 3 Supabase queries plus a
// RevenueCat refresh, and it used to run three times per home visit (launch
// gate, tabs layout, home failsafe). Every fresh resolveGuardedRoute() seeds
// this cache; resolveGuardedRouteCached() reuses it within the TTL for the
// same user. Keyed by user id so a sign-out/sign-in can never leak a stale
// verdict across accounts.
// ─────────────────────────────────────────────────────────────────────────────

const GUARD_CACHE_TTL_MS = 60_000;

let guardCache: { userId: string; at: number; resolution: GuardResolution } | null = null;

export function invalidateGuardCache(): void {
  guardCache = null;
}

/**
 * Cache-first variant for failsafe re-checks (tab focus, layout re-eval). A
 * resolution younger than the TTL is returned as-is; otherwise this falls
 * through to a fresh resolveGuardedRoute (which re-seeds the cache).
 */
export async function resolveGuardedRouteCached(
  options?: ResolveGuardedRouteOptions
): Promise<GuardResolution | null> {
  const session = await getSession();
  if (!session) {
    guardCache = null;
    await clearFunnelSnapshot();
    return null;
  }

  if (
    guardCache &&
    guardCache.userId === session.user.id &&
    Date.now() - guardCache.at < GUARD_CACHE_TTL_MS
  ) {
    // Screens advance the local funnel snapshot the moment a stage completes
    // (paywall → generation → … → main_app). If the snapshot has moved past
    // the cached verdict, the cache is stale mid-TTL — e.g. a user who just
    // finished onboarding must not be bounced back by a 30-second-old
    // "hard_paywall" resolution. Re-resolve instead.
    const snapshot = await readFunnelSnapshot();
    if ((snapshot?.stage ?? null) === guardCache.resolution.stage) {
      return guardCache.resolution;
    }
  }

  return resolveGuardedRoute(options);
}

export async function resolveGuardedRoute(
  options?: ResolveGuardedRouteOptions
): Promise<GuardResolution | null> {
  const session = await getSession();
  if (!session) {
    guardCache = null;
    await clearFunnelSnapshot();
    return null;
  }

  const [snapshot, profile] = await Promise.all([
    readFunnelSnapshot(),
    getProfileGateData(session.user.id),
  ]);

  const hasPlan = await hasActivePlan(session.user.id);

  let subscriptionStatus: FunnelPrerequisites['subscriptionStatus'] = 'unknown';
  if (options?.resolveSubscriptionStatus) {
    try {
      const subscribed = await options.resolveSubscriptionStatus();
      subscriptionStatus = subscribed ? 'active' : 'inactive';
    } catch (error) {
      console.warn('Failed to resolve subscription for guard:', error);
    }
  }

  const prerequisites: FunnelPrerequisites = {
    hasName: Boolean(profile?.name?.trim()),
    hasCompletedOnboarding: Boolean(profile?.onboarding_completed),
    hasCompletedOnboardingQuestions: Boolean(profile?.onboarding_questions_completed),
    hasGeneratedPlan: hasPlan,
    isInitialPlanGenerationPending: isInitialPlanGenerationPending(
      profile?.initial_plan_generation_status,
      profile?.initial_plan_generation_started_at
    ),
    hasRequestedNotificationPermission: Boolean(profile?.notification_permission_requested),
    subscriptionStatus,
  };

  const stage = resolveCanonicalStage(snapshot, prerequisites);
  const resolvedSnapshot = await writeFunnelSnapshot(stage, {
    route: routeForFunnelStage(stage),
    reason: 'guard_resolution',
  });

  const resolution: GuardResolution = {
    stage,
    route: resolvedSnapshot.lastRoute,
    snapshot: resolvedSnapshot,
    prerequisites,
  };

  guardCache = { userId: session.user.id, at: Date.now(), resolution };

  return resolution;
}
