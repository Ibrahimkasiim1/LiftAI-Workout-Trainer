-- chat_conversations — the missing parent table for client-side chat history.
--
-- utils/chatHistory.ts upserts a conversation row before every message insert
-- and BAILS when that fails, so on this project (which only ever had
-- chat_messages) no chat history was persisted at all — every send logged
-- "Error ensuring conversation: PGRST205". The conversation_summaries view
-- reads chat_messages only, so it is unaffected; the sidebar title merge and
-- deleteConversation also read/write this table.
--
-- Client-writable (RLS owner-only), mirroring chat_messages' policies. The
-- backend keeps its own LangGraph state and never touches this table.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY,               -- client-generated UUID (generateConversationId)
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,                        -- auto-title, written after the first turn
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view own conversations" ON chat_conversations
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert own conversations" ON chat_conversations
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Upsert (insert … on conflict update) needs UPDATE too.
DO $$ BEGIN
  CREATE POLICY "Users can update own conversations" ON chat_conversations
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete own conversations" ON chat_conversations
    FOR DELETE TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS chat_conversations_user_updated_idx
  ON chat_conversations (user_id, updated_at DESC);

-- Backfill parents for any messages that were saved before saveMessage grew
-- the ensure-conversation step (or via older builds).
INSERT INTO chat_conversations (id, user_id, created_at, updated_at)
SELECT conversation_id, user_id, min(created_at), max(created_at)
FROM chat_messages
GROUP BY conversation_id, user_id
ON CONFLICT (id) DO NOTHING;
