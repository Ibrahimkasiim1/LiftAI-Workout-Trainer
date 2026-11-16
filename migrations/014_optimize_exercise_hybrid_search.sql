-- =====================================================
-- Hybrid exercise search optimization (RAG-first)
-- =====================================================

-- 1) Enable trigram similarity support for typo-tolerant text matching.
create extension if not exists pg_trgm;

-- 2) Add ANN index for vector retrieval.
create index if not exists exercises_embedding_hnsw_idx
on public.exercises
using hnsw (embedding vector_cosine_ops)
with (m = 16, ef_construction = 64);

-- 3) Add trigram index for fuzzy exercise-name matching.
create index if not exists exercises_name_trgm_idx
on public.exercises
using gin (lower(name) gin_trgm_ops);

-- 4) Replace search_exercises with a hybrid RPC:
--    - vector + fuzzy text in one query
--    - equipment filter fallback (strict -> relaxed)
drop function if exists public.search_exercises(vector(1536), integer, float, text[]);
drop function if exists public.search_exercises(text, vector(1536), text[], integer);

create or replace function public.search_exercises(
    query_text text default null,
    query_embedding vector(1536) default null,
    equipment_filter text[] default null,
    match_count integer default 12
)
returns table (
    id text,
    name text,
    target_muscle text,
    body_part text,
    equipment text,
    difficulty text,
    gif_path text,
    instructions text[],
    similarity float
)
language sql
stable
as $$
with normalized as (
    select
        nullif(trim(query_text), '') as q_text,
        query_embedding as q_embedding,
        equipment_filter as q_equipment,
        greatest(1, least(coalesce(match_count, 12), 50)) as q_limit
),
scored as (
    select
        e.id::text as id,
        e.name,
        e.target_muscle,
        e.body_part,
        e.equipment,
        e.difficulty,
        e.gif_path,
        e.instructions,
        case
            when n.q_embedding is null then null
            else (e.embedding <=> n.q_embedding)
        end as vector_distance,
        case
            when n.q_text is null then null
            else greatest(
                similarity(lower(e.name), lower(n.q_text)),
                similarity(lower(coalesce(e.target_muscle, '')), lower(n.q_text)),
                similarity(lower(coalesce(e.body_part, '')), lower(n.q_text)),
                similarity(lower(coalesce(e.equipment, '')), lower(n.q_text))
            )
        end as text_similarity
    from public.exercises e
    cross join normalized n
    where
        e.gif_path is not null
        and e.gif_path <> ''
),
ranked as (
    select
        s.*,
        -- Combined score:
        --  - if both signals exist: 70% vector relevance + 30% text similarity
        --  - otherwise use whichever signal is available
        case
            when s.vector_distance is not null and s.text_similarity is not null
                then (0.7 * (1 - s.vector_distance)) + (0.3 * s.text_similarity)
            when s.vector_distance is not null
                then (1 - s.vector_distance)
            when s.text_similarity is not null
                then s.text_similarity
            else 0
        end as hybrid_score
    from scored s
    cross join normalized n
    where
        -- Require at least one search signal.
        (n.q_embedding is not null or n.q_text is not null)
        and (
            n.q_text is null
            or s.text_similarity >= 0.12
            or lower(s.name) % lower(n.q_text)
            or lower(coalesce(s.target_muscle, '')) % lower(n.q_text)
            or lower(coalesce(s.body_part, '')) % lower(n.q_text)
            or lower(coalesce(s.equipment, '')) % lower(n.q_text)
        )
),
strict_matches as (
    select r.*
    from ranked r
    cross join normalized n
    where n.q_equipment is null or r.equipment = any(n.q_equipment)
),
picked as (
    -- If strict equipment returns 0 rows, automatically relax the equipment filter.
    select * from strict_matches
    union all
    select r.*
    from ranked r
    where not exists (select 1 from strict_matches)
)
select
    p.id,
    p.name,
    p.target_muscle,
    p.body_part,
    p.equipment,
    p.difficulty,
    p.gif_path,
    p.instructions,
    p.hybrid_score::float as similarity
from picked p
order by
    p.hybrid_score desc,
    p.vector_distance asc nulls last,
    p.text_similarity desc nulls last
limit (select q_limit from normalized);
$$;

grant execute on function public.search_exercises(text, vector(1536), text[], integer) to authenticated;
grant execute on function public.search_exercises(text, vector(1536), text[], integer) to anon;

comment on function public.search_exercises(text, vector(1536), text[], integer) is
'Hybrid exercise search (pgvector + pg_trgm) with strict-equipment fallback to closest library matches.';
