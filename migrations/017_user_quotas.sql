-- Migration 017: User quotas, tier tracking, and AI cost gating
--
-- Introduces:
--   * public.user_quotas       — per-user counters, tier, daily cost
--   * public.model_pricing     — $/1M token map; cost map = data, not code
--   * RPCs (security definer):
--       - increment_quota_or_fail(action, user_id?) → atomic gate, lazy UTC reset
--       - record_ai_cost(cost_usd, user_id?)        → post-flight cost accrual
--       - set_user_tier(user_id, tier)              → service-role only (webhook)
--   * Trigger: auto-create quota row on auth.users insert
--   * Backfill for existing users
--
-- Hard limits per day (ad_supported tier):
--   ai_chats_today      ≤ 10
--   meals_logged_today  ≤ 6
--   auto_swaps_today    ≤ 5
--   daily_ai_cost       ≤ $0.20 (post-flight cap; next request blocks once exceeded)
--
-- Premium tier bypasses all limits; counters still increment for analytics.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.user_quotas (
    user_id              uuid primary key references auth.users(id) on delete cascade,
    tier_type            text not null default 'ad_supported'
                          check (tier_type in ('premium', 'ad_supported')),
    ai_chats_today       integer not null default 0 check (ai_chats_today >= 0),
    meals_logged_today   integer not null default 0 check (meals_logged_today >= 0),
    auto_swaps_today     integer not null default 0 check (auto_swaps_today >= 0),
    daily_ai_cost        numeric(10, 6) not null default 0 check (daily_ai_cost >= 0),
    last_reset_date      date not null default (now() at time zone 'UTC')::date,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

comment on table public.user_quotas is
    'Per-user AI usage counters and subscription tier. Client-readable, server-writable only.';

create table if not exists public.model_pricing (
    model_name                 text primary key,
    provider                   text not null,
    input_price_per_million    numeric(10, 4) not null check (input_price_per_million >= 0),
    output_price_per_million   numeric(10, 4) not null check (output_price_per_million >= 0),
    updated_at                 timestamptz not null default now()
);

comment on table public.model_pricing is
    'USD per 1M tokens. Update rows here when provider pricing changes — no code changes needed.';

-- Seed with models the app currently uses. Verify against current published pricing
-- before relying on cost gating in production.
insert into public.model_pricing (model_name, provider, input_price_per_million, output_price_per_million) values
    ('gpt-4o-mini',           'openai',    0.150,  0.600),
    ('gpt-4o',                'openai',    2.500, 10.000),
    ('gemini-2.0-flash',      'google',    0.075,  0.300),
    ('gemini-2.0-flash-001',  'google',    0.075,  0.300),
    ('gemini-1.5-flash',      'google',    0.075,  0.300),
    ('gemini-1.5-flash-002',  'google',    0.075,  0.300),
    ('gemini-1.5-pro',        'google',    1.250,  5.000),
    ('claude-sonnet-4-6',     'anthropic', 3.000, 15.000),
    ('claude-haiku-4-5',      'anthropic', 1.000,  5.000),
    ('claude-opus-4-7',       'anthropic',15.000, 75.000)
on conflict (model_name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- PK on user_id is sufficient for single-row lookups; no extra indexes needed.

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_quotas    enable row level security;
alter table public.model_pricing  enable row level security;

-- Clients: SELECT own row only. No INSERT / UPDATE / DELETE policies = blocked for non-service roles.
drop policy if exists "user_quotas_select_own" on public.user_quotas;
create policy "user_quotas_select_own"
    on public.user_quotas
    for select
    to authenticated
    using (user_id = auth.uid());

-- model_pricing: server-only. Explicit deny-all so the linter sees an intentional
-- policy (service role bypasses RLS, so writes from trusted code still work).
drop policy if exists "model_pricing_no_client_access" on public.model_pricing;
create policy "model_pricing_no_client_access"
    on public.model_pricing
    for all
    to authenticated, anon
    using (false)
    with check (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: lock + lazy reset
-- ─────────────────────────────────────────────────────────────────────────────

-- Internal helper. Locks the row, applies UTC daily reset if needed, returns
-- the post-reset row to the caller. Caller mutates and writes back.
create or replace function public._lock_and_reset_quota(p_user_id uuid)
returns public.user_quotas
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_today date := (now() at time zone 'UTC')::date;
    v_row   public.user_quotas;
begin
    select * into v_row
    from public.user_quotas
    where user_id = p_user_id
    for update;

    if not found then
        -- Self-heal: trigger may not have fired for users created before this migration.
        insert into public.user_quotas (user_id, tier_type, last_reset_date)
        values (p_user_id, 'ad_supported', v_today)
        on conflict (user_id) do nothing
        returning * into v_row;

        if not found then
            -- Concurrent insert won — re-read with the lock.
            select * into v_row
            from public.user_quotas
            where user_id = p_user_id
            for update;
        end if;
    end if;

    if v_row.last_reset_date < v_today then
        v_row.ai_chats_today      := 0;
        v_row.meals_logged_today  := 0;
        v_row.auto_swaps_today    := 0;
        v_row.daily_ai_cost       := 0;
        v_row.last_reset_date     := v_today;
    end if;

    return v_row;
end;
$$;

revoke execute on function public._lock_and_reset_quota(uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: increment_quota_or_fail
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.increment_quota_or_fail(
    p_action_type text,
    p_user_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller uuid := auth.uid();
    v_user_id uuid := coalesce(p_user_id, v_caller);
    v_row    public.user_quotas;

    -- Hard limits (ad_supported)
    c_chat_limit constant integer := 10;
    c_meal_limit constant integer := 6;
    c_swap_limit constant integer := 5;
    c_cost_cap   constant numeric := 0.20;
begin
    -- Auth: must be either an authenticated client (auth.uid() not null and matches),
    -- or service_role (auth.uid() is null) passing an explicit p_user_id.
    if v_user_id is null then
        raise exception 'unauthenticated' using errcode = '28000';
    end if;

    if v_caller is not null and p_user_id is not null and p_user_id <> v_caller then
        raise exception 'cannot operate on another user'
            using errcode = '42501';
    end if;

    if p_action_type not in ('chat', 'meal_log', 'auto_swap') then
        raise exception 'invalid action_type: %', p_action_type
            using errcode = '22023';
    end if;

    v_row := public._lock_and_reset_quota(v_user_id);

    -- Premium bypass: still increment for analytics, never fail.
    if v_row.tier_type = 'premium' then
        case p_action_type
            when 'chat'      then v_row.ai_chats_today      := v_row.ai_chats_today + 1;
            when 'meal_log'  then v_row.meals_logged_today  := v_row.meals_logged_today + 1;
            when 'auto_swap' then v_row.auto_swaps_today    := v_row.auto_swaps_today + 1;
        end case;

        update public.user_quotas
        set ai_chats_today     = v_row.ai_chats_today,
            meals_logged_today = v_row.meals_logged_today,
            auto_swaps_today   = v_row.auto_swaps_today,
            daily_ai_cost      = v_row.daily_ai_cost,
            last_reset_date    = v_row.last_reset_date,
            updated_at         = now()
        where user_id = v_user_id;

        return jsonb_build_object(
            'allowed',            true,
            'tier_type',          'premium',
            'ai_chats_today',     v_row.ai_chats_today,
            'meals_logged_today', v_row.meals_logged_today,
            'auto_swaps_today',   v_row.auto_swaps_today,
            'daily_ai_cost',      v_row.daily_ai_cost
        );
    end if;

    -- Ad-supported: enforce cost cap first (post-flight accrual may have pushed over).
    if v_row.daily_ai_cost >= c_cost_cap then
        return jsonb_build_object(
            'allowed',       false,
            'reason',        'cost_cap_exceeded',
            'tier_type',     v_row.tier_type,
            'current_cost',  v_row.daily_ai_cost,
            'limit',         c_cost_cap
        );
    end if;

    -- Action-specific counter check.
    case p_action_type
        when 'chat' then
            if v_row.ai_chats_today >= c_chat_limit then
                return jsonb_build_object(
                    'allowed',       false,
                    'reason',        'quota_exceeded',
                    'limit_type',    'ai_chats',
                    'tier_type',     v_row.tier_type,
                    'current_usage', v_row.ai_chats_today,
                    'limit',         c_chat_limit
                );
            end if;
            v_row.ai_chats_today := v_row.ai_chats_today + 1;

        when 'meal_log' then
            if v_row.meals_logged_today >= c_meal_limit then
                return jsonb_build_object(
                    'allowed',       false,
                    'reason',        'quota_exceeded',
                    'limit_type',    'meals_logged',
                    'tier_type',     v_row.tier_type,
                    'current_usage', v_row.meals_logged_today,
                    'limit',         c_meal_limit
                );
            end if;
            v_row.meals_logged_today := v_row.meals_logged_today + 1;

        when 'auto_swap' then
            if v_row.auto_swaps_today >= c_swap_limit then
                return jsonb_build_object(
                    'allowed',       false,
                    'reason',        'quota_exceeded',
                    'limit_type',    'auto_swaps',
                    'tier_type',     v_row.tier_type,
                    'current_usage', v_row.auto_swaps_today,
                    'limit',         c_swap_limit
                );
            end if;
            v_row.auto_swaps_today := v_row.auto_swaps_today + 1;
    end case;

    -- Persist single atomic write.
    update public.user_quotas
    set ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        daily_ai_cost      = v_row.daily_ai_cost,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    return jsonb_build_object(
        'allowed',            true,
        'tier_type',          v_row.tier_type,
        'ai_chats_today',     v_row.ai_chats_today,
        'meals_logged_today', v_row.meals_logged_today,
        'auto_swaps_today',   v_row.auto_swaps_today,
        'daily_ai_cost',      v_row.daily_ai_cost
    );
end;
$$;

revoke execute on function public.increment_quota_or_fail(text, uuid) from public, anon;
grant   execute on function public.increment_quota_or_fail(text, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: record_ai_cost (post-flight)
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
    c_cost_cap constant numeric := 0.20;
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

    -- Premium: track cost for analytics, no enforcement implications.
    v_row.daily_ai_cost := v_row.daily_ai_cost + p_cost_usd;

    update public.user_quotas
    set daily_ai_cost      = v_row.daily_ai_cost,
        ai_chats_today     = v_row.ai_chats_today,
        meals_logged_today = v_row.meals_logged_today,
        auto_swaps_today   = v_row.auto_swaps_today,
        last_reset_date    = v_row.last_reset_date,
        updated_at         = now()
    where user_id = v_user_id;

    return jsonb_build_object(
        'daily_ai_cost', v_row.daily_ai_cost,
        'cost_cap',      c_cost_cap,
        'over_cap',      v_row.tier_type = 'ad_supported' and v_row.daily_ai_cost > c_cost_cap,
        'tier_type',     v_row.tier_type
    );
end;
$$;

revoke execute on function public.record_ai_cost(numeric, uuid) from public, anon;
grant   execute on function public.record_ai_cost(numeric, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: set_user_tier (webhook-only)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_user_tier(
    p_user_id   uuid,
    p_tier_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_today date := (now() at time zone 'UTC')::date;
    v_row   public.user_quotas;
begin
    if p_user_id is null then
        raise exception 'p_user_id required' using errcode = '22023';
    end if;
    if p_tier_type not in ('premium', 'ad_supported') then
        raise exception 'invalid tier_type: %', p_tier_type using errcode = '22023';
    end if;

    insert into public.user_quotas (user_id, tier_type, last_reset_date)
    values (p_user_id, p_tier_type, v_today)
    on conflict (user_id) do update
        set tier_type  = excluded.tier_type,
            updated_at = now()
    returning * into v_row;

    return jsonb_build_object(
        'user_id',   v_row.user_id,
        'tier_type', v_row.tier_type
    );
end;
$$;

-- Service-role only; webhooks and trusted server code call this.
revoke execute on function public.set_user_tier(uuid, text) from public, anon, authenticated;
grant   execute on function public.set_user_tier(uuid, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-create trigger
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.handle_new_user_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.user_quotas (user_id, tier_type, last_reset_date)
    values (new.id, 'ad_supported', (now() at time zone 'UTC')::date)
    on conflict (user_id) do nothing;
    return new;
end;
$$;

-- Trigger function should be invoked only via the trigger, never via REST.
revoke execute on function public.handle_new_user_quota() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_quota on auth.users;
create trigger on_auth_user_created_quota
    after insert on auth.users
    for each row execute function public.handle_new_user_quota();

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill existing users
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.user_quotas (user_id, tier_type, last_reset_date)
select id, 'ad_supported', (now() at time zone 'UTC')::date
from auth.users
on conflict (user_id) do nothing;
