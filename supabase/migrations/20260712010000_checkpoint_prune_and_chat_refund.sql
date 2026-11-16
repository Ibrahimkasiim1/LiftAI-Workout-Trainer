-- Checkpoint retention + chat-allowance refund.
--
-- 1. prune_conversation_checkpoints — LangGraph writes one conversation_state
--    row per super-step (a single chat turn = ~5-7 rows) and nothing ever
--    deleted old ones. Only the LATEST checkpoint per thread is read at
--    runtime (the checkpointer's getTuple orders by checkpoint_id desc,
--    limit 1), so keeping a small tail per thread loses nothing. Threads
--    whose rows age out entirely re-bootstrap from the client-sent
--    conversationHistory on the next message, so even full expiry is safe.
--    Called hourly by the backend cleanup scheduler (services/cronJobs.ts).
--
-- 2. refund_chat_count — check_ai_quota_or_fail consumes a free-tier chat
--    count PRE-flight (see 20260707010000). When the turn then fails
--    server-side (graph error/timeout), the user paid one of their 3 daily
--    messages for nothing. The chat routes call this to hand the count back.
--    Depends on _lock_and_reset_quota + the count columns from
--    20260707010000 — apply that migration first (same ordered batch).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. prune_conversation_checkpoints(p_keep_per_thread, p_max_age_days)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.prune_conversation_checkpoints(
    p_keep_per_thread integer default 5,
    p_max_age_days    integer default 45
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_deleted integer;
begin
    if coalesce(p_keep_per_thread, 0) < 1 then
        raise exception 'p_keep_per_thread must be >= 1' using errcode = '22023';
    end if;

    with ranked as (
        select
            ctid as row_ctid,
            row_number() over (
                partition by thread_id, checkpoint_ns
                order by checkpoint_id desc
            ) as rn,
            updated_at
        from public.conversation_state
        where checkpoint_id is not null
    )
    delete from public.conversation_state cs
    using ranked r
    where cs.ctid = r.row_ctid
      and (
        r.rn > p_keep_per_thread
        or (
            p_max_age_days is not null
            and r.updated_at < now() - make_interval(days => p_max_age_days)
            -- never age out a thread's newest checkpoint alone on time —
            -- resume still works via client-history bootstrap, but keeping
            -- the head row is cheap and preserves lastAgent continuity for
            -- users who come back to an old conversation.
            and r.rn > 1
        )
      );

    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke execute on function public.prune_conversation_checkpoints(integer, integer) from public, anon, authenticated;
grant   execute on function public.prune_conversation_checkpoints(integer, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. refund_chat_count(p_user_id)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.refund_chat_count(
    p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.user_quotas;
begin
    if p_user_id is null then
        raise exception 'p_user_id is required' using errcode = '22023';
    end if;

    -- Same lazy-reset lock as check_ai_quota_or_fail so a refund that lands
    -- just after local midnight can't decrement the fresh day's counter for
    -- yesterday's failure (the reset zeroes it first; floor(0) then no-ops).
    v_row := public._lock_and_reset_quota(p_user_id);

    if v_row.ai_chats_today > 0 then
        v_row.ai_chats_today := v_row.ai_chats_today - 1;
    end if;

    update public.user_quotas
    set ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        daily_ai_cost      = v_row.daily_ai_cost,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = p_user_id;

    return jsonb_build_object('chats_used', v_row.ai_chats_today);
end;
$$;

-- Service-role only: refunds are a backend-decided event (turn failed), never
-- something the client may trigger directly.
revoke execute on function public.refund_chat_count(uuid) from public, anon, authenticated;
grant   execute on function public.refund_chat_count(uuid) to service_role;
