-- Migration 009: Nutrition logs for Smart Log tab

-- Ensure UUID generation is available
create extension if not exists pgcrypto;

create table if not exists nutrition_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null default current_date,
  raw_text text not null,
  calories integer not null,
  protein integer not null,
  carbs integer not null,
  fats integer not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_nutrition_logs_user_date
  on nutrition_logs(user_id, date desc);

create index if not exists idx_nutrition_logs_user_created_at
  on nutrition_logs(user_id, created_at desc);

alter table nutrition_logs enable row level security;

drop policy if exists "nutrition logs: owner read" on nutrition_logs;
create policy "nutrition logs: owner read"
on nutrition_logs for select
using (auth.uid() = user_id);

drop policy if exists "nutrition logs: owner insert" on nutrition_logs;
create policy "nutrition logs: owner insert"
on nutrition_logs for insert
with check (auth.uid() = user_id);

drop policy if exists "nutrition logs: owner update" on nutrition_logs;
create policy "nutrition logs: owner update"
on nutrition_logs for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "nutrition logs: owner delete" on nutrition_logs;
create policy "nutrition logs: owner delete"
on nutrition_logs for delete
using (auth.uid() = user_id);
