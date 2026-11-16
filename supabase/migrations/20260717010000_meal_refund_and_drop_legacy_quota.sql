-- Meal-allowance refund + legacy quota RPC removal.
--
-- 1. refund_meal_count — the meal twin of refund_chat_count (20260712010000).
--    check_ai_quota_or_fail consumes the free tier's single daily AI meal log
--    PRE-flight; when /nutrition/log then fails server-side (invalid body,
--    insert error, unexpected throw) the user paid their only log for nothing.
--    The nutrition route calls this to hand the count back. NOT called on the
--    heuristic-parse fallback — the user still received a saved log there.
--
-- 2. Drop increment_quota_or_fail — the pre-20260707010000 quota path. No
--    backend or app code references it anymore, and as a SECURITY DEFINER
--    function executable by any signed-in user it is pure attack surface
--    (flagged by the Supabase security advisor).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. refund_meal_count(p_user_id)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.refund_meal_count(
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

    if v_row.meals_logged_today > 0 then
        v_row.meals_logged_today := v_row.meals_logged_today - 1;
    end if;

    update public.user_quotas
    set ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        daily_ai_cost      = v_row.daily_ai_cost,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = p_user_id;

    return jsonb_build_object('meals_used', v_row.meals_logged_today);
end;
$$;

-- Service-role only: refunds are a backend-decided event (request failed),
-- never something the client may trigger directly.
revoke execute on function public.refund_meal_count(uuid) from public, anon, authenticated;
grant   execute on function public.refund_meal_count(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Drop the dead legacy quota RPC
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.increment_quota_or_fail(text, uuid);
