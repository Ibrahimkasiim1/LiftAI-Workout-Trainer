-- Migration: Conversation State Table

-- Ensure gen_random_uuid() exists
create extension if not exists pgcrypto;

create table if not exists conversation_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  agent text,
  scope text,
  pending_edit_id uuid,
  last_clarification text,
  updated_at timestamptz not null default now()
);

-- Enforce 1 state row per (user, conversation)
create unique index if not exists uq_conversation_state_user_conversation
  on conversation_state(user_id, conversation_id);

-- Useful for "most recent by user"
create index if not exists idx_conversation_state_user_updated
  on conversation_state(user_id, updated_at desc);

-- RLS (critical)
alter table conversation_state enable row level security;

create policy "conversation state: owner read"
on conversation_state for select
using (auth.uid() = user_id);

create policy "conversation state: owner write"
on conversation_state for insert
with check (auth.uid() = user_id);

create policy "conversation state: owner update"
on conversation_state for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "conversation state: owner delete"
on conversation_state for delete
using (auth.uid() = user_id);
