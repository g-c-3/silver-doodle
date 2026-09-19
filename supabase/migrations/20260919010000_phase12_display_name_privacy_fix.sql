-- Match Emojis Daily — Phase 12: display-name privacy + integrity fix
-- Following an external code review (see docs/DECISIONS.md's 2026-09-19
-- (later still) entry): the default display name on signup was derived
-- from the player's email address (the local-part before '@'), which is
-- shown on public leaderboards — contradicting privacy-policy.html's
-- statement that email is "never shown to other players", and exposing a
-- recognizable fragment of real users' email addresses today, not just as
-- a theoretical risk. Separately, display_name had no length/content
-- constraint enforced at the database level — client-side validation
-- (profile.js, index.html maxlength) is bypassable by any client that
-- talks to PostgREST directly with a valid session, since
-- users_update_own (Phase 2) lets any signed-in user update their own
-- display_name with no server-side check.
--
-- Run this once via the Supabase SQL Editor, same manual workflow as every
-- other migration in this repo (see phase2_schema.sql's header). Applied
-- against the live project, not just committed here — this file alone
-- changes nothing until it's actually run.

-- 1. Normalize any existing display_name that would violate the new
--    constraint below, BEFORE adding it — a modified client could already
--    have written something too long or empty via a direct PostgREST call
--    (no server-side check existed before this migration).
update public.users
set display_name = 'Player' || substr(id::text, 1, 6)
where char_length(trim(display_name)) = 0;

update public.users
set display_name = substr(display_name, 1, 24)
where char_length(display_name) > 24;

-- 2. Enforce the 1-24 character limit for everyone, at the database level —
--    closes the gap where only the client enforced this.
alter table public.users
  add constraint users_display_name_len check (char_length(display_name) between 1 and 24);

-- 3. New signups get a generic default, not their email's local-part.
create or replace function public.handle_auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      'Player' || substr(new.id::text, 1, 6)
    )
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

-- 4. Backfill existing accounts still on the old email-derived default.
--    RECOMMENDED: run this SELECT first and review the result set before
--    running the UPDATE below on a live project with real users — a player
--    who genuinely, deliberately renamed themselves to exactly match their
--    email's local-part is an unlikely edge case, but worth a quick look
--    rather than assuming.
--
--    select id, email, display_name from public.users
--      where display_name = split_part(email, '@', 1);

update public.users
set display_name = 'Player' || substr(id::text, 1, 6)
where display_name = split_part(email, '@', 1);
