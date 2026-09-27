-- Match Emojis Daily — leaderboard snapshot caching
--
-- REWRITTEN same-session, 2026-09-27, before this migration was ever run
-- against the live project (confirmed via ROADMAP.md — "run both new
-- migrations" was still an outstanding manual step) — so this edits the
-- migration file in place rather than layering a second migration on top
-- of one that never actually shipped. See docs/DECISIONS.md's second
-- 2026-09-27 entry for the full reasoning behind the rename below.
--
-- Account-holder request, verbatim: "Make the Daily as Today & Week as
-- Yesterday and remove the cap on refresh for Today in leaderboard, no
-- more 12, 3, 6, 9, ist. Will refresh fresh." Confirmed interpretation:
-- "Yesterday" is a frozen snapshot of the previous day's final daily
-- standings (a single immutable day), not a rolling 7-day window.
--
-- This changes the caching design for real, not just the labels:
--   'today'     — no longer cached at all. Ranked live, on every request,
--                 by server/functions/leaderboard/index.ts directly against
--                 get_leaderboard_page() (unchanged) — exactly what "will
--                 refresh fresh" asked for. Never written to the tables
--                 below.
--   'yesterday' — the previous IST day's daily_stats, ranked ONCE, right
--                 after that day ends (generate-daily-games' existing
--                 midnight-IST run — see that file). Once written, that
--                 day's row never changes again, since the day it
--                 describes is over — no refresh schedule needed at all,
--                 unlike the old 'daily'/'weekly' cadence this replaces.
--   'all-time'  — unchanged: refreshed once a day, same midnight run.
--
-- This migration keeps two small tables, written once per refresh (not
-- once per read) by refresh_leaderboard_snapshot() below, so a leaderboard
-- screen open for 'yesterday'/'all-time' is a cheap indexed lookup instead
-- of a full re-rank; 'today' bypasses both tables entirely (see
-- leaderboard/index.ts):
--
--   leaderboard_snapshots — one row per (scope, period_key): when it was
--     generated and when the next refresh is due (for 'all-time'; for
--     'yesterday' this is set far in the future purely for schema
--     consistency — see refresh_leaderboard_snapshot()'s comment below,
--     that day is genuinely final and is never rewritten).
--
--   leaderboard_ranks — one row per (scope, period_key, user_id): every
--     player's rank and raw tier values as of that refresh. Two read
--     patterns, both cheap and indexed: "top N" (order by rnk limit N) and
--     "my own row" (a single user_id lookup) — no live ranking computation
--     on read, ever, for either scope this table still serves.
--
-- get_leaderboard_page()'s own ranking logic (docs/ARCHITECTURE.md Section
-- 7's 7-tier cascade) is UNCHANGED and still exists — used directly, live,
-- for 'today', and duplicated below (not called) for 'yesterday'/'all-time'
-- snapshot refreshes, same reasoning as before: get_leaderboard_page()
-- deliberately only ever returns top-N + the caller's row, and a snapshot
-- refresh needs every row.

create table public.leaderboard_snapshots (
  scope             text not null check (scope in ('yesterday', 'all-time')),
  period_key        date not null, -- the frozen day for 'yesterday' / a fixed dummy date for all-time (ignored on read)
  generated_at      timestamptz not null default now(),
  next_refresh_at   timestamptz not null,
  total_players     integer not null default 0,
  primary key (scope, period_key)
);

alter table public.leaderboard_snapshots enable row level security;
-- No policies — every read goes through the leaderboard Edge Function's
-- service-role client (same as every stats/game-definition table already
-- in this schema that isn't meant for direct client access).

create table public.leaderboard_ranks (
  scope                     text not null check (scope in ('yesterday', 'all-time')),
  period_key                date not null,
  user_id                   uuid not null references public.users(id) on delete cascade,
  rnk                       bigint not null,
  max_score                 integer not null,
  sum_score                 bigint not null,
  max_time_bonus_micros     bigint not null,
  sum_time_bonus_micros     bigint not null,
  sum_lives_used            bigint not null,
  sum_levels_played         bigint not null,
  attempts_started          integer not null,
  attempts_completed        integer not null,
  primary key (scope, period_key, user_id)
);

alter table public.leaderboard_ranks enable row level security;
-- No policies — same reasoning as leaderboard_snapshots above.

-- Fast top-N reads: "give me rank() order for this scope+period".
create index idx_leaderboard_ranks_page on public.leaderboard_ranks (scope, period_key, rnk);

create or replace function public.refresh_leaderboard_snapshot(
  p_scope text,
  p_period_key date,
  p_next_refresh_at timestamptz
)
returns integer -- total_players, for the caller's own logging/response
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  if p_scope = 'yesterday' then
    -- Same ranking query the old 'daily' branch used (daily_stats for one
    -- specific stat_date) — the only thing that changed is WHEN this runs
    -- (once, right after the day ends, from generate-daily-games' midnight
    -- run) and that p_period_key is always "the day that just ended", never
    -- "today". A day, once frozen here, is never re-ranked again.
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
        ) as rnk
      from public.daily_stats s
      where s.stat_date = p_period_key
    )
    select count(*) into v_total from ranked;

    delete from public.leaderboard_ranks where scope = 'yesterday' and period_key = p_period_key;

    insert into public.leaderboard_ranks (
      scope, period_key, user_id, rnk, max_score, sum_score, max_time_bonus_micros,
      sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed
    )
    select 'yesterday', p_period_key, s.user_id, rank() over (
        order by
          s.max_score desc,
          (s.sum_score::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
          s.max_time_bonus_micros desc,
          (s.sum_time_bonus_micros::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
          (s.sum_lives_used::numeric / nullif(s.attempts_completed, 0)) asc nulls last,
          s.attempts_started asc,
          (s.sum_levels_played::numeric / nullif(s.attempts_completed, 0)) asc nulls last
      ), s.max_score, s.sum_score, s.max_time_bonus_micros, s.sum_time_bonus_micros,
      s.sum_lives_used, s.sum_levels_played, s.attempts_started, s.attempts_completed
    from public.daily_stats s
    where s.stat_date = p_period_key;

  else -- 'all-time'
    with ranked as (
      select s.user_id from public.all_time_stats s
    )
    select count(*) into v_total from ranked;

    delete from public.leaderboard_ranks where scope = 'all-time' and period_key = p_period_key;

    insert into public.leaderboard_ranks (
      scope, period_key, user_id, rnk, max_score, sum_score, max_time_bonus_micros,
      sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed
    )
    select 'all-time', p_period_key, s.user_id, rank() over (
        order by
          s.max_score desc,
          (s.sum_score::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
          s.max_time_bonus_micros desc,
          (s.sum_time_bonus_micros::numeric / nullif(s.attempts_completed, 0)) desc nulls last,
          (s.sum_lives_used::numeric / nullif(s.attempts_completed, 0)) asc nulls last,
          s.attempts_started asc,
          (s.sum_levels_played::numeric / nullif(s.attempts_completed, 0)) asc nulls last
      ), s.max_score, s.sum_score, s.max_time_bonus_micros, s.sum_time_bonus_micros,
      s.sum_lives_used, s.sum_levels_played, s.attempts_started, s.attempts_completed
    from public.all_time_stats s;
  end if;

  insert into public.leaderboard_snapshots (scope, period_key, generated_at, next_refresh_at, total_players)
  values (p_scope, p_period_key, now(), p_next_refresh_at, coalesce(v_total, 0))
  on conflict (scope, period_key)
  do update set generated_at = excluded.generated_at,
                next_refresh_at = excluded.next_refresh_at,
                total_players = excluded.total_players;

  return coalesce(v_total, 0);
end;
$$;

revoke all on function public.refresh_leaderboard_snapshot(text, date, timestamptz) from public;
grant execute on function public.refresh_leaderboard_snapshot(text, date, timestamptz) to service_role;
