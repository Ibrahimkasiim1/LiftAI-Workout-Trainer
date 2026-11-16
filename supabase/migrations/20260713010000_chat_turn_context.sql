-- get_chat_turn_context: one round-trip for the chat route's per-turn setup.
--
-- prepareChatTurn (backend/src/routes/chat.ts) used to fire four parallel
-- PostgREST reads on EVERY chat message: user_profiles, workout_plans (+
-- daily_workouts), get_active_coach_memories, user_quotas.timezone. This
-- function bundles them into a single RPC so a turn pays one network hop and
-- one connection instead of four. The backend keeps the old parallel loads as
-- a fallback until this migration is applied (PGRST202 → fallback).
--
-- Shape (all keys always present):
--   {
--     "profile":  <user_profiles row as jsonb>            | null,
--     "plan":     <workout_plans row + "days": [...]>     | null,
--     "timezone": "America/Los_Angeles"                   | null,
--     "memories": [ {"category": "...", "fact": "..."} ]  (may be empty)
--   }

create or replace function public.get_chat_turn_context(
    p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
select jsonb_build_object(
    'profile',
    (select to_jsonb(p) from public.user_profiles p where p.id = p_user_id),

    'plan',
    (
        select to_jsonb(w) || jsonb_build_object(
            'days',
            coalesce(
                (
                    select jsonb_agg(to_jsonb(d) order by d.id)
                    from public.daily_workouts d
                    where d.plan_id = w.id
                ),
                '[]'::jsonb
            )
        )
        from public.workout_plans w
        where w.user_id = p_user_id
          and w.is_active = true
        order by w.created_at desc
        limit 1
    ),

    'timezone',
    (select q.timezone from public.user_quotas q where q.user_id = p_user_id),

    'memories',
    coalesce(
        (
            select jsonb_agg(jsonb_build_object('category', m.category, 'fact', m.fact))
            from public.get_active_coach_memories(p_user_id, 5) m
        ),
        '[]'::jsonb
    )
);
$$;

-- Backend-only read (the service role client calls it with the authed user's
-- id). Not for direct client use — it exposes the full profile row.
revoke execute on function public.get_chat_turn_context(uuid) from public, anon, authenticated;
grant   execute on function public.get_chat_turn_context(uuid) to service_role;
