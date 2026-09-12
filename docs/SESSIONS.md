# Sessions

Most recent entry first.

---

**2026-09-12 — Phase 4 core game client session**

Built: `client/src/js/game-engine.js` (new) — pure match-3 logic: seeded RNG (cyrb53 hash + mulberry32), 8x8 board generation guaranteeing no pre-existing matches and at least one legal move, match detection, the scoring formula from ARCHITECTURE.md Section 3.2 including H+V combo doubling via union-find grouping, and gravity/refill cascade resolution. `client/src/js/attempt.js` (new) — the attempt state machine: 26-slot forced-sequential play against the fixed per-slot move-target table, a shared 3-life pool, one ad-earned life per level offered on timeout, a bonus round triggered every 3rd completed slot mixing emoji from the last 3 completed themes, tap-select-then-tap-adjacent swap input, and `{seed, moves[]}` payload assembly. `client/src/index.html`, `client/src/js/app.js`, `client/src/css/styles.css` updated to add the Play button and the new game/bonus-prompt/attempt-summary screens to the existing screen router.

Several values needed to actually run a level aren't specified anywhere in ARCHITECTURE.md (board size, starting lives, what makes a level succeed or fail, bonus-round move target and failure behavior) — each was resolved with an explicit, flagged default rather than left blocking. Full list and reasoning in DECISIONS.md's "Phase 4 core game client session" block. Two later-phase dependencies were stubbed rather than built early: the daily game-definition (seed + theme shuffle) is generated client-side pending Phase 6, and both ad-gated moments (ad-life on timeout, bonus-round entry) grant immediately with a visibly-labeled dev stub pending Phase 10's real AdMob integration. Neither stub touches the score-integrity rule — no score is submitted or persisted yet, since Phase 5 (the validating Edge Function) doesn't exist; the client-computed score is explicitly labeled as not server-validated everywhere it's shown.

The originally-referenced "existing HTML/CSS/JS match-3 prototype" mentioned in ROADMAP.md's Phase 4 line was not found anywhere in the repo (confirmed via a full tarball listing) — nothing under `client/` predates this session except the Phase 3 auth/profile files. The match-3 engine was written fresh against the ARCHITECTURE.md Section 3 spec rather than ported from a file that doesn't exist in this repo. If a prototype exists outside the repo, it wasn't available to this session — flagging in case that was assumed carried over from context this repo doesn't retain.

Bugs fixed: one, caught before delivery via a standalone Node sanity test rather than shipped and found later — `generateBoard()`'s no-pregen-match check compared against the in-progress row before that row had been appended to the board array, throwing on the third cell of the very first row. Fixed by appending each row to the board array immediately rather than building it in a separate local array first.

Decisions made: see DECISIONS.md, 2026-09-12 "Phase 4 core game client session" block — board size/piece count, starting lives, level completion/failure rule, bonus-round move target and failure behavior, and the two dev-stub call-outs.

**Next session start point:** manually test the full Phase 4 flow via GitHub Pages (no Capacitor wrapper needed, same as Phase 3 testing) — play a full 26-slot attempt, confirm the bonus prompt fires after slots C/F/I/L/O/R/U/X, confirm life-pool depletion ends the attempt cleanly, confirm the HUD (timer/moves/lives/score) stays accurate through cascades. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity (the Edge Function that will make the score this session's client displays actually authoritative).

---

**2026-09-12 — Phase 3 confirmed working; cleanup**

Built: nothing new — this closes out Phase 3. Confirmed the full auth flow end to end against the live Supabase project after the grants fix: email link → tap → session established → profile loads → home screen → profile screen (display name edit + change-email flow) all working. Two small cleanups: reverted the temporary diagnostic error message in `client/src/js/app.js` back to a plain user-facing one, and added `autocomplete="off"` to both name-entry inputs in `client/src/index.html` after mobile browser autofill dropped a full email address into the "Your name" field during testing (harmless, just meant fixing the display name by hand once).

Bugs fixed: none this entry (see the previous "Phase 2 fix" entry for the actual bug).

Decisions made: none new.

**Next session start point:** Phase 3 is complete and confirmed. Proceed to Phase 4 — Core game client (port the existing HTML/CSS/JS match-3 prototype into `client/src/`, replacing the `#screen-home` placeholder with the actual daily puzzle).

---

**2026-09-12 — Phase 2 fix (missing grants + linter hardening)**

Built: `supabase/migrations/20260912010000_phase2_fix_grants_and_hardening.sql`.

Bugs fixed: `public.users` (and every other table) had RLS policies but no `GRANT` to the `authenticated` role, so every client read failed with "permission denied for table X" regardless of RLS — surfaced during Phase 3 auth testing as a profile-load failure right after a successful sign-in, confirmed via a temporary diagnostic error message in `app.js` rather than guessed. Fix: explicit `GRANT SELECT`/`UPDATE` per table. Also picked up and fixed, from the same Supabase Security Advisor pass: missing `search_path` on three trigger functions, a stray default `PUBLIC EXECUTE` grant on a security-definer trigger function, and five RLS policies rewritten to use `(select auth.uid())` for query-planner performance.

Decisions made: see DECISIONS.md, 2026-09-12 "Phase 2 fix" block — most notably, *not* fixing the linter's "Security Definer View" finding on `leaderboard_profiles`, since the suggested fix would silently break the leaderboard.

**Next session start point:** run the fix migration via Supabase SQL Editor, then remove the temporary diagnostic error-message change in `client/src/js/app.js` (revert to a plain user-facing message) and retest the Phase 3 auth flow end to end. Once confirmed working, check off Phase 3 in ROADMAP.md and proceed to Phase 4 — Core game client.

---

**2026-09-12 — Phase 3 auth session (link-flow pivot)**

Built: reworked the Phase 3 client files delivered earlier this session — `client/src/index.html`, `client/src/js/config.js`, `client/src/js/auth.js`, `client/src/js/app.js` — after manual testing found Supabase's default email sender can't have its templates edited (needed to expose a typed OTP code) without custom SMTP or a Send Email hook, both deliberately deferred. Switched the whole auth flow from a typed 6-digit code to tapping Supabase's default confirmation-link email: `Auth.sendLoginLink` replaces the old send/verify-code pair, and `app.js` now routes purely off `onAuthStateChange` (`INITIAL_SESSION`, `SIGNED_IN`, `USER_UPDATED`) rather than a manual code-verification step. Email change follows the same link pattern. `client/src/js/profile.js` and `client/src/css/styles.css` were untouched by this rework.

Bugs fixed: none — this wasn't a bug in the written code, it was a first-time-test discovery that the intended UX (typed code) wasn't achievable within the infra already in place, resolved by changing the UX rather than standing up more infra early.

Decisions made: see DECISIONS.md, 2026-09-12 "Phase 3 auth session (link-flow pivot)" block — the code-to-link switch, and the new required Site URL / Redirect URLs dashboard config.

Known gap, not a bug: confirmed working through the email-send step during this session; end-to-end confirmation (tapping the link and landing back in the app signed in) had not yet been verified when this entry was written.

**Next session start point:** confirm the Supabase Dashboard > Authentication > URL Configuration Site URL / Redirect URLs are set to `https://g-c-3.github.io/silver-doodle/client/src/index.html`, then re-test: request a link, tap it from the email client, and confirm landing back on the app already signed in (should reach either the name-setup screen for a new account or the home placeholder for a returning one). Once confirmed, check off Phase 3 in ROADMAP.md and proceed to Phase 4 — Core game client.

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
