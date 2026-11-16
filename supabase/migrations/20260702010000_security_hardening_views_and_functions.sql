-- Security hardening pass (Supabase advisor findings).
--
-- 1) Views ran with definer (owner) privileges, BYPASSING RLS of the
--    underlying tables — and none of them filter by auth.uid(), so any
--    authenticated user could read every user's plans/workouts/conversation
--    summaries through them. security_invoker makes them run with the
--    caller's permissions: users see only their own rows (owner-scoped RLS
--    on workout_plans/daily_workouts/saved_workouts/exercise_performance/
--    chat_messages; exercises is intentionally public-read), while the
--    backend service role still bypasses RLS.
alter view public.user_active_workout_plan           set (security_invoker = on);
alter view public.user_main_workout_plan             set (security_invoker = on);
alter view public.user_all_workouts                  set (security_invoker = on);
alter view public.exercise_performance_with_metadata set (security_invoker = on);
alter view public.conversation_summaries             set (security_invoker = on);

-- 2) SECURITY DEFINER functions callable by anon. delete_user and
--    cleanup_old_workout_sessions are invoked by the signed-in app
--    (src/services/UserService.ts, utils/sessionCleanup.ts), so
--    authenticated keeps EXECUTE. handle_new_user / handle_new_user_quota
--    are auth triggers — nothing should call them over the API at all.
revoke execute on function public.delete_user()                  from public, anon;
revoke execute on function public.cleanup_old_workout_sessions() from public, anon;
revoke execute on function public.handle_new_user()              from public, anon, authenticated;
revoke execute on function public.handle_new_user_quota()        from public, anon, authenticated;

-- 3) Pin search_path on every function the linter flagged as mutable
--    (search-path hijack hardening; pg_trgm + vector live in public, so
--    operator resolution is unaffected).
alter function public.cleanup_old_workout_sessions()                           set search_path = public, pg_temp;
alter function public.deactivate_expired_overrides()                           set search_path = public, pg_temp;
alter function public.cleanup_expired_facts()                                  set search_path = public, pg_temp;
alter function public.get_workout_for_date(uuid, date)                         set search_path = public, pg_temp;
alter function public.get_additional_workouts(uuid, date)                      set search_path = public, pg_temp;
alter function public.update_updated_at_column()                               set search_path = public, pg_temp;
alter function public.get_exercise_alternatives(text, text[], text[])          set search_path = public, pg_temp;
alter function public.delete_user()                                            set search_path = public, pg_temp;
alter function public.match_similar_exercises(vector, integer, text[], text[]) set search_path = public, pg_temp;
alter function public.search_exercises(text, vector, text[], integer)          set search_path = public, pg_temp;
alter function public.handle_new_user()                                        set search_path = public, pg_temp;
alter function public.handle_new_user_quota()                                  set search_path = public, pg_temp;
