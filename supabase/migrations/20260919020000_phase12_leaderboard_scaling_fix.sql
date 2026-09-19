-- Match Emojis Daily — Phase 12: leaderboard scaling fix (§5.9)
--
-- Following an external code review (see docs/DECISIONS.md's 2026-09-19
-- (later still) entry): server/functions/leaderboard/index.ts previously
-- fetched EVERY row of the relevant stats table via PostgREST, sorted the
-- whole thing in JavaScript, then queried display names for every single
-- row by putting every user id in one request URL. Three real failure
-- modes at scale, all confirmed by reading the code:
--   1. PostgREST's default Max Rows (1,000) silently truncates the table
--      select once a scope passes that many players — wrong top ranks,
--      not an error, which is worse (nothing looks broken).
--   2. The `.in('id', [...])` display-name query puts every user id in the
--      URL — UUIDs are 36 chars each, so a few hundred players blows past
--      typical ~8KB gateway URL limits and the whole request fails.
--   3. The entire scope table was loaded into Edge Function memory on
--      every leaderboard request, regardless of how many results anyone
--      actually needed to see.
--
-- Fix: do the 7-tier cascade (docs/ARCHITECTURE.md Section 7) as a single
-- ORDER BY inside Postgres, with rank() as a window function so ranking
-- happens once, in the database, and only the top N + the caller's own row
-- ever cross the wire to the Edge Function — never the whole table. This
-- also fixes a smaller correctness issue the same code had: sorting in JS
-- and slicing gave every row a distinct sequential rank even when several
-- players were tied on all 7 tiers; rank() gives genuinely-tied rows the
-- same rank, as a leaderboard should.
--
-- Three near-identical branches (daily/weekly/all-time) rather than one
-- dynamic-SQL function with an interpolated table name — there are only
-- ever these three scopes, so a static IF/ELSIF is both simpler to read
-- and has zero SQL-injection surface, compared to building a table name
-- from a string at runtime for no real benefit here.
--
-- NULLS LAST on every average tier (2, 4, 5, 7): a player with
-- attempts_completed = 0 has no real average for that tier — NULLIF turns
-- the division into NULL rather than dividing by zero — and NULLS LAST
-- makes that NULL sort as "worst" regardless of whether the tier is
-- ascending or descending, exactly matching the AVERAGE_SENTINEL logic
-- server/functions/leaderboard/index.ts used to implement by hand in JS
-- (see that file's own comment on this, kept there for continuity even
-- though the actual comparison now happens here instead).

create or replace function public.get_leaderboard_page(
  p_scope text,       -- 'daily' | 'weekly' | 'all-time'
  p_period_key date,  -- stat_date for daily, week_start for weekly; ignored (but still required) for all-time
  p_caller_id uuid,
  p_limit integer
)
returns table (
  out_user_id uuid,
  rnk bigint,
  out_max_score integer,
  out_sum_score bigint,
  out_max_time_bonus_micros bigint,
  out_sum_time_bonus_micros bigint,
  out_sum_lives_used bigint,
  out_sum_levels_played bigint,
  out_attempts_started integer,
  out_attempts_completed integer,
  total_players bigint,
  is_caller boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_scope = 'daily' then
    return query
    with ranked as (
      select
        s.user_id, s.max_score, s.sum_score, s.max_time_bonus_micros,
        s.sum_time_bonus_micros, s.sum_lives_used, s.sum_levels_played,
        s.attempts_started, s.attempts_completed,
        rank() over (
          order by
            s.max_score desc,
            (s.sum_score::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            s.max_time_bonus_micros desc,
            (s.sum_time_bonus_micros::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            (s.sum_lives_used::numeric / nullif(s.attempts_completed, 0)) asc nulls last,
            s.attempts_started asc,
            (s.sum_levels_played::numeric / nullif(s.attempts_completed, 0)) asc nulls last
        ) as rnk,
        count(*) over () as total_players
      from public.daily_stats s
      where s.stat_date = p_period_key
    ),
    caller_rnk as (
      select rnk from ranked where user_id = p_caller_id
    )
    select r.user_id, r.rnk, r.max_score, r.sum_score, r.max_time_bonus_micros,
           r.sum_time_bonus_micros, r.sum_lives_used, r.sum_levels_played,
           r.attempts_started, r.attempts_completed, r.total_players,
           (r.user_id = p_caller_id)
    from ranked r
    where r.rnk <= p_limit
       or r.user_id = p_caller_id
       or r.rnk = (select rnk - 1 from caller_rnk)
    order by r.rnk;

  elsif p_scope = 'weekly' then
    return query
    with ranked as (
      select
        s.user_id, s.max_score, s.sum_score, s.max_time_bonus_micros,
        s.sum_time_bonus_micros, s.sum_lives_used, s.sum_levels_played,
        s.attempts_started, s.attempts_completed,
        rank() over (
          order by
            s.max_score desc,
            (s.sum_score::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            s.max_time_bonus_micros desc,
            (s.sum_time_bonus_micros::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            (s.sum_lives_used::numeric / nullif(s.attempts_completed, 0)) asc nulls last,
            s.attempts_started asc,
            (s.sum_levels_played::numeric / nullif(s.attempts_completed, 0)) asc nulls last
        ) as rnk,
        count(*) over () as total_players
      from public.weekly_stats s
      where s.week_start = p_period_key
    ),
    caller_rnk as (
      select rnk from ranked where user_id = p_caller_id
    )
    select r.user_id, r.rnk, r.max_score, r.sum_score, r.max_time_bonus_micros,
           r.sum_time_bonus_micros, r.sum_lives_used, r.sum_levels_played,
           r.attempts_started, r.attempts_completed, r.total_players,
           (r.user_id = p_caller_id)
    from ranked r
    where r.rnk <= p_limit
       or r.user_id = p_caller_id
       or r.rnk = (select rnk - 1 from caller_rnk)
    order by r.rnk;

  else -- 'all-time'
    return query
    with ranked as (
      select
        s.user_id, s.max_score, s.sum_score, s.max_time_bonus_micros,
        s.sum_time_bonus_micros, s.sum_lives_used, s.sum_levels_played,
        s.attempts_started, s.attempts_completed,
        rank() over (
          order by
            s.max_score desc,
            (s.sum_score::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            s.max_time_bonus_micros desc,
            (s.sum_time_bonus_micros::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
            (s.sum_lives_used::numeric / nullif(s.attempts_completed, 0)) asc nulls last,
            s.attempts_started asc,
            (s.sum_levels_played::numeric / nullif(s.attempts_completed, 0)) asc nulls last
        ) as rnk,
        count(*) over () as total_players
      from public.all_time_stats s
    ),
    caller_rnk as (
      select rnk from ranked where user_id = p_caller_id
    )
    select r.user_id, r.rnk, r.max_score, r.sum_score, r.max_time_bonus_micros,
           r.sum_time_bonus_micros, r.sum_lives_used, r.sum_levels_played,
           r.attempts_started, r.attempts_completed, r.total_players,
           (r.user_id = p_caller_id)
    from ranked r
    where r.rnk <= p_limit
       or r.user_id = p_caller_id
       or r.rnk = (select rnk - 1 from caller_rnk)
    order by r.rnk;
  end if;
end;
$$;

-- Same pattern as every other SECURITY DEFINER function in this project
-- (start_attempt_slot, record_attempt_start, record_attempt_completion) —
-- confirmed via the §5.2 check this session that those are NOT publicly
-- executable; this one is written to match that from the start rather than
-- relying on a later audit to catch it.
revoke all on function public.get_leaderboard_page(text, date, uuid, integer) from public;
grant execute on function public.get_leaderboard_page(text, date, uuid, integer) to service_role;
