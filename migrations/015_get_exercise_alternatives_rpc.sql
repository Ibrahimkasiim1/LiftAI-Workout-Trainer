create or replace function public.get_exercise_alternatives(
  p_current_exercise_id text,
  p_user_equipment      text[]  DEFAULT NULL,
  p_injuries            text[]  DEFAULT NULL
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_target_muscle text;
  v_body_part     text;
  v_rows          jsonb;
begin
  select e.target_muscle, e.body_part
    into v_target_muscle, v_body_part
  from public.exercises e
  where e.id = p_current_exercise_id;

  if v_target_muscle is null and v_body_part is null then
    return '[]'::jsonb;
  end if;

  with
  base as (
    -- All same-muscle candidates, excluding the current exercise and injured muscles
    select
      e.id,
      e.name,
      e.target_muscle,
      e.body_part,
      e.equipment,
      e.gif_path
    from public.exercises e
    where e.id <> p_current_exercise_id
      and (
        (v_target_muscle is not null and e.target_muscle = v_target_muscle)
        or (v_target_muscle is null and v_body_part is not null and e.body_part = v_body_part)
      )
      -- Injury filter: skip exercises that target an injured muscle/body part
      and (
        p_injuries is null
        or cardinality(p_injuries) = 0
        or not exists (
          select 1 from unnest(p_injuries) as inj
          where lower(e.target_muscle) ilike '%' || lower(inj) || '%'
             or lower(e.body_part) ilike '%' || lower(inj) || '%'
        )
      )
  ),
  tier1 as (
    -- Best matches: user's exact equipment
    select b.*
    from base b
    where p_user_equipment is not null
      and cardinality(p_user_equipment) > 0
      and b.equipment is not null
      and b.equipment = any(p_user_equipment)
    order by random()
    limit 5
  ),
  tier2 as (
    -- Fallback: body weight / machine (safe with any equipment setup)
    select b.*
    from base b
    where not exists (select 1 from tier1 t where t.id = b.id)
      and lower(coalesce(b.equipment, '')) in ('body weight', 'bodyweight', 'machine')
    order by random()
    limit 5
  )
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb)
    into v_rows
  from (
    select * from tier1
    union all
    select * from tier2
    limit 5
  ) x;

  return v_rows;
end;
$$;

grant execute on function public.get_exercise_alternatives(text, text[], text[]) to anon, authenticated, service_role;
