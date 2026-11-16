-- Lower the free-tier (ad_supported) daily AI compute budget to $0.05/day.
--   ad_supported → $0.05/day  (was $0.20)
--   premium      → unlimited / NULL  (unchanged)
-- A NULL budget signifies "unlimited" — the gate only blocks when a finite
-- budget exists and is met/exceeded. Cost is still accrued for analytics.
--
-- Mirror in the frontend: hooks/useUserQuota.ts TIER_BUDGET_USD must match.

create or replace function public.check_ai_quota_or_fail(
    p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller   uuid := auth.uid();
    v_user_id  uuid := coalesce(p_user_id, v_caller);
    v_row      public.user_quotas;
    v_budget   numeric;  -- NULL = unlimited
begin
    if v_user_id is null then
        raise exception 'unauthenticated' using errcode = '28000';
    end if;
    if v_caller is not null and p_user_id is not null and p_user_id <> v_caller then
        raise exception 'cannot operate on another user' using errcode = '42501';
    end if;

    v_row := public._lock_and_reset_quota(v_user_id);

    v_budget := case v_row.tier_type
                    when 'premium' then null   -- unlimited
                    else 0.05
                end;

    -- Persist the lazy reset (counters/last_reset_date may have moved).
    update public.user_quotas
    set ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        daily_ai_cost      = v_row.daily_ai_cost,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    if v_budget is not null and v_row.daily_ai_cost >= v_budget then
        return jsonb_build_object(
            'allowed',           false,
            'reason',            'quota_exceeded',
            'tier_type',         v_row.tier_type,
            'daily_ai_cost',     v_row.daily_ai_cost,
            'max_daily_budget',  v_budget
        );
    end if;

    return jsonb_build_object(
        'allowed',           true,
        'tier_type',         v_row.tier_type,
        'daily_ai_cost',     v_row.daily_ai_cost,
        'max_daily_budget',  v_budget
    );
end;
$$;

revoke execute on function public.check_ai_quota_or_fail(uuid) from public, anon;
grant   execute on function public.check_ai_quota_or_fail(uuid) to authenticated, service_role;

create or replace function public.record_ai_cost(
    p_cost_usd numeric,
    p_user_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller   uuid := auth.uid();
    v_user_id  uuid := coalesce(p_user_id, v_caller);
    v_row      public.user_quotas;
    v_budget   numeric;  -- NULL = unlimited
begin
    if v_user_id is null then
        raise exception 'unauthenticated' using errcode = '28000';
    end if;
    if v_caller is not null and p_user_id is not null and p_user_id <> v_caller then
        raise exception 'cannot operate on another user' using errcode = '42501';
    end if;
    if p_cost_usd is null or p_cost_usd < 0 then
        raise exception 'cost must be non-negative' using errcode = '22023';
    end if;

    v_row := public._lock_and_reset_quota(v_user_id);
    v_row.daily_ai_cost := v_row.daily_ai_cost + p_cost_usd;

    update public.user_quotas
    set daily_ai_cost      = v_row.daily_ai_cost,
        ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    v_budget := case v_row.tier_type
                    when 'premium' then null   -- unlimited
                    else 0.05
                end;

    return jsonb_build_object(
        'daily_ai_cost',    v_row.daily_ai_cost,
        'max_daily_budget', v_budget,
        'over_cap',         (v_budget is not null and v_row.daily_ai_cost >= v_budget),
        'tier_type',        v_row.tier_type
    );
end;
$$;

revoke execute on function public.record_ai_cost(numeric, uuid) from public, anon;
grant   execute on function public.record_ai_cost(numeric, uuid) to authenticated, service_role;
