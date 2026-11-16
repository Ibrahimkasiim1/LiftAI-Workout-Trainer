import { create } from 'zustand';

export type RestTimerTrigger = 'done_set' | 'resume';

export interface RestTimerContext {
  exerciseId?: string;
  exerciseName: string;
  upcomingSetNumber: number | null;
  restDurationSeconds: number;
  /** How the timer was started. 'done_set' = user tapped Done Set; 'resume' = session restore. */
  trigger?: RestTimerTrigger;
}

interface WorkoutState {
  activeSessionId: string | null;
  workoutStartedAt: number | null;
  restEndTime: number | null;
  restDurationSeconds: number;
  currentExerciseId: string | null;
  currentExerciseName: string | null;
  upcomingSetNumber: number | null;
  /** Source that last started the rest timer. Used to gate the rest-period ad. */
  restTrigger: RestTimerTrigger | null;
  startSession: (sessionId: string) => void;
  endSession: () => void;
  startRestTimer: (context: RestTimerContext) => void;
  clearRestTimer: () => void;
  getRemainingRestSeconds: () => number;
}

export const useWorkoutStore = create<WorkoutState>((set, get) => ({
  activeSessionId: null,
  workoutStartedAt: null,
  restEndTime: null,
  restDurationSeconds: 0,
  currentExerciseId: null,
  currentExerciseName: null,
  upcomingSetNumber: null,
  restTrigger: null,
  startSession: (sessionId) =>
    set((state) => ({
      activeSessionId: sessionId,
      workoutStartedAt: state.workoutStartedAt ?? Date.now(),
    })),
  endSession: () =>
    set({
      activeSessionId: null,
      workoutStartedAt: null,
      restEndTime: null,
      restDurationSeconds: 0,
      currentExerciseId: null,
      currentExerciseName: null,
      upcomingSetNumber: null,
      restTrigger: null,
    }),
  startRestTimer: ({ exerciseId, exerciseName, upcomingSetNumber, restDurationSeconds, trigger }) =>
    set({
      currentExerciseId: exerciseId ?? null,
      currentExerciseName: exerciseName,
      upcomingSetNumber,
      restDurationSeconds,
      restEndTime: Date.now() + restDurationSeconds * 1000,
      restTrigger: trigger ?? null,
    }),
  clearRestTimer: () =>
    set({
      restEndTime: null,
      restDurationSeconds: 0,
      currentExerciseId: null,
      currentExerciseName: null,
      upcomingSetNumber: null,
      restTrigger: null,
    }),
  getRemainingRestSeconds: () => {
    const restEndTime = get().restEndTime;
    if (!restEndTime) return 0;
    return Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
  },
}));
