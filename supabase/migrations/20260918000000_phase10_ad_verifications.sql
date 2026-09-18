-- Match Emojis Daily — Phase 10: ad_verifications table for AdMob SSV
--
-- Backs server-side verification of rewarded-ad completions (ad-life grant
-- and bonus-round entry). Per the standing score-integrity rule
-- (docs/DECISIONS.md), a client-reported "ad watched" flag is never trusted
-- on its own — score-replay/index.ts now requires a matching row here
-- before it will credit an adLifeUsed=true level or an isBonus level.
--
-- Rows are written exclusively by the admob-ssv Edge Function, which is
-- invoked directly by Google's AdMob servers (a server-to-server GET
-- callback, not the client) after independently verifying that callback's
-- cryptographic signature. See server/functions/admob-ssv/index.ts and
-- docs/ARCHITECTURE.md Section 5 for the full mechanism.
--
-- Run via the Supabase SQL Editor after the Phase 8 migrations.

create table if not exists public.ad_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  slot_index int not null,
  -- 'life' = ad-earned life grant (Section 3.4); 'bonus' = bonus-round
  -- entry gate (Section 3.5). Matches the `type` segment of the SSV
  -- custom_data string, ${attemptId}:${slotIndex}:${type}.
  ad_type text not null check (ad_type in ('life', 'bonus')),
  -- AdMob's own per-reward transaction identifier — globally unique per
  -- Google's SSV docs, so this is the real replay-prevention key (a
  -- resourceful client can't get a second verified row by re-submitting
  -- the same callback, and Google itself won't reuse a transaction_id).
  transaction_id text not null unique,
  verified_at timestamptz not null default now()
);

-- One verified ad per (attempt, slot, type) is all score-replay ever looks
-- for — a second real ad watched for the same slot/type (e.g. a retried
-- SSV ping) is harmless and just doesn't need a second row, so this isn't
-- a uniqueness constraint, only an index for score-replay's lookup query.
create index if not exists ad_verifications_attempt_slot_type_idx
  on public.ad_verifications (attempt_id, slot_index, ad_type);

alter table public.ad_verifications enable row level security;

-- No client-facing policy at all, in either direction — not even a
-- players-can-read-their-own-rows SELECT policy. Nothing in the client
-- needs to read this table (the "ad watched" UI state is purely local to
-- the in-progress attempt screen); only the admob-ssv Edge Function
-- (INSERT, service-role) and score-replay (SELECT, service-role) ever
-- touch it, and both connect with the service-role key, which bypasses RLS
-- entirely. This is the same "service-role-only, no exceptions" posture as
-- every other write-path table introduced since Phase 2.

comment on table public.ad_verifications is
  'Server-verified AdMob rewarded-ad completions (SSV), written only by admob-ssv and read only by score-replay. See docs/ARCHITECTURE.md Section 5.';
