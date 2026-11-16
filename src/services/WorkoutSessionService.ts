import type { Json } from '../../types/supabase';
import { ExerciseCard, isValidExerciseCard } from '../../types/workoutPayload';
import { supabase } from '../../utils/supabase';

export type WorkoutSessionType =
  | 'main_plan'
  | 'extra_workout'
  | 'saved_workout'
  | 'replacement_workout'
  | 'quick_workout';

export interface SetCompletion {
  exercise_id: string;
  exercise_name: string;
  set_number: number;
  reps_completed: number;
  weight_used: number;
  completed_at?: string;
}

export interface ActiveWorkoutSession {
  id: string;
  user_id: string;
  workout_id?: string | null;
  workout_type: WorkoutSessionType;
  workout_name: string;
  exercises: string[];
  exercises_structured: ExerciseCard[];
  estimated_time: number;
  difficulty?: string | null;
  current_exercise_index: number;
  current_set: number;
  total_sets: number;
  sets_completed: SetCompletion[];
  is_resting: boolean;
  rest_time_remaining?: number | null;
  rest_time_duration?: number | null;
  started_at?: string | null;
  updated_at?: string | null;
}

function assertExerciseCards(exercises: ExerciseCard[]): ExerciseCard[] {
  if (!Array.isArray(exercises) || exercises.length === 0) {
    throw new Error('Active session requires at least one exercise');
  }

  const invalid = exercises.filter((ex) => !isValidExerciseCard(ex));
  if (invalid.length > 0) {
    throw new Error('Invalid exercise payload for active session');
  }
  return exercises;
}

export const WorkoutSessionService = {
  async getActiveSessionById(sessionId: string): Promise<ActiveWorkoutSession | null> {
    const { data, error } = await supabase
      .from('active_workout_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error) {
      console.error('Failed to load active session:', error);
      return null;
    }

    return {
      ...(data as any),
      exercises_structured: Array.isArray((data as any).exercises_structured)
        ? ((data as any).exercises_structured as ExerciseCard[])
        : [],
      sets_completed: Array.isArray((data as any).sets_completed)
        ? ((data as any).sets_completed as SetCompletion[])
        : [],
    };
  },

  async getActiveSessionByType(
    userId: string,
    workoutType: WorkoutSessionType
  ): Promise<ActiveWorkoutSession | null> {
    const { data, error } = await supabase
      .from('active_workout_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('workout_type', workoutType)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') {
        console.error('Failed to load active session:', error);
      }
      return null;
    }

    return {
      ...(data as any),
      exercises_structured: Array.isArray((data as any).exercises_structured)
        ? ((data as any).exercises_structured as ExerciseCard[])
        : [],
      sets_completed: Array.isArray((data as any).sets_completed)
        ? ((data as any).sets_completed as SetCompletion[])
        : [],
    };
  },

  async getActiveSessionsForUser(userId: string): Promise<ActiveWorkoutSession[]> {
    const { data, error } = await supabase
      .from('active_workout_sessions')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error('Failed to load active sessions:', error);
      return [];
    }

    return (data || []).map((row: any) => ({
      ...(row as any),
      exercises_structured: Array.isArray(row.exercises_structured)
        ? (row.exercises_structured as ExerciseCard[])
        : [],
      sets_completed: Array.isArray(row.sets_completed)
        ? (row.sets_completed as SetCompletion[])
        : [],
    }));
  },

  async startSession(params: {
    userId: string;
    workoutType: WorkoutSessionType;
    workoutId?: string | null;
    workoutName: string;
    exercisesStructured: ExerciseCard[];
    estimatedTime: number;
    difficulty?: string | null;
  }): Promise<ActiveWorkoutSession> {
    const exercises_structured = assertExerciseCards(params.exercisesStructured);
    const exercises = exercises_structured.map((ex) => ex.name);
    const firstSets = exercises_structured[0]?.sets ?? 3;

    const payload = {
      user_id: params.userId,
      workout_id: params.workoutId ?? null,
      workout_type: params.workoutType,
      workout_name: params.workoutName,
      exercises,
      exercises_structured: exercises_structured as unknown as Json,
      estimated_time: params.estimatedTime,
      difficulty: params.difficulty ?? null,
      current_exercise_index: 0,
      current_set: 1,
      total_sets: firstSets,
      sets_completed: [],
      is_resting: false,
      rest_time_remaining: null,
      rest_time_duration: null,
      started_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('active_workout_sessions')
      .upsert(payload, { onConflict: 'user_id,workout_type' })
      .select('*')
      .single();

    if (error || !data) {
      console.error('Failed to start session:', error);
      throw new Error(error?.message || 'Failed to start session');
    }

    return {
      ...(data as any),
      exercises_structured,
      sets_completed: [],
    };
  },

  async updateSession(
    sessionId: string,
    updates: Partial<Omit<ActiveWorkoutSession, 'id' | 'user_id'>>
  ): Promise<ActiveWorkoutSession | null> {
    const payload = {
      ...updates,
      updated_at: updates.updated_at ?? new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('active_workout_sessions')
      .update(payload as any)
      .eq('id', sessionId)
      .select('*')
      .single();

    if (error) {
      console.error('Failed to update session:', error);
      return null;
    }

    return {
      ...(data as any),
      exercises_structured: Array.isArray((data as any).exercises_structured)
        ? ((data as any).exercises_structured as ExerciseCard[])
        : [],
      sets_completed: Array.isArray((data as any).sets_completed)
        ? ((data as any).sets_completed as SetCompletion[])
        : [],
    };
  },

  async appendSetCompletion(
    sessionId: string,
    completion: SetCompletion,
    nextSet: number,
    nextTotalSets: number,
    nextExerciseIndex: number,
    restUpdates?: Pick<ActiveWorkoutSession, 'is_resting' | 'rest_time_remaining' | 'rest_time_duration'>
  ): Promise<ActiveWorkoutSession | null> {
    const session = await this.getActiveSessionById(sessionId);
    if (!session) return null;

    const updated = {
      sets_completed: [...(session.sets_completed || []), completion],
      current_set: nextSet,
      total_sets: nextTotalSets,
      current_exercise_index: nextExerciseIndex,
      ...(restUpdates || {}),
    };

    return this.updateSession(sessionId, updated);
  },

  async endSession(sessionId: string): Promise<void> {
    const { error } = await supabase
      .from('active_workout_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Failed to end session:', error);
      throw new Error(error.message);
    }
  },
};
