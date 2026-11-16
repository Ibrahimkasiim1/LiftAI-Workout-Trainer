-- ============================================================================
-- FIX: Allow quick_workout in saved_workouts.workout_type
-- ============================================================================

ALTER TABLE saved_workouts
  DROP CONSTRAINT IF EXISTS saved_workouts_workout_type_check;

ALTER TABLE saved_workouts
  ADD CONSTRAINT saved_workouts_workout_type_check
  CHECK (
    workout_type IN (
      'main_plan',
      'main_plan_edit',
      'extra_workout',
      'replacement_workout',
      'quick_workout'
    )
  );
