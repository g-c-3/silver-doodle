-- Match Emojis Daily — Phase 2 fix: missing table grants + linter hardening
--
-- BUG: the original Phase 2 migration (20260912000000_phase2_schema.sql) enabled
-- RLS and wrote policies on every table, but never GRANTed the `authenticated`
-- role baseline privileges on those tables. RLS policies only filter *which rows*
-- a role can see once it already has permission to touch the table at all —
-- without the GRANT, Postgres refuses the whole query with "permission denied
-- for table X" before RLS is even evaluated. This was the exact error hit while
-- testing the Phase 3 auth flow (profile load failing right after a successful
-- sign-in). Confirmed via the client's diagnostic error message, not guessed.
--
-- Also folds in three safe fixes surfaced by the Supabase Security Advisor while
-- debugging the above (run via Dashboard > Advisors > Security Advisor):
--   1. `search_path` hardening on three trigger functions that didn't have it set.
--   2. Revoking the default PUBLIC execute grant on a SECURITY DEFINER function
--      that's only ever meant to run as a trigger, never called directly.
--   3. Rewriting `auth.uid()` as `(select auth.uid())` in RLS policies — a
--      performance fix (lets Postgres evaluate it once per query instead of
--      once per row), not a correctness fix.
--
-- NOT fixed here, on purpose: the linter flags public.leaderboard_profiles as a
-- "Security Definer View" (critical). That's intentional, not an oversight — see
-- docs/DECISIONS.md's Phase 2 fix entry for why switching it to SECURITY INVOKER
-- would break the leaderboard rather than improve security.

-- ============================================================================
-- 1. Grants (the actual bug)
-- ============================================================================

grant usage on schema public to authenticated;

grant select, update on public.users to authenticated;
grant select on public.daily_game_definitions to authenticated;
grant select on public.daily_game_definition_slots to authenticated;
grant select on public.player_daily_order to authenticated;
grant select on public.attempts to authenticated;
grant select on public.daily_stats to authenticated;
grant select on public.weekly_stats to authenticated;
grant select on public.all_time_stats to authenticated;
grant select on public.user_year_activity to authenticated;
grant select on public.leaderboard_profiles to authenticated; -- reaffirmed; harmless if already present

-- ============================================================================
-- 2. search_path hardening (Function Search Path Mutable, x3)
-- ============================================================================

alter function public.set_updated_at() set search_path = '';
alter function public.protect_users_identity_columns() set search_path = '';
alter function public.validate_game_order() set search_path = '';

-- ============================================================================
-- 3. Revoke default PUBLIC execute grant (Public Can Execute SECURITY DEFINER Function)
-- Trigger execution does not require the invoking session to hold EXECUTE on the
-- trigger function — it always runs under the function owner's context as part
-- of the DML operation — so this revoke does not break the on_auth_user_created /
-- on_auth_user_email_confirmed triggers.
-- ============================================================================

revoke execute on function public.handle_auth_user_sync() from public;

-- ============================================================================
-- 4. auth.uid() -> (select auth.uid()) in RLS policies (Auth RLS Initialization Plan, x5)
-- ============================================================================

alter policy users_select_own on public.users
  using ((select auth.uid()) = id);

alter policy users_update_own on public.users
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

alter policy player_daily_order_select_own on public.player_daily_order
  using ((select auth.uid()) = user_id);

alter policy attempts_select_own on public.attempts
  using ((select auth.uid()) = user_id);

alter policy user_year_activity_select_own on public.user_year_activity
  using ((select auth.uid()) = user_id);
