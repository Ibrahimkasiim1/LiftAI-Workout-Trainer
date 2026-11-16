-- Migration: Pending Plan Edits Table (ship-ready)

-- Ensure gen_random_uuid() exists
create extension if not exists pgcrypto;

create table if not exists pending_plan_edits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Enforce 1 pending edit per (user, conversation) so we can UPSERT cleanly
create unique index if not exists uq_pending_edits_user_conversation
  on pending_plan_edits(user_id, conversation_id);

-- Useful for "fallback to most recent"
create index if not exists idx_pending_edits_user_created
  on pending_plan_edits(user_id, created_at desc);

-- RLS (critical)
alter table pending_plan_edits enable row level security;

create policy "pending edits: owner read"
on pending_plan_edits for select
using (auth.uid() = user_id);

create policy "pending edits: owner write"
on pending_plan_edits for insert
with check (auth.uid() = user_id);

create policy "pending edits: owner update"
on pending_plan_edits for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "pending edits: owner delete"
on pending_plan_edits for delete
using (auth.uid() = user_id);
