/**
 * Routes where ads must be suppressed.
 *
 * Onboarding, paywall, and force-update screens are critical funnel
 * surfaces — interstitials and banners on these screens hurt activation
 * and conversion. Keep this list in sync with any new pre-tabs flows.
 */
const AD_FREE_PREFIXES = [
  '/onboarding',
  '/auth',
  '/plan-expired',
  '/force-update',
];

/**
 * Routes where the PERIODIC interstitial timer must additionally hold fire.
 *
 * The workout player runs its own governed ad surfaces (banner + interstitials
 * at safe moments like rest windows), so it stays out of AD_FREE_PREFIXES —
 * but the background 4-minute timer must never interrupt a user mid-set.
 * The quota-limit sheet is a conversion moment; an interstitial on top of it
 * would bury the upgrade pitch.
 */
const PERIODIC_INTERSTITIAL_BLOCKED_PREFIXES = [
  ...AD_FREE_PREFIXES,
  '/workout',
  '/quota-limit',
];

export function isAdFreeRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return AD_FREE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function isPeriodicInterstitialBlockedRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PERIODIC_INTERSTITIAL_BLOCKED_PREFIXES.some(prefix => pathname.startsWith(prefix));
}
