-- Exercise enrichment
-- ===================
-- Adds (a) cleaned/disambiguated equipment fields the UI can show users, and
-- (b) AI-generated biomechanics metadata. Both feed a much richer embedding
-- document (see backend/src/services/exerciseEnrichment.ts), which fixes the
-- previously weak vectors that were built from name + muscle + equipment only.
--
-- All columns are nullable and additive — safe to apply against a live table;
-- existing rows keep working until the enrichment backfill populates them.

alter table public.exercises
  add column if not exists equipment_canonical text,
  add column if not exists equipment_display   text,
  add column if not exists enrichment          jsonb,
  add column if not exists enriched_at         timestamptz,
  add column if not exists enrichment_model    text;

-- Equipment filtering / faceting happens on the canonical bucket.
create index if not exists exercises_equipment_canonical_idx
  on public.exercises (equipment_canonical);

comment on column public.exercises.equipment_canonical is
  'Cleaned equipment bucket (e.g. machine, dumbbell, body weight) for filtering/matching. Derived from raw equipment + exercise name.';
comment on column public.exercises.equipment_display is
  'User-facing equipment label, disambiguated using the exercise name (e.g. raw "leverage machine" + "Lever Chest Press" -> "Chest Press Machine").';
comment on column public.exercises.enrichment is
  'AI-generated structured metadata: movement_pattern, mechanics, force, unilateral, primary_goal, joint_friendly[], aliases[], summary.';
comment on column public.exercises.enrichment_model is
  'Model name that produced the enrichment row; used to detect/refresh stale enrichments.';
