-- Match Emojis Daily — Phase 8: atomic slot-cap enforcement
--
-- start-attempt/index.ts's existing cap check counts today's attempts, then
-- separately inserts a new one — two concurrent calls (e.g. a double-tap,
-- or a retry racing the original request) could both read the same count,
-- both pass the "< 12" check, and both insert, breaking the 12/day cap.
-- That gap is already flagged in start-attempt's own comments as a "soft
-- guard, not the real Phase 8 cap."
--
-- This function makes the count-check-and-insert one atomic unit per
-- (user, day): pg_advisory_xact_lock serializes any concurrent calls for
-- the same player+date to run one at a time, for the lifetime of this
-- function's transaction, so the second caller's count always reflects the
-- first caller's insert. It also takes over computing which game_index this
-- attempt is (game_order[attempt_number]) and resolving that to a
-- game_definition_id, since that lookup has the exact same
-- read-then-use race otherwise (two concurrent calls could both compute
-- "this is attempt #5" and both start the same game slot rather than
-- #5 and #6).
--
-- Run via the Supabase SQL Editor after the Phase 7 migration.

create or replace function public.start_attempt_slot(
  p_user_id uuid,
  p_game_date date,
  p_start_bound_utc timestamptz,
  p_end_bound_utc timestamptz,
  p_game_count integer,
  p_game_order integer[]
)
returns table(attempt_id uuid, attempt_number integer, game_definition_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_game_index integer;
  v_game_definition_id uuid;
  v_attempt_id uuid;
begin
  -- Serializes concurrent start-attempt calls for the same player+day.
  -- hashtextextended's salt argument is unused here (0) — the lock key only
  -- needs to be a stable, collision-resistant bigint for this (user, date)
  -- pair, not cryptographically salted. Released automatically when this
  -- function's transaction ends.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_game_date::text, 0));

  select count(*) into v_count
  from public.attempts
  where user_id = p_user_id
    and started_at >= p_start_bound_utc
    and started_at <= p_end_bound_utc;

  if v_count >= p_game_count then
    raise exception 'DAILY_CAP_REACHED';
  end if;

  -- Postgres arrays are 1-indexed; v_count is the 0-indexed "attempt number"
  -- (0 = first attempt of the day), matching attemptNumberToday's existing
  -- meaning in start-attempt/index.ts.
  v_game_index := p_game_order[v_count + 1];

  select id into v_game_definition_id
  from public.daily_game_definitions
  where game_date = p_game_date and game_index = v_game_index;

  if v_game_definition_id is null then
    raise exception 'NO_GAME_DEFINITION';
  end if;

  insert into public.attempts (user_id, game_definition_id, status)
  values (p_user_id, v_game_definition_id, 'in_progress')
  returning id into v_attempt_id;

  return query select v_attempt_id, v_count, v_game_definition_id;
end;
$$;

revoke all on function public.start_attempt_slot(uuid, date, timestamptz, timestamptz, integer, integer[]) from public;
grant execute on function public.start_attempt_slot(uuid, date, timestamptz, timestamptz, integer, integer[]) to service_role;
