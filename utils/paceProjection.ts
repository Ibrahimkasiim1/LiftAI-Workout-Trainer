/**
 * Pace → weekly-rate → goal-date projection, shared by the onboarding pace
 * step and the paywall outcome headline.
 *
 * Rates mirror mainstream coaching apps (MacroFactor / Cal AI style) and are
 * safety-capped so the "fast" option can never promise an unhealthy timeline:
 *   - weight loss is capped at 1% of body weight per week
 *   - lean gain is capped at 0.5% of body weight per week
 */

export type PaceKey = 'slow' | 'medium' | 'fast';

const BASE_RATE_KG_PER_WEEK: Record<'lose' | 'gain', Record<PaceKey, number>> = {
    lose: { slow: 0.25, medium: 0.5, fast: 0.75 },
    gain: { slow: 0.125, medium: 0.25, fast: 0.4 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isPaceKey(value: unknown): value is PaceKey {
    return value === 'slow' || value === 'medium' || value === 'fast';
}

/** Capped weekly rate in kg for the chosen goal/pace. 0 when not applicable. */
export function weeklyRateKg(goal: string, pace: PaceKey, weightKg: number): number {
    if (goal !== 'lose' && goal !== 'gain') return 0;
    const base = BASE_RATE_KG_PER_WEEK[goal][pace];
    const cap = goal === 'lose' ? weightKg * 0.01 : weightKg * 0.005;
    return Math.max(0.1, Math.min(base, cap));
}

export function formatWeeklyRate(rateKg: number, unit: 'kg' | 'lbs'): string {
    if (unit === 'kg') {
        return `${rateKg.toFixed(rateKg < 0.2 ? 2 : 1)} kg/week`;
    }
    return `${(rateKg * 2.20462).toFixed(1)} lb/week`;
}

export interface GoalProjection {
    weeks: number;
    dateLabel: string; // e.g. "Aug 14"
}

/**
 * Projected time to goal at the chosen pace. Weeks are clamped to 2–52 so the
 * promise stays believable. Returns null for maintain / negligible deltas.
 */
export function projectGoal(
    goal: string,
    weightKg: number,
    goalWeightKg: number,
    pace: PaceKey,
): GoalProjection | null {
    if (goal !== 'lose' && goal !== 'gain') return null;
    const diffKg = Math.abs(goalWeightKg - weightKg);
    if (diffKg < 0.5) return null;
    const rate = weeklyRateKg(goal, pace, weightKg);
    const weeks = Math.min(52, Math.max(2, Math.ceil(diffKg / rate)));
    const d = new Date();
    d.setDate(d.getDate() + weeks * 7);
    return { weeks, dateLabel: `${MONTHS[d.getMonth()]} ${d.getDate()}` };
}
