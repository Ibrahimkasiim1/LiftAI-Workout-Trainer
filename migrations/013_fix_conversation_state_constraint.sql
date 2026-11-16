-- Migration 013: Replace partial unique INDEX with a real UNIQUE CONSTRAINT
-- on (thread_id, checkpoint_ns, checkpoint_id) so PostgREST's onConflict
-- specifier in `SupabaseConversationStateCheckpointer.put()` can resolve.
--
-- Background:
--   Migration 012 created `uq_conversation_state_checkpoint` as a PARTIAL
--   unique index (`WHERE thread_id IS NOT NULL AND checkpoint_id IS NOT NULL`).
--   PostgREST/Supabase's `.upsert(..., { onConflict: "..." })` translates to
--   Postgres `ON CONFLICT (cols)` index inference, which CANNOT infer a
--   partial index unless the predicate is also supplied — producing:
--     "there is no unique or exclusion constraint matching the
--      ON CONFLICT specification"
--
--   A named, full UNIQUE CONSTRAINT removes the inference ambiguity and is
--   matched directly by `onConflict: "thread_id,checkpoint_ns,checkpoint_id"`
--   in conversationStateCheckpointer.ts.
--
-- Safety notes:
--   * UNIQUE in Postgres treats NULLs as distinct (default NULLS DISTINCT),
--     so legacy rows with NULL thread_id / checkpoint_id remain valid and
--     coexist alongside the new checkpoint rows.
--   * The 012 partial index already enforced uniqueness for the populated
--     tuple, so adding the constraint cannot find pre-existing duplicates.
--   * DROP CONSTRAINT IF EXISTS keeps this migration idempotent / re-runnable.

ALTER TABLE public.conversation_state DROP CONSTRAINT IF EXISTS unique_checkpoint_tuple;
ALTER TABLE public.conversation_state ADD CONSTRAINT unique_checkpoint_tuple UNIQUE (thread_id, checkpoint_ns, checkpoint_id);
