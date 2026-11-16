-- App-level remote configuration.
-- Rows are readable by anyone (anon/unauthenticated) so the version gate works
-- before a user has signed in. Only the service-role key (Supabase dashboard /
-- admin API) can write rows.
create table if not exists public.app_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table public.app_config enable row level security;

create policy "Public read app_config"
  on public.app_config
  for select
  using (true);

-- Seed minimum required versions.
-- Set these to the version you want to force-update FROM (exclusive lower bound).
-- e.g. set to "1.1.1" when you ship 1.1.2 and want all older users to update.
-- Start at "0.0.0" so no one is blocked until you intentionally bump the value.
insert into public.app_config (key, value) values
  ('minimum_ios_version',     '0.0.0'),
  ('minimum_android_version', '0.0.0')
on conflict (key) do nothing;
