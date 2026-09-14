-- Match Emojis Daily — Phase 7: stats-upsert functions
--
-- The Phase 2 schema created daily_stats/weekly_stats/all_time_stats/
-- user_year_activity but nothing has ever written to them — score-replay
-- (Phase 5/6) only updates the `attempts` row itself, and start-attempt
-- never touched attempts_started. Discovered at the start of this Phase 7
-- session: the leaderboard cascade (ARCHITECTURE.md Section 7) has nothing
-- to query without these tables actually being populated. Two service-role
-- functions close that gap; server/functions/start-attempt/index.ts and
-- server/functions/score-replay/index.ts are both updated in this same
-- session to call them. See docs/DECISIONS.md's 2026-09-14 "Phase 7"
-- entries for the accounting-scope reasoning below.
--
-- Run via the Supabase SQL Editor after the Phase 2 migrations.

-- ============================================================================
-- week_start_ist: Monday of the week containing a given (already
-- IST-calendar) date. date_trunc('week', ...) is ISO-8601 (Monday-first) by
-- default in Postgres, which already matches the standing "weekly
-- leaderboard resets Monday 00:00 IST" decision — no custom day-of-week math
-- needed.
-- ============================================================================

create or replace function public.week_start_ist(d date)
returns date
language sql
immutable
as $$
  select date_trunc('week', d)::date;
$$;

-- ============================================================================
-- record_attempt_start: called once per start-attempt call, immediately
-- after the new `attempts` row is inserted. Increments attempts_started on
-- the daily/weekly/all-time rows for the attempt's *start* date, and bumps
-- user_year_activity for that date — the calendar (Section 9) should mark a
-- day as "played" from when the player actually opened an attempt that day,
-- not from whichever later day it happened to be scored against.
--
-- Scoped to the start date deliberately, not score_day — this mirrors the
-- existing Section 8 split (slot-cap keys off started_at, leaderboard
-- placement keys off completion/score_day). A midnight-spanning attempt can
-- therefore increment attempts_started on one daily_stats row and, on
-- completion, attempts_completed/score on a *different* day's row. This is
-- expected given the accounting model already on record, not a bug
-- introduced here — flagged in docs/DECISIONS.md rather than "fixed", since
-- unifying them would contradict the existing Section 8 design.
-- ============================================================================

create or replace function public.record_attempt_start(
  p_user_id uuid,
  p_start_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week date := public.week_start_ist(p_start_date);
begin
  insert into public.daily_stats (user_id, stat_date, attempts_started)
  values (p_user_id, p_start_date, 1)
  on conflict (user_id, stat_date) do update
    set attempts_started = daily_stats.attempts_started + 1,
        updated_at = now();

  insert into public.weekly_stats (user_id, week_start, attempts_started)
  values (p_user_id, v_week, 1)
  on conflict (user_id, week_start) do update
    set attempts_started = weekly_stats.attempts_started + 1,
        updated_at = now();

  insert into public.all_time_stats (user_id, attempts_started)
  values (p_user_id, 1)
  on conflict (user_id) do update
    set attempts_started = all_time_stats.attempts_started + 1,
        updated_at = now();

  insert into public.user_year_activity (user_id, activity_date, attempts_count)
  values (p_user_id, p_start_date, 1)
  on conflict (user_id, activity_date) do update
    set attempts_count = user_year_activity.attempts_count + 1;
end;
$$;

revoke all on function public.record_attempt_start(uuid, date) from public;
grant execute on function public.record_attempt_start(uuid, date) to service_role;

-- ============================================================================
-- record_attempt_completion: called once per successful score-replay
-- validation, immediately after the `attempts` row UPDATE succeeds. Rolls
-- the result into daily/weekly/all-time max/sum aggregates (feeding tiers
-- 1-4 and 7 of the leaderboard cascade) and increments attempts_completed
-- (the divisor for the four average tiers, per the existing Phase 2
-- attempts_started-vs-attempts_completed distinction).
--
-- Scoped to score_day, per Section 8 — this is deliberately NOT always the
-- same daily_stats row record_attempt_start touched for this same attempt;
-- see that function's comment above.
-- ============================================================================

create or replace function public.record_attempt_completion(
  p_user_id uuid,
  p_score_day date,
  p_score integer,
  p_time_bonus_micros bigint,
  p_lives_used integer,
  p_levels_reached integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week date := public.week_start_ist(p_score_day);
begin
  insert into public.daily_stats (
    user_id, stat_date, max_score, sum_score, max_time_bonus_micros,
    sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_completed
  )
  values (
    p_user_id, p_score_day, p_score, p_score, p_time_bonus_micros,
    p_time_bonus_micros, p_lives_used, p_levels_reached, 1
  )
  on conflict (user_id, stat_date) do update
    set max_score = greatest(daily_stats.max_score, excluded.max_score),
        sum_score = daily_stats.sum_score + excluded.sum_score,
        max_time_bonus_micros = greatest(daily_stats.max_time_bonus_micros, excluded.max_time_bonus_micros),
        sum_time_bonus_micros = daily_stats.sum_time_bonus_micros + excluded.sum_time_bonus_micros,
        sum_lives_used = daily_stats.sum_lives_used + excluded.sum_lives_used,
        sum_levels_played = daily_stats.sum_levels_played + excluded.sum_levels_played,
        attempts_completed = daily_stats.attempts_completed + 1,
        updated_at = now();

  insert into public.weekly_stats (
    user_id, week_start, max_score, sum_score, max_time_bonus_micros,
    sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_completed
  )
  values (
    p_user_id, v_week, p_score, p_score, p_time_bonus_micros,
    p_time_bonus_micros, p_lives_used, p_levels_reached, 1
  )
  on conflict (user_id, week_start) do update
    set max_score = greatest(weekly_stats.max_score, excluded.max_score),
        sum_score = weekly_stats.sum_score + excluded.sum_score,
        max_time_bonus_micros = greatest(weekly_stats.max_time_bonus_micros, excluded.max_time_bonus_micros),
        sum_time_bonus_micros = weekly_stats.sum_time_bonus_micros + excluded.sum_time_bonus_micros,
        sum_lives_used = weekly_stats.sum_lives_used + excluded.sum_lives_used,
        sum_levels_played = weekly_stats.sum_levels_played + excluded.sum_levels_played,
        attempts_completed = weekly_stats.attempts_completed + 1,
        updated_at = now();

  insert into public.all_time_stats (
    user_id, max_score, sum_score, max_time_bonus_micros,
    sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_completed
  )
  values (
    p_user_id, p_score, p_score, p_time_bonus_micros,
    p_time_bonus_micros, p_lives_used, p_levels_reached, 1
  )
  on conflict (user_id) do update
    set max_score = greatest(all_time_stats.max_score, excluded.max_score),
        sum_score = all_time_stats.sum_score + excluded.sum_score,
        max_time_bonus_micros = greatest(all_time_stats.max_time_bonus_micros, excluded.max_time_bonus_micros),
        sum_time_bonus_micros = all_time_stats.sum_time_bonus_micros + excluded.sum_time_bonus_micros,
        sum_lives_used = all_time_stats.sum_lives_used + excluded.sum_lives_used,
        sum_levels_played = all_time_stats.sum_levels_played + excluded.sum_levels_played,
        attempts_completed = all_time_stats.attempts_completed + 1,
        updated_at = now();
end;
$$;

revoke all on function public.record_attempt_completion(uuid, date, integer, bigint, integer, integer) from public;
grant execute on function public.record_attempt_completion(uuid, date, integer, bigint, integer, integer) to service_role;
