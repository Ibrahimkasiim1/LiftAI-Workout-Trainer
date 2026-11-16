-- First-workout training liability consent: durable server-side record of
-- when the user accepted the AI-coaching risk disclaimer (client stores a
-- versioned copy in AsyncStorage and stamps a PostHog event; this column is
-- the copy that survives reinstalls and device changes).
--
-- Written by the client on acceptance (ExerciseTikTokScroll →
-- LiabilityConsentSheet). Owner-update is already allowed by the existing
-- user_profiles RLS policies.

alter table public.user_profiles
  add column if not exists liability_accepted_at timestamptz;

comment on column public.user_profiles.liability_accepted_at is
  'When the user accepted the first-workout AI-training liability disclaimer (consent version tracked client-side).';
