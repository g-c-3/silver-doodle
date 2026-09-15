-- Match Emojis Daily — Phase 8: heartbeat column for forfeit detection
--
-- Backs the heartbeat/timeout forfeit mechanism: attempt-heartbeat bumps
-- this on every client heartbeat while an attempt is in_progress;
-- forfeit-stale-attempts (a scheduled sweep) marks an attempt forfeited
-- once this falls too far behind. See docs/ARCHITECTURE.md Section 8.
--
-- Run via the Supabase SQL Editor after the Phase 8 atomic-slot-cap
-- migration.

alter table public.attempts
  add column if not exists last_heartbeat_at timestamptz not null default now();

comment on column public.attempts.last_heartbeat_at is
  'Bumped by attempt-heartbeat on every client heartbeat while status = in_progress. forfeit-stale-attempts (cron sweep) marks an attempt forfeited once this falls too far behind — see docs/ARCHITECTURE.md Section 8.';
