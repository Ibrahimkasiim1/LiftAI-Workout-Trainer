-- Allow users to train in more than one place. The onboarding location step is
-- now multi-select (Home + Gym => 'hybrid'); available_equipment remains the
-- source of truth for what the user can actually use.
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_location_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_location_check
  CHECK (location = ANY (ARRAY['home'::text, 'gym'::text, 'hybrid'::text]));
