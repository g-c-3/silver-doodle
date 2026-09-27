-- Match Emojis Daily — event-driven forfeit detection, replacing heartbeat
--
-- Removes the ~20s client heartbeat (attempt-heartbeat) and its 5-minute
-- cron sweep (forfeit-stale-attempts) as the way in_progress attempts get
-- marked forfeited. Neither ever affected score integrity or the
-- leaderboard's tier-6 "fewer attempts" tiebreak — attempts_started is
-- incremented at start-attempt time regardless of what happens after, and
-- a forfeited attempt's score/time_bonus/lives_used/levels_reached were
-- always just DB defaults (0), never client-trusted either way. Heartbeat's
-- only real job was timely status bookkeeping (Attempt History showing
-- "forfeited" instead of a perpetually stuck "in_progress"), at the
-- recurring storage-write cost of one UPDATE every ~20s for the lifetime
-- of every attempt, for every player. Replaced with two event-driven
-- triggers instead of a poll:
--
--   1. A new attempt starting (start_attempt_slot, below) forfeits any of
--      that SAME user's other still-in_progress attempts first, in the
--      same transaction as the new insert. Only one attempt is ever
--      actually live on a given device at a time, so any other in_progress
--      row at this point is definitely abandoned, not concurrent play.
--   2. Any attempt still in_progress from a PRIOR calendar day gets
--      forfeited by generate-daily-games' existing once-daily cron run
--      (server/functions/generate-daily-games/index.ts) — see that file
--      for the actual sweep, added alongside this migration.
--
-- Together these resolve every dangling in_progress row: same-day
-- abandonment resolves the moment the player starts their next attempt
-- (up to 12/day, so this fires often); cross-day/permanent abandonment
-- resolves at the very next day's generation run, worst case ~24h stale
-- status label — never a score-integrity or leaderboard-fairness concern,
-- only a display-freshness one. See docs/DECISIONS.md's 2026-09-27 entry.
--
-- Run via the Supabase SQL Editor after the Phase 8 atomic-slot-cap
-- migration (this replaces/extends that function).

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

  -- 2026-09-27: forfeit trigger #1 — starting a new attempt means any of
  -- this user's OTHER still-in_progress attempts (any day, not just
  -- p_game_date) are definitely abandoned, since only one attempt is ever
  -- actually live per device. score_day is set to p_game_date (today —
  -- the day this forfeit is detected/settled), matching how
  -- forfeit-stale-attempts always scored a forfeit against the settlement
  -- day, not the day the attempt started.
  update public.attempts
  set status = 'forfeited', completed_at = now(), score_day = p_game_date
  where user_id = p_user_id
    and status = 'in_progress';

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

-- last_heartbeat_at (Phase 8 heartbeat column) is now fully dead — nothing
-- writes it (attempt-heartbeat is deleted) and nothing reads it
-- (forfeit-stale-attempts is deleted). Confirmed via a full-repo grep
-- before dropping, not assumed.
alter table public.attempts drop column if exists last_heartbeat_at;
