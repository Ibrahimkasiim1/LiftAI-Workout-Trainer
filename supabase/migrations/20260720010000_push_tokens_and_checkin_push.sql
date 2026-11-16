-- Push notifications for coach check-ins.
--
-- 1. `user_push_tokens`: Expo push tokens, one row per device token. The
--    client upserts its token whenever notification permission is granted;
--    the backend push-delivery pass reads them with the service role and
--    deletes tokens Expo reports as DeviceNotRegistered.
-- 2. `coach_checkins.pushed_at`: set once a push for the check-in has been
--    handed to Expo (or intentionally skipped), so the delivery pass is
--    idempotent and never double-pings a user.

create table if not exists public.user_push_tokens (
    token text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    platform text not null default 'unknown' check (platform in ('ios', 'android', 'unknown')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists user_push_tokens_user_idx
    on public.user_push_tokens (user_id);

alter table public.user_push_tokens enable row level security;

-- Users manage only their own device tokens; the backend uses the service
-- role and bypasses RLS.
create policy "push_tokens_select_own" on public.user_push_tokens
    for select using (auth.uid() = user_id);

create policy "push_tokens_insert_own" on public.user_push_tokens
    for insert with check (auth.uid() = user_id);

create policy "push_tokens_update_own" on public.user_push_tokens
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "push_tokens_delete_own" on public.user_push_tokens
    for delete using (auth.uid() = user_id);

alter table public.coach_checkins
    add column if not exists pushed_at timestamptz;

-- The delivery pass scans "unread, not yet pushed, recent" — keep that cheap.
create index if not exists coach_checkins_unpushed_idx
    on public.coach_checkins (created_at)
    where pushed_at is null and status = 'unread';
