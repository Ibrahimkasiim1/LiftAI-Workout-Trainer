-- Migration 020: Chat tools expansion
--   1. nutrition_goals — per-user macro targets (server-side, replacing the
--      client-only zustand store so the chat tool can read/write them).
--   2. body_weight_logs — time-series body weight entries the chat can write
--      and the progress tab can chart.
--   3. durational_plan_overrides.daily_workouts_snapshot — JSONB snapshot of
--      affected daily_workouts.exercises_structured rows, captured BEFORE the
--      override is applied so the revert cron can restore the original plan
--      when effective_until passes.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. nutrition_goals
-- ---------------------------------------------------------------------------
create table if not exists nutrition_goals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  calories integer not null check (calories >= 0 and calories <= 20000),
  protein integer not null check (protein >= 0 and protein <= 2000),
  carbs integer not null check (carbs >= 0 and carbs <= 2000),
  fats integer not null check (fats >= 0 and fats <= 1000),
  updated_at timestamptz not null default now()
);

alter table nutrition_goals enable row level security;

drop policy if exists "nutrition_goals: owner read" on nutrition_goals;
create policy "nutrition_goals: owner read"
  on nutrition_goals for select using (auth.uid() = user_id);

drop policy if exists "nutrition_goals: owner upsert" on nutrition_goals;
create policy "nutrition_goals: owner upsert"
  on nutrition_goals for insert with check (auth.uid() = user_id);

drop policy if exists "nutrition_goals: owner update" on nutrition_goals;
create policy "nutrition_goals: owner update"
  on nutrition_goals for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. body_weight_logs
-- ---------------------------------------------------------------------------
create table if not exists body_weight_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weight_kg numeric(6, 2) not null check (weight_kg > 0 and weight_kg < 1000),
  logged_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_body_weight_logs_user_logged_at
  on body_weight_logs(user_id, logged_at desc);

alter table body_weight_logs enable row level security;

drop policy if exists "body_weight_logs: owner read" on body_weight_logs;
create policy "body_weight_logs: owner read"
  on body_weight_logs for select using (auth.uid() = user_id);

drop policy if exists "body_weight_logs: owner insert" on body_weight_logs;
create policy "body_weight_logs: owner insert"
  on body_weight_logs for insert with check (auth.uid() = user_id);

drop policy if exists "body_weight_logs: owner update" on body_weight_logs;
create policy "body_weight_logs: owner update"
  on body_weight_logs for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "body_weight_logs: owner delete" on body_weight_logs;
create policy "body_weight_logs: owner delete"
  on body_weight_logs for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. durational_plan_overrides snapshot column for revert
-- ---------------------------------------------------------------------------
alter table durational_plan_overrides
  add column if not exists daily_workouts_snapshot jsonb;

comment on column durational_plan_overrides.daily_workouts_snapshot is
  'Snapshot of daily_workouts rows mutated when this override was applied. Used by the revert cron to restore the original plan when effective_until elapses. Shape: [{ id, exercises_structured, exercises }].';
