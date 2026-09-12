# Sessions

Most recent entry first.

---

**2026-09-12 — Phase 3 auth session**

Built: `client/src/index.html`, `client/src/css/styles.css`, `client/src/js/config.js`, `client/src/js/supabaseClient.js`, `client/src/js/auth.js`, `client/src/js/profile.js`, `client/src/js/app.js` — the first client code in the repo. A single unified email-OTP form handles both signup and login (Supabase's `signInWithOtp` creates the account on first use; the Phase 2 trigger mirrors it into `public.users` automatically), followed by a 6-digit code screen, an optional first-login "set your display name" nudge, a placeholder home screen (Phase 4 replaces its contents with the actual game), and a profile screen supporting display-name edits and a two-step email-change flow (new address entered, confirmation code sent to it, verified via `verifyOtp` with `type: 'email_change'`). Email is never written directly to `public.users` from the client — only through the Supabase Auth email-change flow, consistent with the Phase 2 RLS/trigger design that locks `users.email` to service-role writes.

Bugs fixed: none (new code, not yet exercised against the live project).

Decisions made: none new — this session applied ARCHITECTURE.md Section 10 as written, no deviations worth recording in DECISIONS.md.

Known gap, not a bug: `client/src/js/config.js` ships with a placeholder `SUPABASE_ANON_KEY` that must be replaced with the real anon key (Supabase Dashboard > Project Settings > API) before the flow will work at all.

**Next session start point:** fill in the real anon key in `client/src/js/config.js`, then manually test the auth + profile flow (can be opened as a plain page in a mobile browser — no Capacitor wrapper exists yet to test on-device). Once confirmed working, check off Phase 3 in ROADMAP.md and proceed to Phase 4 — Core game client (port the existing HTML/CSS/JS match-3 prototype into `client/src/`, replacing the `#screen-home` placeholder).

---

**2026-09-12 — Phase 2 database schema session**

Built: `supabase/migrations/20260912000000_phase2_schema.sql` (new file, new `supabase/` top-level directory). Implements the full data model from ARCHITECTURE.md Section 6: `users` (kept in sync with `auth.users` via trigger, `display_name` client-editable, `email`/`id` locked to service-role writes only), `daily_game_definitions` + `daily_game_definition_slots` (split into two tables — 12 rows/day for the definitions, 26 child rows each for the per-slot theme/board shuffle — rather than one wide table, since the original indicative column list conflated the two granularities), `player_daily_order` (with a trigger validating the stored array is a true 0–11 permutation), `attempts` (summary-only; raw `{seed, moves[]}` payloads are never persisted, matching the infra cost-planning decision that only summary rows are permanent), `daily_stats`/`weekly_stats`/`all_time_stats`, and `user_year_activity`. Row Level Security enabled on every table: players can read their own rows plus public leaderboard aggregates and a name-only `leaderboard_profiles` view; no table is client-writable except `users.display_name` — attempt start/completion, stats aggregation, and game-definition generation are all reserved for service-role Edge Functions in later phases.

Bugs fixed: none (new schema, not yet run against the live project).

Decisions made: see DECISIONS.md, 2026-09-12 (Phase 2) block — the definitions/slots table split, and the attempts_started vs. attempts_completed averaging interpretation for the leaderboard cascade's four "average" tiers.

**Next session start point:** the migration file has been delivered but not yet run. First, confirm it was pasted into the Supabase SQL Editor and executed successfully (check for errors, especially around the `auth.users` triggers, which need appropriate permissions). Once confirmed, check off Phase 2 in ROADMAP.md and proceed to Phase 3 — Auth (email OTP signup/login flow, profile screen for name/email changes).

---

**2026-09-12 — Phase 1 infra session**

Built: no code — this session was entirely manual account/infra setup, walked through step by step. Package name decided (`com.gc.matchemojisdaily`). Firebase project created, Android app registered, `google-services.json` obtained and stored as a GitHub secret, Analytics confirmed active, Crashlytics enablement deferred to Phase 4. AdMob account created, app registered, all 3 ad units created (Rewarded/Interstitial/Banner) with real IDs, linked to Firebase. Supabase project created (Mumbai region), email OTP auth confirmed enabled and hardened (6-digit codes, shorter expiry, secure email change on), personal access token generated and scoped narrowly (Edge Functions: Read-write only). Android release keystore generated (30-year validity). GitHub Pages enabled. All 6 required GitHub Actions secrets added and confirmed via screenshot: `GOOGLE_SERVICES_JSON`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

Bugs/incidents: a Supabase access token was pasted into chat despite guidance not to; treated as compromised, revoked, and rotated before being added as a secret directly. See DECISIONS.md for the standing practice this established. Separately corrected a wrong assumption from ROADMAP.md's original Phase 1 write-up: Android keystores in PKCS12 format (the modern default) don't support separate store/key passwords, so only 3 distinct secret values exist for signing, not 4 — the two password secrets intentionally hold the same value.

Decisions made: see DECISIONS.md, 2026-09-12 block — package name, keystore password-model correction, secret-handling practice going forward, Crashlytics and SMTP deferrals (both intentional, not oversights).

**Next session start point:** Phase 1 is functionally complete except two non-blocking items — placeholder branding assets (app icon, splash screen; no account dependency, can be generated directly) and starting Google Play Console identity verification (long lead time, worth starting early). Otherwise, proceed to Phase 2 — database schema (Postgres tables/migrations in Supabase per ARCHITECTURE.md Section 6).

---

**2026-09-11 — Seed session**

Built: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/SESSIONS.md` (this file), root `README.md`, `client/README.md` and `server/functions/README.md` placeholders, `privacy-policy.html` placeholder. The target repo (`g-c-3/silver-doodle`) exists and was empty prior to this commit; files were delivered for manual upload rather than pushed directly, since the connected GitHub integration lacked write access to this repository.

Bugs fixed: none (first session).

Decisions made: see `docs/DECISIONS.md`, 2026-09-11 block — covers the full design history preceding this repo's creation (monetization removal, leaderboard scopes, attempt accounting, level/theme shuffle model, ad cadence, auth model, backend/client stack selection, score-integrity model, infra cost planning).

**Next session start point:** Phase 1 of `docs/ROADMAP.md` — infra and secrets setup. This phase is manual/one-time and needs input to proceed: Android keystore generation, Supabase project creation (access token + project ref), Firebase project creation (Analytics + Crashlytics only), and AdMob account/app creation. None of these can be completed without the account holder's direct action.
