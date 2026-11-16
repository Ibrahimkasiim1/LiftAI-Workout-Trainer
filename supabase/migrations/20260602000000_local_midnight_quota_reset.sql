-- Migration: Reset the daily AI quota at the user's LOCAL midnight instead of UTC.
--
-- Previously `_lock_and_reset_quota` computed "today" as `(now() at time zone
-- 'UTC')::date`, so the daily budget reset at 00:00 UTC — mid-afternoon for US
-- users. We now store each user's IANA timezone on `user_quotas` and reset when
-- the date rolls over in THAT timezone, so "resets at midnight every night"
-- means the user's own midnight.
--
-- Reset stays lazy (applied on the next AI request after midnight); the client
-- computes the next local midnight directly for display, so the two always agree.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Per-user timezone (IANA name, e.g. 'America/Los_Angeles'). Defaults to UTC
--    so existing rows keep their current behaviour until the client reports one.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_quotas
    add column if not exists timezone text not null default 'UTC';

comment on column public.user_quotas.timezone is
    'IANA timezone reported by the client; daily quota resets at midnight in this zone.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. set_user_timezone: client-callable, validates against pg_timezone_names and
--    stores the caller''s timezone. Self-heals the row if it doesn''t exist yet.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_user_timezone(p_timezone text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then
        raise exception 'unauthenticated' using errcode = '28000';
    end if;
    if p_timezone is null
       or not exists (select 1 from pg_timezone_names where name = p_timezone) then
        raise exception 'invalid timezone: %', p_timezone using errcode = '22023';
    end if;

    insert into public.user_quotas (user_id, tier_type, timezone, last_reset_date)
    values (v_user_id, 'ad_supported', p_timezone, (now() at time zone p_timezone)::date)
    on conflict (user_id) do update
        set timezone   = excluded.timezone,
            updated_at = now();
end;
$$;

revoke execute on function public.set_user_timezone(text) from public, anon;
grant   execute on function public.set_user_timezone(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Timezone-aware lazy reset. "Today" is now derived from the stored timezone;
--    an invalid/missing value falls back to UTC so the function can never error.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public._lock_and_reset_quota(p_user_id uuid)
returns public.user_quotas
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row   public.user_quotas;
    v_tz    text;
    v_today date;
begin
    select * into v_row
    from public.user_quotas
    where user_id = p_user_id
    for update;

    if not found then
        -- Self-heal: trigger may not have fired for users created before quotas existed.
        insert into public.user_quotas (user_id, tier_type, last_reset_date)
        values (p_user_id, 'ad_supported', (now() at time zone 'UTC')::date)
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

    v_tz := coalesce(nullif(v_row.timezone, ''), 'UTC');
    -- Guard against a stored value Postgres can't resolve.
    begin
        v_today := (now() at time zone v_tz)::date;
    exception when others then
        v_today := (now() at time zone 'UTC')::date;
    end;

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
