-- Enable realtime for user_quotas so the client can subscribe to tier_type
-- changes (written by the RevenueCat webhook and sync-subscription-tier) and
-- update Pro gating live. REPLICA IDENTITY FULL ensures UPDATE/DELETE payloads
-- carry the row so the user_id=eq filter matches reliably.
alter table public.user_quotas replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'user_quotas'
  ) then
    alter publication supabase_realtime add table public.user_quotas;
  end if;
end $$;
