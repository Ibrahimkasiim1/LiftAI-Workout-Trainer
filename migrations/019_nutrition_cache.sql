-- Migration 019: Free-tier nutrition lookup cache.
--
-- Stores parsed macros keyed on a normalized food query so that repeat logs
-- ("2 eggs and toast") never re-hit the USDA / Open Food Facts APIs or the
-- LLM parser. The route checks this table before any network calls.
--
-- `source` records which path produced the row so we can audit hit rates:
--   'usda'  -> USDA FoodData Central
--   'off'   -> Open Food Facts
--   'llm'   -> Claude fallback (free APIs returned no usable match)
--   'heur'  -> Local heuristic fallback (LLM also failed)

create table if not exists nutrition_cache (
  id uuid primary key default gen_random_uuid(),
  query_key text not null unique,
  raw_text text not null,
  source text not null check (source in ('usda', 'off', 'llm', 'heur')),
  calories integer not null,
  protein integer not null,
  carbs integer not null,
  fats integer not null,
  vitamin_a_mcg integer,
  vitamin_c_mg integer,
  calcium_mg integer,
  iron_mg integer,
  hit_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nutrition_cache_query_key_idx
  on nutrition_cache (query_key);
