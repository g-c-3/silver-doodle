# Roadmap

Last updated: 2026-09-12 (Phase 3 confirmed working).

- [x] **Phase 0 — Repo scaffold & docs.** Seed `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/SESSIONS.md`; establish folder structure.
- [ ] **Phase 1 — Infra & secrets (manual, one-time).** Mostly complete — see below.
  - [x] **Package name.** Decided: `com.gc.matchemojisdaily`.
  - [x] **Supabase.** Project created (`match-emojis-daily`, South Asia / Mumbai region, project ref `wgkcxixocfzydawurluh`). Email provider enabled with OTP (6-digit code, 10–15 min expiry, secure email change on). Access token generated, scoped to this project with Edge Functions: Read-write only, and stored as the `SUPABASE_ACCESS_TOKEN` GitHub secret; project ref stored as `SUPABASE_PROJECT_REF`. Custom SMTP provider still deliberately deferred until real users exist — Supabase's dev-mode sender is fine for now.
  - [x] **Firebase (Analytics + Crashlytics only).** Project created and linked to Google Analytics. Android app registered under the package name above. `google-services.json` downloaded and stored as the `GOOGLE_SERVICES_JSON` GitHub secret (not committed directly, since the repo is public). Crashlytics enablement deferred until real app code exists to integrate the SDK into (Phase 4) — nothing meaningful to toggle before then.
  - [x] **Google AdMob.** Account created. App registered under the same package name. All three ad units created (Rewarded, Interstitial, Banner) with real IDs on record. Linked to the Firebase project for revenue-by-cohort Analytics reporting. Production ad unit IDs stay a Phase 12 item; current IDs are usable for development.
  - [x] **Android signing.** Release keystore generated (30-year validity, alias `match-emojis-daily`). Stored as 4 GitHub secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Note: modern PKCS12 keystores don't support separate store/key passwords — both secrets hold the same value, corrected from the original plan's assumption of two distinct passwords.
  - [x] **GitHub repo settings.** GitHub Pages enabled. All 6 secrets above added and confirmed via screenshot. (The connected GitHub integration still lacks write access to this repo — not blocking, since the file-delivery workflow is manual-upload-only.)
  - [ ] **Branding assets.** Placeholder app icon / adaptive icon and splash screen — not yet generated. No account dependency; can be done anytime.
  - [ ] **Google Play Console account** (not blocking, but has long lead time). Not yet started.
- [x] **Phase 2 — Database schema.** `supabase/migrations/20260912000000_phase2_schema.sql` run successfully against the live Supabase project via the SQL Editor. Covers `users`, `daily_game_definitions` + `daily_game_definition_slots`, `player_daily_order`, `attempts`, `daily_stats`, `weekly_stats`, `all_time_stats`, `user_year_activity`, plus RLS locking all writes to service-role only.
- [x] **Phase 3 — Auth.** `client/src/` — email confirmation-link signup/login flow and a profile screen (display name editable directly, email change via a second confirmation link). Confirmed working end to end against the live Supabase project, including the Phase 2 grants fix.
- [ ] **Phase 4 — Core game client.** Port the existing HTML/CSS/JS match-3 prototype into `client/src/`; implement the 26-slot theme system, fixed per-slot move targets, shared per-attempt life pool, forced-sequential play, and bonus-round trigger.
- [ ] **Phase 5 — Score integrity.** Edge Function that accepts `{seed, moves[]}`, deterministically replays a run, and returns the authoritative score/time-bonus/lives-used/levels-reached. Wired as a single call per completed attempt.
- [ ] **Phase 6 — Daily game-definition generation.** Scheduled job producing the day's 12 game definitions (board pattern + theme shuffle per slot) and assigning each player's serving-order permutation.
- [ ] **Phase 7 — Leaderboards.** 7-tier cascade queries for daily, weekly, and all-time scopes; per-player rank-breakdown data for the "how you got this rank" UI.
- [ ] **Phase 8 — Attempt cap & forfeit tracking.** 12/day slot enforcement keyed to start timestamp; server-side heartbeat/timeout forfeit detection; attempt-history UI (start time, status, scored-day).
- [ ] **Phase 9 — All-time stats & calendar.** Per-player stats view; month/year calendar reading `user_year_activity`, drilling into per-day attempt detail.
- [ ] **Phase 10 — Ads.** AdMob rewarded-video integration for ad-life and bonus-round entry (single ad per trigger); AdMob SSV verification wired to the score-integrity Edge Function.
- [ ] **Phase 11 — CI/CD.** `build-apk.yml` and `deploy-functions.yml` wired to the Phase 1 secrets; first real APK produced via GitHub Actions and attached to a GitHub Release.
- [ ] **Phase 12 — Play Store prep.** Privacy policy page published via GitHub Pages; production AdMob ad unit IDs swapped in; store listing assets.

Phases are worked in order; a phase is not started without the prior phase's code passing CI.
