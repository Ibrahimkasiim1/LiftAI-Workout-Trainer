-- Migration 012: Extend conversation_state to back the LangGraph checkpointer.
--
-- We keep the original (user_id, conversation_id, agent, scope, …) columns
-- so any future legacy reader still works, but we relax NOT NULL on the
-- legacy keys so the new checkpoint rows (which only require thread_id +
-- checkpoint identifiers) can coexist.
--
-- New columns store one row per (thread_id, checkpoint_ns, checkpoint_id):
--   * thread_id              — LangGraph thread (chat thread)
--   * checkpoint_ns          — LangGraph namespace (defaults to '')
--   * checkpoint_id          — LangGraph checkpoint UUID
--   * parent_checkpoint_id   — previous checkpoint id in the lineage
--   * checkpoint_type        — serializer tag (typically 'json')
--   * checkpoint             — serialized checkpoint payload (JSONB)
--   * metadata               — checkpoint metadata (JSONB)
--   * pending_writes         — intermediate task writes (JSONB array)
--
-- We also drop the legacy unique (user_id, conversation_id) constraint
-- because a single conversation will now have many checkpoint rows.

alter table conversation_state
  alter column user_id drop not null,
  alter column conversation_id drop not null;

alter table conversation_state
  add column if not exists thread_id text,
  add column if not exists checkpoint_ns text not null default '',
  add column if not exists checkpoint_id text,
  add column if not exists parent_checkpoint_id text,
  add column if not exists checkpoint_type text,
  add column if not exists checkpoint jsonb,
  add column if not exists metadata jsonb,
  add column if not exists pending_writes jsonb not null default '[]'::jsonb;

drop index if exists uq_conversation_state_user_conversation;

create unique index if not exists uq_conversation_state_checkpoint
  on conversation_state(thread_id, checkpoint_ns, checkpoint_id)
  where thread_id is not null and checkpoint_id is not null;

create index if not exists idx_conversation_state_thread_lookup
  on conversation_state(thread_id, checkpoint_ns)
  where thread_id is not null;

create index if not exists idx_conversation_state_thread_latest
  on conversation_state(thread_id, checkpoint_ns, checkpoint_id desc)
  where thread_id is not null and checkpoint_id is not null;
