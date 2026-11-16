-- Track initial onboarding plan generation lifecycle so clients can resume safely
-- after app termination without issuing duplicate generation requests.

ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS initial_plan_generation_status text NOT NULL DEFAULT 'idle',
ADD COLUMN IF NOT EXISTS initial_plan_generation_started_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_profiles_initial_plan_generation_status_check'
      AND conrelid = 'public.user_profiles'::regclass
  ) THEN
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_initial_plan_generation_status_check
      CHECK (initial_plan_generation_status IN ('idle', 'running', 'failed'));
  END IF;
END
$$;
