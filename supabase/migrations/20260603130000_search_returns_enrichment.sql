-- Surface enrichment through search
-- =================================
-- Both exercise search RPCs now (a) return equipment_canonical / equipment_display /
-- enrichment so the app can show clean equipment and the LLM can reason with the
-- richer metadata, and (b) match the equipment filter against equipment_canonical
-- OR the raw equipment string (so a user who owns "machine" matches every
-- leverage/assisted/sled variant, while raw-string filters still work).
--
-- Return-column changes require DROP + CREATE (CREATE OR REPLACE can't alter a
-- function's output columns).

drop function if exists public.search_exercises(text, vector, text[], integer);

create function public.search_exercises(
    query_text text default null,
    query_embedding vector default null,
    equipment_filter text[] default null,
    match_count integer default 12
)
returns table(
    id text,
    name text,
    target_muscle text,
    body_part text,
    equipment text,
    equipment_canonical text,
    equipment_display text,
    enrichment jsonb,
    difficulty text,
    gif_path text,
    instructions text[],
    similarity double precision
)
language sql
stable
as $function$
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
        e.equipment_canonical,
        e.equipment_display,
        e.enrichment,
        e.difficulty,
        e.gif_path,
        e.instructions,
        case when n.q_embedding is null then null else (e.embedding <=> n.q_embedding) end as vector_distance,
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
    where e.gif_path is not null and e.gif_path <> ''
),
ranked as (
    select
        s.*,
        case
            when s.vector_distance is not null and s.text_similarity is not null
                then (0.7 * (1 - s.vector_distance)) + (0.3 * s.text_similarity)
            when s.vector_distance is not null then (1 - s.vector_distance)
            when s.text_similarity is not null then s.text_similarity
            else 0
        end as hybrid_score
    from scored s
    cross join normalized n
    where
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
    where n.q_equipment is null
       or r.equipment = any(n.q_equipment)
       or r.equipment_canonical = any(n.q_equipment)
),
picked as (
    select * from strict_matches
    union all
    select r.* from ranked r where not exists (select 1 from strict_matches)
)
select
    p.id,
    p.name,
    p.target_muscle,
    p.body_part,
    p.equipment,
    p.equipment_canonical,
    p.equipment_display,
    p.enrichment,
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
$function$;

drop function if exists public.match_similar_exercises(vector, integer, text[], text[]);

create function public.match_similar_exercises(
    query_embedding vector,
    match_count integer default 8,
    equipment_filter text[] default null,
    avoid_body_parts text[] default null
)
returns table(
    id text,
    name text,
    equipment text,
    equipment_canonical text,
    equipment_display text,
    enrichment jsonb,
    target_muscle text,
    body_part text,
    gif_path text,
    similarity double precision
)
language sql
stable
as $function$
    select
        e.id::text,
        e.name,
        e.equipment,
        e.equipment_canonical,
        e.equipment_display,
        e.enrichment,
        e.target_muscle,
        e.body_part,
        e.gif_path,
        1 - (e.embedding <=> query_embedding) as similarity
    from exercises e
    where e.embedding is not null
      and e.gif_path is not null
      and e.gif_path <> ''
      and (
          equipment_filter is null
          or e.equipment = any(equipment_filter)
          or e.equipment_canonical = any(equipment_filter)
      )
      and (
          avoid_body_parts is null
          or not exists (
              select 1 from unnest(avoid_body_parts) as p
              where lower(coalesce(e.body_part, '')) like '%' || lower(p) || '%'
                 or lower(coalesce(e.target_muscle, '')) like '%' || lower(p) || '%'
          )
      )
    order by e.embedding <=> query_embedding
    limit match_count;
$function$;
