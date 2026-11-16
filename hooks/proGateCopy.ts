// hooks/proGateCopy.ts
//
// Contextual paywall copy keyed by feature. Extracted from useProGate.ts so
// the ProGateProvider can import the map without pulling in the hook itself
// (which would create a circular import: hook → context → hook).
// (Formerly useProGate.copy.ts — renamed because the ".copy" suffix read as a
// stray duplicate one cleanup away from deletion, while actually being a live
// dependency of the quota sheet and the ProGate context.)

export type GatedFeature =
  | 'chat'
  | 'nutrition_ai'
  | 'photo_logging'
  | 'voice_coach'
  | 'dynamic_island'
  | 'progress_analytics'
  | 'saved_workouts_limit'
  | 'plan_modifications'
  | 'manual_edit'
  | 'workout_generation'
  | 'exercise_swap';

export interface PaywallCopy {
  headline: string;
  subhead: string;
  /** What the user unlocks for THIS specific feature. */
  bullets: string[];
}

export const PAYWALL_COPY: Record<GatedFeature, PaywallCopy> = {
  chat: {
    headline: 'Unlock your AI Coach',
    subhead: 'Chat with a personalized fitness coach 24/7.',
    bullets: [
      'Generate custom workouts on demand',
      'Get exercise swaps that match your equipment',
      'Ask form, nutrition, and programming questions anytime',
    ],
  },
  nutrition_ai: {
    headline: 'Smarter Nutrition Logging',
    subhead: 'Skip the macro math — log meals in plain English.',
    bullets: [
      'Type or speak what you ate, get instant macros',
      'Smart clarifications for portion sizes',
      'Build daily totals without a database lookup',
    ],
  },
  photo_logging: {
    headline: 'Snap a photo. Meal logged.',
    subhead: 'Your photo is ready — Pro turns it into macros in seconds.',
    bullets: [
      'Point your camera at any plate, get itemized macros',
      '"Fix with a note" corrections on every scan',
      'Works on packaged food, restaurant meals, and leftovers',
    ],
  },
  voice_coach: {
    headline: 'Talk to your Coach',
    subhead: 'Hands-free coaching during your workout.',
    bullets: [
      'Voice-driven workout adjustments',
      'Real-time form cues between sets',
      'Log meals and weight hands-free',
    ],
  },
  dynamic_island: {
    headline: 'Rest Timer on the Dynamic Island',
    subhead: 'Keep your rest timer visible without unlocking.',
    bullets: [
      'Live countdown on the Dynamic Island',
      'Lock screen widget with skip button',
      'Never miss the start of your next set',
    ],
  },
  progress_analytics: {
    headline: 'Deeper Progress Insights',
    subhead: 'See trends, not just last week.',
    bullets: [
      'Volume and PR trends across every lift',
      'Muscle-group balance breakdown',
      'Full workout history & consistency heatmap',
    ],
  },
  saved_workouts_limit: {
    headline: 'Unlimited Saved Workouts',
    subhead: "You've filled your free 3 slots.",
    bullets: [
      'Save as many workout templates as you want',
      'Organize a full library for travel, home, and gym',
      'Quick-start any saved session in one tap',
    ],
  },
  plan_modifications: {
    headline: 'Unlimited Plan Edits',
    subhead: "You've used your 3 free plan modifications.",
    bullets: [
      'Change your plan as often as your goals shift',
      'Swap exercises, shift days, scale volume anytime',
      'Your coach adapts with you',
    ],
  },
  manual_edit: {
    headline: 'Take Full Control of Your Plan',
    subhead: 'Hands-on editing — no coach conversation needed.',
    bullets: [
      'Add, replace, remove, and reorder any exercise',
      'Drag workouts between days to reshape your week',
      'Adjust set counts per exercise in one tap',
    ],
  },
  workout_generation: {
    headline: 'Generate New Workouts',
    subhead: 'Create a fresh workout for any situation.',
    bullets: [
      'Hotel room, travel day, missing equipment — handled',
      'Tailored to your goals and injury history',
      'Save generated workouts to your library',
    ],
  },
  exercise_swap: {
    headline: 'Hot-Swap Exercises',
    subhead: 'Mid-workout, swap any exercise for a smart alternative.',
    bullets: [
      'Equipment-aware substitutions in one tap',
      'Injury-friendly alternatives when something hurts',
      'AI picks a match that fits the rest of your session',
    ],
  },
};
