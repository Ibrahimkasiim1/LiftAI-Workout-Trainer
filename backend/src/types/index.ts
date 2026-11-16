/**
 * Backend Type Definitions
 * 
 * Backend-specific types that are compatible with but extend the centralized types.
 * These types are used internally by agents and services.
 */

// ============================================================================
// USER PROFILE (compatible with centralized UserProfile)
// ============================================================================

export interface UserProfile {
  id: string;
  name: string;
  email?: string;
  gender: string;
  birthday: string;
  height_cm: number;
  height_unit: string;
  weight_kg: number;
  weight_unit: string;
  goal_weight_kg: number;
  fitness_level: FitnessLevel;
  goal: string;
  injuries?: string | null;
  /** JSON array of { text, recorded_at } — set by AI coach mutate_user_memory tool */
  coach_memory?: unknown;
  location: string;
  workout_split_type: SplitType;
  workout_days_per_week: number;
  workout_duration_minutes: number;
  selected_workout_days?: DayOfWeek[];
  available_equipment: string[];
  pace: string;
  custom_split?: any;
  initial_plan_generation_status?: 'idle' | 'running' | 'failed';
  initial_plan_generation_started_at?: string | null;
  onboarding_completed: boolean;
  onboarding_questions_completed: boolean;
  notifications_enabled: boolean;
  notification_permission_requested: boolean;
  created_at: string;
  updated_at?: string;
}

// ============================================================================
// WORKOUT TYPES
// ============================================================================

export type SplitType = 'full_body' | 'upper_lower' | 'ppl' | 'bro_split' | 'custom';
export type FitnessLevel = 'beginner' | 'intermediate' | 'advanced';
export type WorkoutType = 'main_plan' | 'extra_workout' | 'replacement_workout' | 'quick_workout';

export interface DayOfWeek {
  day: string;
  enabled: boolean;
}

// ============================================================================
// WORKOUT PLAN (for internal backend use)
// ============================================================================

export interface WorkoutPlan {
  id: string;
  user_id: string;
  plan_name: string;
  is_active: boolean;
  created_at: string;
  // Extended properties for internal workflow
  split?: SplitType;
  goal?: string;
  days?: DailyWorkout[];
}

export interface DailyWorkout {
  id: string;
  plan_id: string;
  day_of_week: string;
  split_day_name: string;
  exercises: string[];
  exercises_structured: ExerciseDetail[];
  estimated_time: number;
  notes?: string;
  // Extended properties for workflows
  dayIndex?: number;
  focus?: string;
  date?: string | null;
  // Override metadata (added when overrides are active)
  overrideNote?: string;
  overrideExpiresAt?: string;
  overrideType?: string;
  hasReplacements?: boolean;
  replacementCount?: number;
}

export interface ExerciseDetail {
  id: string; // REQUIRED — Supabase exercise ID
  name: string; // REQUIRED
  gif_path: string; // REQUIRED — UI rendering depends on this
  sets: number;
  reps: string | number;
  rest_seconds: number;
  target_muscle?: string | null;
  body_part?: string | null;
  equipment?: string | null;
  /** Cleaned equipment bucket (e.g. "machine", "dumbbell"). From exercises.equipment_canonical. */
  equipment_canonical?: string | null;
  /** User-facing equipment label, disambiguated from the name (e.g. "Chest Press Machine"). */
  equipment_display?: string | null;
  /** AI-generated biomechanics metadata (see exerciseEnrichment.ts). */
  enrichment?: {
    equipment_canonical?: string;
    equipment_display?: string;
    movement_pattern?: string;
    mechanics?: string;
    force?: string;
    unilateral?: boolean;
    primary_goal?: string;
    joint_friendly?: string[];
    aliases?: string[];
    summary?: string;
  } | null;
  difficulty?: string | null;
  instructions?: string[] | null;
  notes?: string;
  /** Pre-generated alternative exercise names sourced from the allowed dictionary. */
  quick_alternatives?: string[];
  /** Auto-regulation target string (RIR / RPE) for daily readiness programming. */
  intensity_target?: string;
  /** User-facing modification cue when this exercise borders a reported injury. */
  injury_note?: string;
}

// ============================================================================
// PLANNED EXERCISE (for plan generation)
// ============================================================================

export interface PlannedExercise {
  exerciseId: string;
  name: string;
  equipment?: string;
  target?: string;
  sets: number;
  reps: string;
  restSeconds: number;
}

// ============================================================================
// SAVED WORKOUT
// ============================================================================

export interface SavedWorkout {
  id: string;
  user_id: string;
  workout_name: string;
  workout_type: WorkoutType;
  exercises: string[];
  exercises_structured: ExerciseDetail[];
  estimated_time: number;
  difficulty: FitnessLevel;
  description?: string;
  note?: string;
  replacement_for?: string;
  replacement_date?: string;
  created_at: string;
  updated_at?: string;
}

// ============================================================================
// ACTIVE SESSION
// ============================================================================

export interface ActiveWorkoutSession {
  id: string;
  user_id: string;
  session_id?: string;
  workout_id?: string;
  workout_name: string;
  workout_type: string;
  exercises: string[];
  exercises_structured: ExerciseDetail[];
  estimated_time: number;
  difficulty?: string;
  current_exercise_index?: number;
  current_set?: number;
  total_sets?: number;
  sets_completed?: any;
  is_resting?: boolean;
  rest_time_duration?: number;
  rest_time_remaining?: number;
  started_at?: string;
  updated_at?: string;
}

// ============================================================================
// LANGGRAPH STATE TYPES
// ============================================================================

export interface PlanGenerationState {
  userId: string;
  profile?: UserProfile;
  split?: SplitType;
  plan?: WorkoutPlan;
  days?: DailyWorkout[];
  quickWorkout?: DailyWorkout;
  messages?: any[];
  context?: Record<string, unknown>;
}

export interface AdjustTodayRequest {
  userId: string;
  dayIndex?: number;
  request?: string;
  constraints?: string[];
}

export interface MissedDayRequest {
  userId: string;
  missedDate: string;
  preference?: "shift" | "merge" | "skip";
}

// ============================================================================
// CHAT API RESPONSE (Standardized)
// ============================================================================

export interface ChatResponse {
  success: boolean;
  intent: "planner" | "adjuster" | "coach" | "editor";
  message: string;
  data?: {
    workout?: any;
    plan?: any;
    overrides?: any[];
  };
  error?: string;
}

// ============================================================================
// LEGACY COMPATIBILITY
// ============================================================================

export type TrainingLevel = FitnessLevel;
export type SplitOption = SplitType;
