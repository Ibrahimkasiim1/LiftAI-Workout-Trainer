-- 023: Defense-in-depth for coach_checkins.
--
-- RLS already scopes rows (select/update own; no insert/delete policies =
-- default deny), but Supabase's default grants hand anon/authenticated every
-- table privilege at the SQL layer. Reduce the surface to exactly what the
-- app uses:
--   anon          → nothing (check-ins require a signed-in user)
--   authenticated → SELECT + UPDATE(status) only (mark read / dismissed;
--                   title/message/payload are coach-authored and immutable)
--   service_role  → unaffected (bypasses RLS; writes come from the backend
--                   cron + plan-change notes)

revoke all on table public.coach_checkins from anon;
revoke insert, update, delete, truncate, references, trigger on table public.coach_checkins from authenticated;
grant update (status) on table public.coach_checkins to authenticated;

-- Pin the search_path of the coach-memories RPC (advisor lint:
-- function_search_path_mutable). The prompt-context loader and
-- get_active_user_context both depend on this function.
alter function public.get_active_coach_memories(uuid, integer) set search_path = public, pg_temp;
