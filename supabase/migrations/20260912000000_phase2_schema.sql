-- Match Emojis Daily — Phase 2: Database Schema
-- Applies the data model in docs/ARCHITECTURE.md Section 6, refined into concrete
-- tables/columns. Run this once via the Supabase SQL Editor (Dashboard > SQL Editor
-- > New query > paste this file > Run). Idempotent-safe guards are NOT included
-- deliberately — this is a first migration against an empty schema; re-running it
-- on a schema that already has these objects will error, which is the desired
-- "don't silently double-apply" behavior for a manual, mobile-only workflow.

-- ============================================================================
-- 1. users
-- Mirrors auth.users (Supabase-managed) with the app-owned profile fields.
-- Row is created automatically by a trigger on auth.users insert (below), never
-- inserted directly by the client.
-- ============================================================================

create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  display_name  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Keep updated_at current on every row change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

-- id and email are owned by auth.users, not editable by the player directly.
-- display_name is the only client-editable field on this table; email changes
-- must go through supabase.auth.updateUser({ email }) (OTP re-verification),
-- which re-fires the sync trigger below rather than being written here directly.
create or replace function public.protect_users_identity_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    new.id := old.id;
    new.email := old.email;
  end if;
  return new;
end;
$$;

create trigger users_protect_identity_columns
  before update on public.users
  for each row
  execute function public.protect_users_identity_columns();

-- Sync from auth.users -> public.users on signup and on confirmed email change.
create or replace function public.handle_auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_auth_user_sync();

create trigger on_auth_user_email_confirmed
  after update of email on auth.users
  for each row
  execute function public.handle_auth_user_sync();

-- Leaderboard-safe public view: other players' display names only, never email.
create view public.leaderboard_profiles as
  select id, display_name from public.users;

-- ============================================================================
-- 2. daily_game_definitions + daily_game_definition_slots
-- 12 game definitions/day (game_index 0-11), each holding its own 26-slot
-- (A-Z / slot_index 0-25) theme shuffle + board pattern. Move target is NOT
-- stored here — it is fixed per slot_index per ARCHITECTURE.md Section 3.1
-- and is a shared constant in client + Edge Function code, not per-game data.
-- ============================================================================

create table public.daily_game_definitions (
  id          uuid primary key default gen_random_uuid(),
  game_date   date not null,
  game_index  smallint not null check (game_index between 0 and 11),
  created_at  timestamptz not null default now(),
  unique (game_date, game_index)
);

create table public.daily_game_definition_slots (
  id                    uuid primary key default gen_random_uuid(),
  game_definition_id    uuid not null references public.daily_game_definitions(id) on delete cascade,
  slot_index            smallint not null check (slot_index between 0 and 25),
  theme_id              smallint not null check (theme_id between 1 and 26),
  board_pattern         jsonb not null,
  unique (game_definition_id, slot_index)
);

create index idx_daily_game_definitions_date on public.daily_game_definitions (game_date);
create index idx_daily_game_definition_slots_def on public.daily_game_definition_slots (game_definition_id);

-- ============================================================================
-- 3. player_daily_order
-- Per-player permutation of the day's 12 game-definition indices, assigned at
-- the player's first attempt of the day (written by a service-role Edge
-- Function in a later phase, never inserted by the client directly).
-- ============================================================================

create table public.player_daily_order (
  user_id      uuid not null references public.users(id) on delete cascade,
  game_date    date not null,
  game_order   smallint[] not null,
  assigned_at  timestamptz not null default now(),
  primary key (user_id, game_date)
);

-- Guard against a malformed permutation slipping in even from service-role code.
create or replace function public.validate_game_order()
returns trigger
language plpgsql
as $$
begin
  if array_length(new.game_order, 1) <> 12
     or (select count(distinct v) from unnest(new.game_order) as v) <> 12
     or exists (select 1 from unnest(new.game_order) as v where v < 0 or v > 11)
  then
    raise exception 'game_order must be a permutation of 0..11';
  end if;
  return new;
end;
$$;

create trigger player_daily_order_validate
  before insert or update on public.player_daily_order
  for each row
  execute function public.validate_game_order();

-- ============================================================================
-- 4. attempts
-- One row per attempt. Permanent summary data (needed indefinitely for
-- all-time stats + calendar per DECISIONS.md's infra cost planning) — raw
-- {seed, moves[]} replay payloads are NOT persisted here; they are consumed
-- transiently by the score-replay Edge Function (Phase 5) and discarded.
-- ============================================================================

create type public.attempt_status as enum ('in_progress', 'completed', 'forfeited');

create table public.attempts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users(id) on delete cascade,
  game_definition_id   uuid not null references public.daily_game_definitions(id),
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  score_day            date,                    -- set on completion; the day this attempt is scored against (Section 8)
  status               public.attempt_status not null default 'in_progress',
  score                integer not null default 0,
  time_bonus_micros    bigint not null default 0,  -- raw duration, digit-clock accumulated, stored as total microseconds
  lives_used           smallint not null default 0,
  levels_reached       smallint not null default 0,
  created_at           timestamptz not null default now()
);

-- Slot-cap enforcement (12/day) keys off started_at, per user, per calendar day.
create index idx_attempts_user_started on public.attempts (user_id, started_at);
-- Leaderboard settlement / score_day lookups.
create index idx_attempts_score_day on public.attempts (score_day) where status = 'completed';

-- ============================================================================
-- 5. daily_stats / weekly_stats / all_time_stats
-- Rolling aggregates feeding the 7-tier leaderboard cascade (ARCHITECTURE.md
-- Section 7) without a live re-scan of `attempts`. Updated transactionally by
-- the score-replay Edge Function on each attempt completion (Phase 5).
--
-- ASSUMPTION (flagged for review, not blocking): "attempts actually played"
-- for tiers 2/4/5/7 (the four *average* tiers) is read as completed attempts
-- only — forfeited attempts have no score/time-bonus/levels value to average
-- in. Tier 6 ("number of attempts played") is read as every attempt started,
-- completed or forfeited, since a forfeited attempt still consumed a slot.
-- This is why attempts_started and attempts_completed are tracked separately
-- below. Revisit in DECISIONS.md if this reading is wrong.
-- ============================================================================

create table public.daily_stats (
  user_id                  uuid not null references public.users(id) on delete cascade,
  stat_date                date not null,
  max_score                integer not null default 0,
  sum_score                bigint not null default 0,
  max_time_bonus_micros    bigint not null default 0,
  sum_time_bonus_micros    bigint not null default 0,
  sum_lives_used           bigint not null default 0,
  sum_levels_played        bigint not null default 0,
  attempts_started         integer not null default 0,
  attempts_completed       integer not null default 0,
  updated_at               timestamptz not null default now(),
  primary key (user_id, stat_date)
);

create table public.weekly_stats (
  user_id                  uuid not null references public.users(id) on delete cascade,
  week_start               date not null,  -- Monday 00:00 IST, per DECISIONS.md
  max_score                integer not null default 0,
  sum_score                bigint not null default 0,
  max_time_bonus_micros    bigint not null default 0,
  sum_time_bonus_micros    bigint not null default 0,
  sum_lives_used           bigint not null default 0,
  sum_levels_played        bigint not null default 0,
  attempts_started         integer not null default 0,
  attempts_completed       integer not null default 0,
  updated_at               timestamptz not null default now(),
  primary key (user_id, week_start)
);

create table public.all_time_stats (
  user_id                  uuid primary key references public.users(id) on delete cascade,
  max_score                integer not null default 0,
  sum_score                bigint not null default 0,
  max_time_bonus_micros    bigint not null default 0,
  sum_time_bonus_micros    bigint not null default 0,
  sum_lives_used           bigint not null default 0,
  sum_levels_played        bigint not null default 0,
  attempts_started         integer not null default 0,
  attempts_completed       integer not null default 0,
  updated_at               timestamptz not null default now()
);

-- Leading columns for the cascade's first tie-break; full multi-column tuning
-- happens in Phase 7 once the actual leaderboard queries are written.
create index idx_daily_stats_rank on public.daily_stats (stat_date, max_score desc);
create index idx_weekly_stats_rank on public.weekly_stats (week_start, max_score desc);
create index idx_all_time_stats_rank on public.all_time_stats (max_score desc);

-- ============================================================================
-- 6. user_year_activity
-- Lightweight per-day index for the personal calendar view (Section 9),
-- avoiding a full-month scan of `attempts` on every render.
-- ============================================================================

create table public.user_year_activity (
  user_id          uuid not null references public.users(id) on delete cascade,
  activity_date    date not null,
  attempts_count   smallint not null default 0,
  primary key (user_id, activity_date)
);

create index idx_user_year_activity_year on public.user_year_activity (user_id, date_part('year', activity_date));

-- ============================================================================
-- 7. Row Level Security
-- Default posture: players can read their own private data plus the public
-- leaderboard aggregates and profile names; nothing is writable by the client
-- directly except their own display_name. Everything else (attempts,
-- game-definition generation, order assignment, stats aggregation) is written
-- only by service-role Edge Functions in later phases, which bypass RLS.
-- ============================================================================

alter table public.users enable row level security;
alter table public.daily_game_definitions enable row level security;
alter table public.daily_game_definition_slots enable row level security;
alter table public.player_daily_order enable row level security;
alter table public.attempts enable row level security;
alter table public.daily_stats enable row level security;
alter table public.weekly_stats enable row level security;
alter table public.all_time_stats enable row level security;
alter table public.user_year_activity enable row level security;

-- users: read/update own row only. (Public-facing names go through the
-- leaderboard_profiles view instead, which has no RLS of its own to restrict
-- since it exposes no sensitive columns.)
create policy users_select_own on public.users
  for select using (auth.uid() = id);
create policy users_update_own on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- daily_game_definitions / slots: readable by any authenticated player (all
-- 12/day are identical for everyone — see ARCHITECTURE.md Section 4). No
-- client insert/update/delete.
create policy game_definitions_select_all on public.daily_game_definitions
  for select to authenticated using (true);
create policy game_definition_slots_select_all on public.daily_game_definition_slots
  for select to authenticated using (true);

-- player_daily_order: a player sees only their own serving order.
create policy player_daily_order_select_own on public.player_daily_order
  for select using (auth.uid() = user_id);

-- attempts: a player sees only their own attempts. No client insert/update —
-- starting and completing an attempt are both server-authoritative actions.
create policy attempts_select_own on public.attempts
  for select using (auth.uid() = user_id);

-- stats tables: public leaderboard reads (all rows, every scope). No client writes.
create policy daily_stats_select_all on public.daily_stats
  for select to authenticated using (true);
create policy weekly_stats_select_all on public.weekly_stats
  for select to authenticated using (true);
create policy all_time_stats_select_all on public.all_time_stats
  for select to authenticated using (true);

-- user_year_activity: personal calendar, own rows only.
create policy user_year_activity_select_own on public.user_year_activity
  for select using (auth.uid() = user_id);

grant select on public.leaderboard_profiles to authenticated;
