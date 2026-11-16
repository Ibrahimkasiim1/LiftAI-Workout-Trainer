import AsyncStorage from '@react-native-async-storage/async-storage';

export type FunnelStage =
  | 'name_entry'
  | 'onboarding_questions'
  | 'projected_results'
  | 'soft_paywall'
  | 'plan_generation'
  | 'hard_paywall'
  | 'notification_setup'
  | 'main_app';

export interface FunnelSnapshot {
  stage: FunnelStage;
  lastRoute: string;
  updatedAt: string;
  reason?: string;
}

const FUNNEL_STORAGE_KEY = '@lift3_funnel_state_v1';

const STAGE_TO_ROUTE: Record<FunnelStage, string> = {
  name_entry: '/onboarding?nameEntry=1',
  onboarding_questions: '/onboarding',
  // The projected-results screen was removed; the stage stays in the type so
  // snapshots persisted by older builds still resume — into the paywall.
  projected_results: '/onboarding/paywall',
  soft_paywall: '/onboarding/paywall',
  plan_generation: '/onboarding/plan-generation',
  hard_paywall: '/onboarding/plan-review',
  notification_setup: '/onboarding/notification-setup',
  main_app: '/(tabs)',
};

function isFunnelStage(value: unknown): value is FunnelStage {
  return (
    value === 'onboarding_questions' ||
    value === 'name_entry' ||
    value === 'projected_results' ||
    value === 'soft_paywall' ||
    value === 'plan_generation' ||
    value === 'hard_paywall' ||
    value === 'notification_setup' ||
    value === 'main_app'
  );
}

function isFunnelSnapshot(value: unknown): value is FunnelSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<FunnelSnapshot>;
  return (
    isFunnelStage(candidate.stage) &&
    typeof candidate.lastRoute === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

export function routeForFunnelStage(stage: FunnelStage): string {
  return STAGE_TO_ROUTE[stage];
}

export function stageForRoute(route: string): FunnelStage | null {
  if (route === '/onboarding?nameEntry=1') return 'name_entry';
  if (route === '/onboarding') return 'onboarding_questions';
  if (route === '/onboarding/paywall') return 'soft_paywall';
  if (route === '/onboarding/plan-generation') return 'plan_generation';
  if (route === '/onboarding/plan-review') return 'hard_paywall';
  if (route === '/onboarding/notification-setup') return 'notification_setup';
  if (route === '/(tabs)') return 'main_app';
  return null;
}

export async function readFunnelSnapshot(): Promise<FunnelSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(FUNNEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    return isFunnelSnapshot(parsed) ? parsed : null;
  } catch (error) {
    console.warn('Failed to read funnel snapshot:', error);
    return null;
  }
}

export async function writeFunnelSnapshot(
  stage: FunnelStage,
  options?: { route?: string; reason?: string }
): Promise<FunnelSnapshot> {
  const snapshot: FunnelSnapshot = {
    stage,
    lastRoute: options?.route ?? routeForFunnelStage(stage),
    updatedAt: new Date().toISOString(),
    ...(options?.reason ? { reason: options.reason } : {}),
  };

  try {
    await AsyncStorage.setItem(FUNNEL_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('Failed to persist funnel snapshot:', error);
  }

  return snapshot;
}

export async function clearFunnelSnapshot(): Promise<void> {
  try {
    await AsyncStorage.removeItem(FUNNEL_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear funnel snapshot:', error);
  }
}
