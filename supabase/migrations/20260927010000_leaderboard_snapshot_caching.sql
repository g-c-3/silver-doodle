-- Match Emojis Daily — leaderboard snapshot caching
--
-- Previously, server/functions/leaderboard/index.ts called
-- get_leaderboard_page() live, on EVERY leaderboard screen open, from EVERY
-- player — a full 7-tier rank() window-function pass over the scope's
-- entire daily_stats/weekly_stats/all_time_stats table, every single time,
-- even though nothing in the underlying data needs to be reflected any
-- faster than a fixed refresh schedule (daily: every 3h at 12/3/6/9 IST;
-- weekly & all-time: once a day at midnight IST) per product decision.
--
-- This migration adds two small tables, written once per refresh window
-- (not once per read) by refresh_leaderboard_snapshot() below, so every
-- leaderboard screen open for the rest of that window becomes a cheap
-- indexed lookup instead of a full re-rank:
--
--   leaderboard_snapshots — one row per (scope, period_key): when it was
--     generated and when the next refresh is due, so the client can render
--     an accurate countdown and cache its own copy client-side until then
--     (client/src/js/leaderboard.js).
--
--   leaderboard_ranks — one row per (scope, period_key, user_id): every
--     player's rank and raw tier values as of that refresh, fully replacing
--     the previous window's rows each time. Two read patterns, both cheap
--     and indexed: "top N" (order by rnk limit N) and "my own row" (a
--     single user_id lookup) — no live ranking computation on read, ever.
--
-- get_leaderboard_page()'s own ranking logic (docs/ARCHITECTURE.md Section
-- 7's 7-tier cascade) is UNCHANGED and still exists — refresh_leaderboard_
-- snapshot() below duplicates its three scope branches rather than calling
-- it, because get_leaderboard_page() deliberately only ever returns top-N
-- + the caller's row (see its own migration's comment), and a snapshot
-- refresh needs every row. Same reasoning as that migration's own choice of
-- three static branches over dynamic SQL: no injection surface, easy to
-- read, and there are only ever three scopes.

create table public.leaderboard_snapshots (
  scope             text not null check (scope in ('daily', 'weekly', 'all-time')),
  period_key        date not null, -- stat_date / week_start / a fixed dummy date for all-time (ignored on read)
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
  scope                     text not null check (scope in ('daily', 'weekly', 'all-time')),
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
  if p_scope = 'daily' then
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

    delete from public.leaderboard_ranks where scope = 'daily' and period_key = p_period_key;

    insert into public.leaderboard_ranks (
      scope, period_key, user_id, rnk, max_score, sum_score, max_time_bonus_micros,
      sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed
    )
    select 'daily', p_period_key, s.user_id, rank() over (
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

  elsif p_scope = 'weekly' then
    with ranked as (
      select s.user_id from public.weekly_stats s where s.week_start = p_period_key
    )
    select count(*) into v_total from ranked;

    delete from public.leaderboard_ranks where scope = 'weekly' and period_key = p_period_key;

    insert into public.leaderboard_ranks (
      scope, period_key, user_id, rnk, max_score, sum_score, max_time_bonus_micros,
      sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed
    )
    select 'weekly', p_period_key, s.user_id, rank() over (
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
    from public.weekly_stats s
    where s.week_start = p_period_key;

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
