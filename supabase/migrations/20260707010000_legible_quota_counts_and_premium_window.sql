-- Legible free-tier quota + premium soft cap.
--
-- FREE (ad_supported): enforcement moves from an invisible dollar meter to
-- countable daily allowances the UI can show next to each feature:
--   - 3 coach messages / day   (ai_chats_today,     feature 'chat')
--   - 1 AI meal log / day      (meals_logged_today, feature 'meal')
--   - $0.10/day cost BACKSTOP  (was $0.05 — raised so the 3-message allowance
--     is never cut short by cost; voice/swaps still ride the backstop)
-- Counts reset at the user's local midnight (same lazy reset as before).
--
-- PREMIUM: marketing stays "unlimited", but a soft abuse cap of $0.80 per
-- 12-hour window stops a runaway session from burning real money. When hit,
-- the check returns reason 'premium_cooldown' + retry_at so the app can say
-- "the coach needs a breather — back at <time>" instead of an upgrade pitch.
--
-- The count increments happen INSIDE check_ai_quota_or_fail (pre-flight,
-- once per user action) — record_ai_cost fires once per LLM call within a
-- turn, so incrementing there would multi-count a single message.
--
-- Mirror in the frontend: hooks/useUserQuota.ts FREE_TIER_LIMITS must match.
-- Mirror in the backend: middleware/quotaGate.ts passes p_feature per route.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Premium 12-hour window columns
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_quotas
    add column if not exists window_ai_cost numeric not null default 0,
    add column if not exists window_started_at timestamptz not null default now();

comment on column public.user_quotas.window_ai_cost is
    'AI cost accrued in the current 12h window (premium soft-cap accounting).';
comment on column public.user_quotas.window_started_at is
    'Start of the current 12h cost window; resets lazily when 12h have elapsed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. check_ai_quota_or_fail(p_user_id, p_feature)
--    The old 1-arg overload must be dropped: keeping both makes bare calls
--    ambiguous. The new signature defaults p_feature, so existing callers that
--    only pass p_user_id keep working unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.check_ai_quota_or_fail(uuid);

create function public.check_ai_quota_or_fail(
    p_user_id uuid default null,
    p_feature text default null   -- 'chat' | 'meal' | null (cost backstop only)
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller      uuid := auth.uid();
    v_user_id     uuid := coalesce(p_user_id, v_caller);
    v_row         public.user_quotas;
    v_budget      numeric;      -- NULL = no daily cost cap
    v_chat_limit  int;          -- NULL = unlimited
    v_meal_limit  int;
    v_win_cap     numeric := 0.80;
    v_win_len     interval := interval '12 hours';
begin
    if v_user_id is null then
        raise exception 'unauthenticated' using errcode = '28000';
    end if;
    if v_caller is not null and p_user_id is not null and p_user_id <> v_caller then
        raise exception 'cannot operate on another user' using errcode = '42501';
    end if;
    if p_feature is not null and p_feature not in ('chat', 'meal') then
        raise exception 'invalid feature: %', p_feature using errcode = '22023';
    end if;

    v_row := public._lock_and_reset_quota(v_user_id);

    -- Lazy 12h window roll-over (all tiers accrue; only premium is capped).
    if now() >= v_row.window_started_at + v_win_len then
        v_row.window_ai_cost := 0;
        v_row.window_started_at := now();
    end if;

    if v_row.tier_type = 'premium' then
        v_budget := null; v_chat_limit := null; v_meal_limit := null;
    else
        v_budget := 0.10; v_chat_limit := 3; v_meal_limit := 1;
    end if;

    -- ── Premium soft cap: $0.80 per 12h window ──────────────────────────────
    if v_row.tier_type = 'premium' and v_row.window_ai_cost >= v_win_cap then
        update public.user_quotas
        set window_ai_cost = v_row.window_ai_cost,
            window_started_at = v_row.window_started_at,
            daily_ai_cost = v_row.daily_ai_cost,
            ai_chats_today = v_row.ai_chats_today,
            meals_logged_today = v_row.meals_logged_today,
            auto_swaps_today = v_row.auto_swaps_today,
            last_reset_date = v_row.last_reset_date,
            updated_at = now()
        where user_id = v_user_id;
        return jsonb_build_object(
            'allowed',   false,
            'reason',    'premium_cooldown',
            'tier_type', v_row.tier_type,
            'retry_at',  v_row.window_started_at + v_win_len
        );
    end if;

    -- ── Free tier: countable allowances first, cost backstop second ─────────
    if v_row.tier_type <> 'premium' then
        if p_feature = 'chat' and v_row.ai_chats_today >= v_chat_limit then
            update public.user_quotas set updated_at = now(),
                ai_chats_today = v_row.ai_chats_today,
                meals_logged_today = v_row.meals_logged_today,
                auto_swaps_today = v_row.auto_swaps_today,
                daily_ai_cost = v_row.daily_ai_cost,
                window_ai_cost = v_row.window_ai_cost,
                window_started_at = v_row.window_started_at,
                last_reset_date = v_row.last_reset_date
            where user_id = v_user_id;
            return jsonb_build_object(
                'allowed', false, 'reason', 'chat_limit',
                'tier_type', v_row.tier_type,
                'chats_used', v_row.ai_chats_today, 'chats_limit', v_chat_limit,
                'meals_used', v_row.meals_logged_today, 'meals_limit', v_meal_limit
            );
        end if;
        if p_feature = 'meal' and v_row.meals_logged_today >= v_meal_limit then
            update public.user_quotas set updated_at = now(),
                ai_chats_today = v_row.ai_chats_today,
                meals_logged_today = v_row.meals_logged_today,
                auto_swaps_today = v_row.auto_swaps_today,
                daily_ai_cost = v_row.daily_ai_cost,
                window_ai_cost = v_row.window_ai_cost,
                window_started_at = v_row.window_started_at,
                last_reset_date = v_row.last_reset_date
            where user_id = v_user_id;
            return jsonb_build_object(
                'allowed', false, 'reason', 'meal_limit',
                'tier_type', v_row.tier_type,
                'chats_used', v_row.ai_chats_today, 'chats_limit', v_chat_limit,
                'meals_used', v_row.meals_logged_today, 'meals_limit', v_meal_limit
            );
        end if;
        if v_budget is not null and v_row.daily_ai_cost >= v_budget then
            update public.user_quotas set updated_at = now(),
                ai_chats_today = v_row.ai_chats_today,
                meals_logged_today = v_row.meals_logged_today,
                auto_swaps_today = v_row.auto_swaps_today,
                daily_ai_cost = v_row.daily_ai_cost,
                window_ai_cost = v_row.window_ai_cost,
                window_started_at = v_row.window_started_at,
                last_reset_date = v_row.last_reset_date
            where user_id = v_user_id;
            return jsonb_build_object(
                'allowed', false, 'reason', 'quota_exceeded',
                'tier_type', v_row.tier_type,
                'daily_ai_cost', v_row.daily_ai_cost,
                'max_daily_budget', v_budget,
                'chats_used', v_row.ai_chats_today, 'chats_limit', v_chat_limit,
                'meals_used', v_row.meals_logged_today, 'meals_limit', v_meal_limit
            );
        end if;
    end if;

    -- Allowed: consume the countable allowance now (one user action = one
    -- count; the per-LLM-call record_ai_cost path must NOT touch counts).
    if p_feature = 'chat' then
        v_row.ai_chats_today := v_row.ai_chats_today + 1;
    elsif p_feature = 'meal' then
        v_row.meals_logged_today := v_row.meals_logged_today + 1;
    end if;

    update public.user_quotas
    set ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        daily_ai_cost      = v_row.daily_ai_cost,
        window_ai_cost     = v_row.window_ai_cost,
        window_started_at  = v_row.window_started_at,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    return jsonb_build_object(
        'allowed',          true,
        'tier_type',        v_row.tier_type,
        'daily_ai_cost',    v_row.daily_ai_cost,
        'max_daily_budget', v_budget,
        'chats_used',       v_row.ai_chats_today,
        'chats_limit',      v_chat_limit,
        'meals_used',       v_row.meals_logged_today,
        'meals_limit',      v_meal_limit
    );
end;
$$;

revoke execute on function public.check_ai_quota_or_fail(uuid, text) from public, anon;
grant   execute on function public.check_ai_quota_or_fail(uuid, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. record_ai_cost — same signature, now also accrues the 12h window.
-- ─────────────────────────────────────────────────────────────────────────────

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
    v_budget   numeric;
    v_win_len  interval := interval '12 hours';
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

    if now() >= v_row.window_started_at + v_win_len then
        v_row.window_ai_cost := 0;
        v_row.window_started_at := now();
    end if;

    v_row.daily_ai_cost  := v_row.daily_ai_cost + p_cost_usd;
    v_row.window_ai_cost := v_row.window_ai_cost + p_cost_usd;

    update public.user_quotas
    set daily_ai_cost      = v_row.daily_ai_cost,
        window_ai_cost     = v_row.window_ai_cost,
        window_started_at  = v_row.window_started_at,
        ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    v_budget := case v_row.tier_type when 'premium' then null else 0.10 end;

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
