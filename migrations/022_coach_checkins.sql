-- 022: Proactive coach check-ins.
--
-- The backend cron drafts short coach-initiated notes ("you've hit 12 reps on
-- bench two sessions straight — ready to add 2.5 kg?") and chat/plan tools
-- record plan-change explanations here. The app surfaces unread rows as a
-- coach card / chat nudge. Writes are service-role only; users can read and
-- update (mark read / dismiss) their own rows.

create table if not exists public.coach_checkins (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    kind text not null check (
        kind in ('ready_to_progress', 'streak', 'comeback', 'stalled_lift', 'plan_change')
    ),
    title text not null,
    message text not null,
    -- Prefilled chat message for the tap-through CTA ("Yes — bump my bench").
    cta text,
    -- Structured details (exercise name, current/suggested weight, streak count).
    payload jsonb,
    -- One check-in per (user, situation, week): generator builds keys like
    -- 'ready_to_progress:bench-press:2026-W27'.
    dedupe_key text not null,
    status text not null default 'unread' check (status in ('unread', 'read', 'dismissed')),
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    unique (user_id, dedupe_key)
);

alter table public.coach_checkins enable row level security;

create policy "coach_checkins_select_own" on public.coach_checkins
    for select using (auth.uid() = user_id);

create policy "coach_checkins_update_own" on public.coach_checkins
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists coach_checkins_user_status_idx
    on public.coach_checkins (user_id, status, created_at desc);
