// utils/nutritionGoals.ts
//
// Personalized daily nutrition targets derived from a user's onboarding
// profile. Replaces the old one-size-fits-all 2200 kcal / 160-240-70 defaults
// so every user gets calories + macros tuned to their body, activity, and goal.
//
// Method:
//   1. BMR via Mifflin–St Jeor (the most accurate widely-used estimate).
//   2. TDEE = BMR × activity multiplier (inferred from workout_days_per_week).
//   3. Calorie target = TDEE ± a deficit/surplus scaled by goal + pace.
//   4. Macros: protein from bodyweight (goal-dependent), fat at 25% of energy,
//      carbs fill the remainder.

export type NutritionGoals = {
  calorieGoal: number;
  proteinGoal: number;
  carbsGoal: number;
  fatsGoal: number;
};

// Subset of user_profiles fields used for the calculation. Kept loose so a
// partial / in-progress profile still produces sensible numbers.
export type GoalProfileInput = {
  birthday?: string | null;
  gender?: string | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  goal?: string | null; // 'lose' | 'maintain' | 'gain' | 'build_muscle'
  pace?: string | null; // 'slow' | 'medium' | 'fast'
  workout_days_per_week?: number | null;
};

// Sensible fallbacks if a profile field is missing entirely.
const DEFAULTS = {
  height_cm: 170,
  weight_kg: 70,
  age: 30,
  gender: 'Other',
  goal: 'maintain',
  pace: 'medium',
  workout_days_per_week: 3,
} as const;

function ageFromBirthday(birthday?: string | null): number {
  if (!birthday) return DEFAULTS.age;
  const birth = new Date(birthday);
  if (isNaN(birth.getTime())) return DEFAULTS.age;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  if (age < 13 || age > 100) return DEFAULTS.age;
  return age;
}

// Estimate activity multiplier from training frequency. We can't know NEAT, so
// workout days is the best available proxy.
function activityMultiplier(daysPerWeek: number): number {
  if (daysPerWeek <= 1) return 1.2; // sedentary
  if (daysPerWeek <= 3) return 1.375; // light
  if (daysPerWeek <= 5) return 1.55; // moderate
  if (daysPerWeek === 6) return 1.725; // very active
  return 1.9; // 7 days — extra active
}

// Percent of TDEE to add (positive) or remove (negative) for the chosen goal,
// scaled by how aggressive the user wants to be.
function calorieAdjustmentPct(goal: string, pace: string): number {
  const paceFactor = pace === 'slow' ? 0.6 : pace === 'fast' ? 1.4 : 1; // medium = 1
  switch (goal) {
    case 'lose':
      return -0.18 * paceFactor; // ~10% / 18% / 25% deficit
    case 'gain':
    case 'build_muscle':
      return 0.1 * paceFactor; // ~6% / 10% / 14% lean surplus
    case 'maintain':
    default:
      return 0;
  }
}

// Grams of protein per kg of bodyweight. Higher in a deficit to preserve lean
// mass; moderate-high for muscle gain.
function proteinPerKg(goal: string): number {
  switch (goal) {
    case 'lose':
      return 2.0;
    case 'gain':
    case 'build_muscle':
      return 1.8;
    case 'maintain':
    default:
      return 1.6;
  }
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

/**
 * Compute personalized calorie + macro targets from an onboarding profile.
 * Always returns finite, positive numbers — safe to feed straight into the UI.
 */
export function computeNutritionGoals(profile: GoalProfileInput): NutritionGoals {
  const weightKg =
    profile.weight_kg && profile.weight_kg > 0 ? profile.weight_kg : DEFAULTS.weight_kg;
  const heightCm =
    profile.height_cm && profile.height_cm > 0 ? profile.height_cm : DEFAULTS.height_cm;
  const age = ageFromBirthday(profile.birthday);
  const gender = (profile.gender || DEFAULTS.gender).toLowerCase();
  const goal = profile.goal || DEFAULTS.goal;
  const pace = profile.pace || DEFAULTS.pace;
  const days =
    profile.workout_days_per_week && profile.workout_days_per_week > 0
      ? profile.workout_days_per_week
      : DEFAULTS.workout_days_per_week;

  // 1. BMR (Mifflin–St Jeor). 'Other' uses the midpoint of the sex constants.
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  const sexConstant = gender === 'male' ? 5 : gender === 'female' ? -161 : -78;
  const bmr = base + sexConstant;

  // 2. TDEE.
  const tdee = bmr * activityMultiplier(days);

  // 3. Calorie target, with a hard floor so aggressive deficits stay safe.
  const adjusted = tdee * (1 + calorieAdjustmentPct(goal, pace));
  const floor = gender === 'female' ? 1200 : 1500;
  const calorieGoal = roundTo(Math.max(adjusted, floor, bmr), 10);

  // 4. Macros.
  const proteinGoal = roundTo(weightKg * proteinPerKg(goal), 5);
  const fatsGoal = roundTo((calorieGoal * 0.25) / 9, 5); // 25% of energy from fat
  const remainingCals = calorieGoal - proteinGoal * 4 - fatsGoal * 9;
  const carbsGoal = roundTo(Math.max(remainingCals, 0) / 4, 5);

  return { calorieGoal, proteinGoal, carbsGoal, fatsGoal };
}
