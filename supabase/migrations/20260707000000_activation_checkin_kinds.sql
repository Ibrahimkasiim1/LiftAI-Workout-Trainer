-- Activation-window coach check-ins (first-week script).
--
-- Three new kinds so the proactive coach can speak first during the window
-- that decides retention:
--   first_workout_followup — right after the user's very first logged session
--   day2_after_first       — 1-3 days later (soreness normalization + today's plan)
--   activation_nudge       — onboarded 3+ days ago, zero sets logged yet
alter table coach_checkins drop constraint coach_checkins_kind_check;
alter table coach_checkins add constraint coach_checkins_kind_check
  check (kind = any (array[
    'ready_to_progress'::text,
    'streak'::text,
    'comeback'::text,
    'stalled_lift'::text,
    'plan_change'::text,
    'first_workout_followup'::text,
    'day2_after_first'::text,
    'activation_nudge'::text
  ]));
