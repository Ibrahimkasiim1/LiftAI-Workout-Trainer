/**
 * SupabaseConversationStateCheckpointer
 *
 * Custom LangGraph checkpoint saver bound strictly to the `conversation_state`
 * table. Replaces `PostgresSaver` (which writes to its own `langgraph` schema)
 * with a Supabase-client-backed implementation so all chat thread memory lives
 * in our app schema and is RLS-aware in the future.
 *
 * Storage layout (see migrations/012_extend_conversation_state_for_checkpoints.sql):
 *
 *   conversation_state (
 *     thread_id            text,
 *     checkpoint_ns        text not null default '',
 *     checkpoint_id        text,
 *     parent_checkpoint_id text,
 *     checkpoint_type      text,
 *     checkpoint           jsonb,
 *     metadata             jsonb,
 *     pending_writes       jsonb not null default '[]'::jsonb,
 *     ...legacy columns kept nullable...
 *   )
 *   unique(thread_id, checkpoint_ns, checkpoint_id)
 *
 * The legacy (user_id / conversation_id / agent / scope / ...) columns are
 * preserved but optional; we populate user_id / conversation_id when the
 * thread_id follows the `<userUUID>:<conversationId>` convention used by
 * the chat route, which keeps the data RLS-friendly.
 */

import {
    BaseCheckpointSaver,
    type Checkpoint,
    type CheckpointListOptions,
    type CheckpointMetadata,
    type CheckpointPendingWrite,
    type CheckpointTuple,
    type ChannelVersions,
    type PendingWrite,
    type SerializerProtocol,
    WRITES_IDX_MAP,
    copyCheckpoint,
    getCheckpointId,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "conversation_state";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface PendingWriteRow {
    taskId: string;
    channel: string;
    idx: number;
    type: string;
    value: string;
}

interface CheckpointRow {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string | null;
    parent_checkpoint_id: string | null;
    checkpoint_type: string | null;
    checkpoint: unknown;
    metadata: unknown;
    pending_writes: PendingWriteRow[] | null;
}

/**
 * Best-effort split of `<userUUID>:<conversationId>` thread ids.
 * Keeps existing legacy columns populated for analytics / future RLS,
 * but the checkpointer never depends on these for correctness.
 */
function deriveLegacyKeys(threadId: string): {
    userId: string | null;
    conversationId: string | null;
} {
    if (!threadId.includes(":")) {
        return { userId: null, conversationId: threadId };
    }
    const [maybeUser, ...rest] = threadId.split(":");
    const conversationId = rest.join(":") || null;
    if (UUID_RE.test(maybeUser)) {
        return { userId: maybeUser, conversationId };
    }
    return { userId: null, conversationId: threadId };
}

function decodeSerialized(serialized: Uint8Array | string): string {
    if (typeof serialized === "string") return serialized;
    return new TextDecoder().decode(serialized);
}

export class SupabaseConversationStateCheckpointer extends BaseCheckpointSaver {
    constructor(private readonly client: SupabaseClient, serde?: SerializerProtocol) {
        super(serde);
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        const threadId = config.configurable?.thread_id as string | undefined;
        const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
        const checkpointId = getCheckpointId(config);

        if (!threadId) return undefined;

        let row: CheckpointRow | null = null;

        if (checkpointId) {
            const { data, error } = await this.client
                .from(TABLE)
                .select(
                    "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint, metadata, pending_writes"
                )
                .eq("thread_id", threadId)
                .eq("checkpoint_ns", checkpointNs)
                .eq("checkpoint_id", checkpointId)
                .maybeSingle();
            if (error) {
                throw new Error(`[ConversationStateCheckpointer] getTuple by id failed: ${error.message}`);
            }
            row = (data ?? null) as CheckpointRow | null;
        } else {
            const { data, error } = await this.client
                .from(TABLE)
                .select(
                    "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint, metadata, pending_writes"
                )
                .eq("thread_id", threadId)
                .eq("checkpoint_ns", checkpointNs)
                .not("checkpoint_id", "is", null)
                .order("checkpoint_id", { ascending: false })
                .limit(1);
            if (error) {
                throw new Error(`[ConversationStateCheckpointer] getTuple latest failed: ${error.message}`);
            }
            row = ((data ?? [])[0] as CheckpointRow | undefined) ?? null;
        }

        if (!row || !row.checkpoint_id || row.checkpoint == null) {
            return undefined;
        }

        return this.rowToTuple(row);
    }

    async *list(
        config: RunnableConfig,
        options?: CheckpointListOptions
    ): AsyncGenerator<CheckpointTuple> {
        const threadId = config.configurable?.thread_id as string | undefined;
        if (!threadId) return;

        const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
        const { before, limit, filter } = options ?? {};

        let query = this.client
            .from(TABLE)
            .select(
                "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint, metadata, pending_writes"
            )
            .eq("thread_id", threadId)
            .eq("checkpoint_ns", checkpointNs)
            .not("checkpoint_id", "is", null)
            .order("checkpoint_id", { ascending: false });

        const beforeId = before?.configurable?.checkpoint_id as string | undefined;
        if (beforeId) {
            query = query.lt("checkpoint_id", beforeId);
        }
        if (typeof limit === "number" && limit > 0) {
            query = query.limit(limit);
        }

        const { data, error } = await query;
        if (error) {
            throw new Error(`[ConversationStateCheckpointer] list failed: ${error.message}`);
        }

        for (const raw of (data ?? []) as CheckpointRow[]) {
            const tuple = await this.rowToTuple(raw);
            if (!tuple) continue;
            if (filter && tuple.metadata) {
                const meta = tuple.metadata as Record<string, unknown>;
                const matchesFilter = Object.entries(filter).every(
                    ([key, value]) => meta[key] === value
                );
                if (!matchesFilter) continue;
            }
            yield tuple;
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        _newVersions: ChannelVersions
    ): Promise<RunnableConfig> {
        const threadId = config.configurable?.thread_id as string | undefined;
        if (!threadId) {
            throw new Error(
                '[ConversationStateCheckpointer] put: missing required "thread_id" in configurable'
            );
        }

        const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
        const parentCheckpointId =
            (config.configurable?.checkpoint_id as string | undefined) ?? null;

        const prepared = copyCheckpoint(checkpoint);
        const [checkpointType, serializedCheckpoint] = await this.serde.dumpsTyped(prepared);
        const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);

        const checkpointJson = JSON.parse(decodeSerialized(serializedCheckpoint));
        const metadataJson = JSON.parse(decodeSerialized(serializedMetadata));

        const { userId, conversationId } = deriveLegacyKeys(threadId);

        const row: Record<string, unknown> = {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpoint.id,
            parent_checkpoint_id: parentCheckpointId,
            checkpoint_type: checkpointType,
            checkpoint: checkpointJson,
            metadata: metadataJson,
            pending_writes: [],
            updated_at: new Date().toISOString(),
        };

        if (userId) row.user_id = userId;
        if (conversationId) row.conversation_id = conversationId;

        // The onConflict tuple MUST match the named UNIQUE constraint
        // `unique_checkpoint_tuple` defined in
        // migrations/013_fix_conversation_state_constraint.sql:
        //   UNIQUE (thread_id, checkpoint_ns, checkpoint_id)
        // PostgREST resolves ON CONFLICT via constraint/index inference, so
        // changing either side without the other will resurrect the
        // "no unique or exclusion constraint matching the ON CONFLICT
        // specification" error.
        const { error } = await this.client
            .from(TABLE)
            .upsert(row, { onConflict: "thread_id,checkpoint_ns,checkpoint_id" });
        if (error) {
            throw new Error(
                `[ConversationStateCheckpointer] put failed: ${error.message}`
            );
        }

        return {
            configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNs,
                checkpoint_id: checkpoint.id,
            },
        };
    }

    async putWrites(
        config: RunnableConfig,
        writes: PendingWrite[],
        taskId: string
    ): Promise<void> {
        const threadId = config.configurable?.thread_id as string | undefined;
        if (!threadId) {
            throw new Error(
                '[ConversationStateCheckpointer] putWrites: missing required "thread_id" in configurable'
            );
        }
        const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
        const checkpointId = config.configurable?.checkpoint_id as string | undefined;
        if (!checkpointId) {
            throw new Error(
                '[ConversationStateCheckpointer] putWrites: missing required "checkpoint_id" in configurable'
            );
        }

        const { data: existingRow, error: fetchError } = await this.client
            .from(TABLE)
            .select("pending_writes")
            .eq("thread_id", threadId)
            .eq("checkpoint_ns", checkpointNs)
            .eq("checkpoint_id", checkpointId)
            .maybeSingle();
        if (fetchError) {
            throw new Error(
                `[ConversationStateCheckpointer] putWrites read failed: ${fetchError.message}`
            );
        }

        const existing: PendingWriteRow[] = Array.isArray(existingRow?.pending_writes)
            ? (existingRow!.pending_writes as PendingWriteRow[])
            : [];
        const seen = new Set(existing.map((w) => `${w.taskId}|${w.idx}`));

        const newRowsRaw = await Promise.all(
            writes.map(async ([channel, value], localIdx) => {
                const idx = (WRITES_IDX_MAP as Record<string, number>)[channel] ?? localIdx;
                if (idx >= 0 && seen.has(`${taskId}|${idx}`)) {
                    return null;
                }
                const [type, serialized] = await this.serde.dumpsTyped(value);
                return {
                    taskId,
                    channel,
                    idx,
                    type,
                    value: decodeSerialized(serialized),
                } as PendingWriteRow;
            })
        );
        const newRows = newRowsRaw.filter((r): r is PendingWriteRow => r != null);

        if (newRows.length === 0) return;

        const merged = [...existing, ...newRows];

        const { error: updateError } = await this.client
            .from(TABLE)
            .update({ pending_writes: merged, updated_at: new Date().toISOString() })
            .eq("thread_id", threadId)
            .eq("checkpoint_ns", checkpointNs)
            .eq("checkpoint_id", checkpointId);
        if (updateError) {
            throw new Error(
                `[ConversationStateCheckpointer] putWrites update failed: ${updateError.message}`
            );
        }
    }

    async deleteThread(threadId: string): Promise<void> {
        const { error } = await this.client
            .from(TABLE)
            .delete()
            .eq("thread_id", threadId)
            .not("checkpoint_id", "is", null);
        if (error) {
            throw new Error(
                `[ConversationStateCheckpointer] deleteThread failed: ${error.message}`
            );
        }
    }

    private async rowToTuple(row: CheckpointRow): Promise<CheckpointTuple | undefined> {
        if (!row.checkpoint_id || row.checkpoint == null) return undefined;

        const checkpointType = row.checkpoint_type ?? "json";
        const checkpoint = (await this.serde.loadsTyped(
            checkpointType,
            JSON.stringify(row.checkpoint)
        )) as Checkpoint;
        const metadata =
            row.metadata == null
                ? (undefined as unknown as CheckpointMetadata)
                : ((await this.serde.loadsTyped(
                      "json",
                      JSON.stringify(row.metadata)
                  )) as CheckpointMetadata);

        const pendingWritesRaw = Array.isArray(row.pending_writes) ? row.pending_writes : [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
            pendingWritesRaw.map(async (pw) => {
                const value = await this.serde.loadsTyped(pw.type ?? "json", pw.value);
                return [pw.taskId, pw.channel, value] as CheckpointPendingWrite;
            })
        );

        const tuple: CheckpointTuple = {
            config: {
                configurable: {
                    thread_id: row.thread_id,
                    checkpoint_ns: row.checkpoint_ns,
                    checkpoint_id: row.checkpoint_id,
                },
            },
            checkpoint,
            metadata,
            pendingWrites,
        };

        if (row.parent_checkpoint_id) {
            tuple.parentConfig = {
                configurable: {
                    thread_id: row.thread_id,
                    checkpoint_ns: row.checkpoint_ns,
                    checkpoint_id: row.parent_checkpoint_id,
                },
            };
        }

        return tuple;
    }
}

export function createConversationStateCheckpointer(
    client: SupabaseClient,
    serde?: SerializerProtocol
): SupabaseConversationStateCheckpointer {
    return new SupabaseConversationStateCheckpointer(client, serde);
}
