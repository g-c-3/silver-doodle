# Sessions

Most recent entry first.

---

**2026-09-16 (continued) — Three device-testing bugs fixed, then Phase 11 (CI/CD) built ahead of Phase 10**

Continuation of the same day's session (see the Phase 9 entry below for what was built earlier). The person tested Phase 8/9 live on a real device and reported issues via screenshots; three separate bugs came out of that, fixed in order:

1. **Home's "N of 12 attempts left today" badge went stale after finishing an attempt**, only correcting itself on a manual page reload. Cause: `summary-home-btn`'s click handler called `showScreen('screen-home')` alone, never re-running the badge fetch. Fix: it now calls `renderHome()` first. The same bug existed on the rarer session-timeout-forfeit path in `attempt.js`; fixed there too (`refreshAttemptsLeftToday` exposed on `window` for that separate closure to call).

2. **A completed attempt could be silently lost and show up as `Forfeited`/score 0 in history**, if the one-shot `score-replay` submission hit a network error. Real score-integrity bug, not cosmetic: `finishAttempt()`/`failAttempt()` stopped the heartbeat immediately, so a failed submission left the attempt's row at `status: in_progress` with a frozen `last_heartbeat_at`, which `forfeit-stale-attempts`'s 5-minute sweep would eventually flip to `forfeited`, discarding a fully-played run. Fix, in `attempt.js`: the heartbeat now stays alive until `submitAttempt()` actually succeeds (confirmed safe — `score-replay` only refuses an attempt already `completed`, never `forfeited`), `submitAttempt()` now auto-retries 3x with backoff before giving up, and a new "Retry saving score" button lets the player retry any time after reconnecting. Also handled the edge case the retry logic itself introduces — a retry landing after an earlier try actually succeeded server-side (response merely lost in transit) now recognizes `score-replay`'s "already submitted" reply instead of treating it as a fresh failure. The two already-lost attempts from before this fix can't be recovered — no move data survives client-side to resubmit — this only prevents it going forward.

3. **Attempt-history rows showed a start time but never an end time.** `completed_at` was already being fetched in the query, just never rendered. Fixed in `attempt-history.js`: finished/forfeited rows now show a `start–end IST` range; still-`in_progress` rows fall back to start-time-only, correctly, since they have no `completed_at` yet.

**Then: Phase 11 (CI/CD) built, out of roadmap order, ahead of Phase 10 (Ads).** Prompted by starting to plan Phase 10 and checking the live repo tree first — `client/android/`, `client/capacitor.config.json`, and `.github/workflows/` didn't exist at all; everything tested so far had only ever been a plain web page via GitHub Pages. `@capacitor-community/admob` is a native plugin with no way to build or test it without a real Capacitor Android project existing, so Phase 11 was done first — flagged explicitly to the person rather than silently reordered; they deferred the call back ("your call").

New files: `client/package.json` (pinned exact `@capacitor/*` versions), `client/capacitor.config.json`, `supabase/config.toml`, `.github/workflows/build-apk.yml`, `.github/workflows/scripts/patch_build_gradle.py`, `.github/workflows/deploy-functions.yml`, root `.gitignore`. Full reasoning — especially *why* `client/android/` is deliberately never committed, and the `verify_jwt` risk the new `supabase/config.toml` closes — is in DECISIONS.md's 2026-09-16 Phase 11 entry; not repeated here.

**Verification done:** the Capacitor scaffold + Gradle patch was run end-to-end in a local sandbox — real `npx cap add android`/`cap sync` against the exact pinned versions being shipped, `patch_build_gradle.py` run against that real generated output and the result inspected by hand, brace-balance/JSON/YAML/TOML syntax all checked.
**Verification NOT done:** the actual `gradlew assembleRelease` step has never run — no Android SDK / Google Maven access in the sandbox used to build this. **Next session should start by watching the first live run of `build-apk.yml` after these files are committed, and be ready to iterate on the Gradle/Android SDK setup from whatever the Actions log shows** — some amount of back-and-forth here is expected and normal for a first native CI build, not a sign the approach is wrong.

---

**2026-09-16 — Phase 9 (All-time stats & calendar) built**

Started from the Phase 8 handoff point. Read ROADMAP.md, the last SESSIONS.md entry, DECISIONS.md, and ARCHITECTURE.md in full, then confirmed the schema/RLS picture directly against the live repo before writing anything: `record_attempt_start` (added during Phase 7) already writes to `user_year_activity` on every attempt start, so the calendar's data source is already populated — no new migration or Postgres function needed for this phase.

**New screen: `#screen-stats`, `client/src/js/stats.js`.** Two pieces:
- *Stat tiles* — days played, total attempts, best day, least day. "Total attempts" reads `all_time_stats.attempts_started` directly. "Days played"/"best day"/"least day" are derived client-side from the player's own `daily_stats` rows filtered to `attempts_completed > 0` (a day with no completed attempt has no real single-attempt score to rank), using `max_score` as the best/least metric — the same metric leaderboard tier 1 already uses, kept consistent deliberately.
- *Month calendar* — dot-marks days with any recorded activity by reading `user_year_activity` for the displayed year (fetched once per year, cached in memory across month navigation within that year). Tapping a marked day drills into that day's own `attempts` rows, queried the same way attempt-history.js already does (direct read via `attempts_select_own`, IST day-boundary window matching `record_attempt_start`'s own date scoping).

No new Edge Function was needed anywhere in this phase — every field read is already covered by existing RLS from Phase 2/7 (`all_time_stats` select-all, `daily_stats` select-all, `user_year_activity` select-own, `attempts` select-own), same reasoning Phase 8's attempt-history screen already established.

Wiring: `#screen-stats` added to the router in `app.js`, a new "Stats" button added to Home (between History and Profile), calendar prev/next and day-panel close buttons wired. CSS added under a new "Phase 9" section in `styles.css`, reusing the existing `.stat-grid`/`.stat-item` and `.history-list`/`.history-row` patterns rather than inventing new ones, plus new `.cal-*` classes for the calendar grid itself.

**Not done this session:** no live-device verification — this was built and locally sanity-checked (JS syntax check, HTML id cross-reference, mental read-through of the RLS policies against what's queried) but never actually loaded against the live Supabase project. **Next session should start by testing Phase 9 on-device before moving to Phase 10.**

---

**2026-09-15/16 — Phase 7 (Leaderboards) and Phase 8 (Attempt cap & forfeit tracking) completed; extensive live-debugging and UI polish**

Long continuous session, starting from the "Phase 7" handoff point in the previous entry and carrying through to a full UI polish pass two days later. Structured here roughly in the order things happened, since several fixes were found *because of* testing the feature before it, not planned upfront.

**Pre-Phase-7 bug fix:** `offerAdLife()` (the "out of lives — watch ad or give up?" prompt) never set `a.locked = true`, so the board underneath it stayed fully tappable — moves and score kept changing while the prompt was showing. Fixed by locking on prompt show, unlocking only once the player picks an option.

**Phase 7 — Leaderboards.** Discovered along the way, not assumed upfront: `daily_stats`/`weekly_stats`/`all_time_stats`/`user_year_activity` had existed since Phase 2 with nothing ever writing to them — `score-replay` only ever updated the `attempts` row itself. Closed with two new Postgres functions (`record_attempt_start`, `record_attempt_completion`, both service-role only) wired into `start-attempt`/`score-replay`. Built the `leaderboard` Edge Function on top — the 7-tier cascade (ARCHITECTURE.md Section 7) is computed in Deno over the fetched scope table rather than a raw SQL `ORDER BY` chain, deliberately, since a multi-expression tie-break chain with divide-by-zero guards is easier to get subtly wrong in SQL. Returns a ranked `top` list plus the caller's own `you` entry with `decidingTier`/`decidingTierName`. Client: `leaderboard.js` + `#screen-leaderboard`, three tabs (Daily/Weekly/All-time).

Debugging along the way: the stats migration wasn't run before the first test (PostgREST "function not found in schema cache" — a schema-creation step is separate from redeploying function code, a distinction that came up repeatedly this session); then `score-replay` was found silently swallowing `record_attempt_completion` failures (the error only ever reached the HTTP response body, never `console.error`) — the *first* instance of a pattern that recurred twice more later in the session. Verified end to end against two real test accounts (a second account, "GC", was created deliberately to prove the cascade actually ranks more than one player); every derived field (`avgScore`, `avgTimeBonusMicros`, etc.) checked out arithmetically against the raw `daily_stats` row.

**Scoring rule changed on request:** a failed (given-up) level now contributes its earned score to the attempt total, matching what the live HUD was already showing the player at the moment they gave up — previously it scored 0, per the original Section 3.3 rule. Time bonus and `levelsReached` stay excluded (the level itself was never cleared). Changed on both the client (`attempt.js`'s `failAttempt()`) and server (`score-replay`'s replay loop) together, since they have to agree.

**Idle-hint highlighting added, then corrected twice from live screenshots**, ending at: after 5s with no successful move, exactly one tile glows (the single tile to move), persisting until the next successful move restarts the countdown. The first version highlighted every cell touched by any legal move (nearly the whole 8x8 board); the second highlighted a resulting match's full run; neither was actually what was asked for.

**Toast (life-used/ad-life message) redesigned:** dropped the gradient-pill background entirely for large bold text with a text-shadow, shown 5s instead of 3s.

**Home screen additions:** a corner logout button (later upgraded from a native `window.confirm()`/`window.alert()` to fully themed in-app modals — `showConfirm()`/`showAlert()` in `app.js`, colored icon badges per alert type, reusable for anything added later).

**Phase 8 — Attempt cap & forfeit tracking.**
- *Slot cap:* the existing 12/day check was a count-then-insert with no lock — its own code comments already called it a "soft guard, not the real Phase 8 cap." Replaced with `start_attempt_slot`, a Postgres function that advisory-locks per (user, day) so a concurrent second call can't race past the cap or double-claim the same `game_index`. Not stress-tested against an actual race (would need two near-simultaneous calls to exercise), but the mechanism is sound and normal single-tab play is unaffected either way.
- *Forfeit detection:* `attempt-heartbeat` (client-invoked, ~20s interval for the life of an attempt, only bumps `attempts.last_heartbeat_at`) + `forfeit-stale-attempts` (a **scheduled** function via Supabase Cron, every 5 min, never client-invoked — marks `in_progress` attempts stale past 5 minutes as `forfeited`, score 0). Real debugging here too: the Cron job's "Succeeded" status turned out to only confirm the async `net.http_post` dispatch, not that the target function actually ran or did anything — the real cause of "nothing's being forfeited" was that the `last_heartbeat_at` column migration had never actually been run; separately, `forfeit-stale-attempts` had the same silent-error-swallowing bug as `score-replay` above (fixed the same way, `console.error` added). Verified against live data afterward: stale rows correctly flipped to `forfeited`, `completed` rows untouched.
- *A real, unrelated bug found while testing forfeit detection:* `app.js`'s `onAuthStateChange` listener force-navigated to Home on every `SIGNED_IN` event — but supabase-js re-fires `SIGNED_IN` with the same session whenever the browser tab regains focus, not just on a genuine new login. Every tab-switch-and-back was silently abandoning the in-progress game via `routeAfterAuth()`, without ever calling `failAttempt()`/`finishAttempt()` — so the heartbeat/tick timers never stopped, they just kept running against whatever the `a` object got reassigned to next. This was very likely the actual cause of a separately-reported "score carries over into the next game" symptom, even though a fresh `a = {...totalScore: 0}` is genuinely created on every `startAttempt()` call. Fixed with a `hasRoutedOnce` flag restricting real navigation to the first `SIGNED_IN`/`INITIAL_SESSION` of a page load.
- *Attempt history UI:* `attempt-history.js` + `#screen-attempt-history`, reading the player's own `attempts` rows directly via the existing `attempts_select_own` RLS policy (no new Edge Function needed — every field the screen needs was already a plain column). Later given Today/All tabs (Today numbers rows `Attempt N/12` in start order, re-deriving the same day-window the slot cap uses server-side) and had its date/time display fixed to force `Asia/Kolkata` explicitly rather than relying on the device's local timezone setting, which had been the actual (if coincidentally correct-looking) behavior before.

**Final polish pass (2026-09-16):** attempt-summary screen's save-status text moved out of the score number into its own line below the button. Home screen's "N of 12 attempts left today" restyled from a solid gradient fill to a dark-filled pill with a gradient border and gradient text (a layered-background technique, since `border-image` can't do rounded corners), made tappable — opens Attempt History straight to Today; the separate "History" nav button now defaults to All instead, so the two entry points serve different purposes. New Info/About screen (`#screen-info`, left-side icon button mirroring the logout button): a grand gradient-text "GC3 Studio Inc." hero, followed by ten color-coded cards covering how to play, lives & time, bonus rounds, themes, the daily per-player shuffle, time bonus, leaderboard tie-break order, attempts, hints & history, and fair play (server-side score replay).

**Bugs fixed this session, for quick reference (all detailed above and in DECISIONS.md):**
1. `offerAdLife()` not locking the board.
2. `score-replay` and `forfeit-stale-attempts` both silently swallowing DB errors (same pattern, found twice, fixed the same way both times).
3. 12/day slot-cap race condition (soft guard → atomic advisory-locked function).
4. `app.js` force-navigating to Home on every re-fired `SIGNED_IN`, silently abandoning in-progress games on tab switch.
5. Attempt-history timestamps relying on device-local timezone instead of forced IST.
6. (Caught before shipping, not a live bug) the attempts-left badge's error-handling path would have deleted its own inner `<span>` on first API error, breaking every subsequent refresh.

**Decisions made:** see docs/DECISIONS.md's many 2026-09-15 and 2026-09-16 entries — too numerous to summarize individually here without duplicating them.

**Next session start point:** Phase 9 — All-time stats & calendar (per-player stats view; month/year calendar reading `user_year_activity`, drilling into per-day attempt detail). No known open gaps blocking this — Phase 7 and 8 are both complete and verified against live data.

---

**2026-09-14 (fourth entry) — deployment, live debugging, first confirmed end-to-end run**

Continued same-day, walking through actual deployment interactively rather than as an offline coding pass — this entry is mostly what got found and fixed while doing that, not new features.

Deployed all three Edge Functions (`generate-daily-games`, `start-attempt`, `score-replay`) via the Supabase Dashboard's browser editor, and set up `generate-daily-games`'s daily Cron Trigger (`pg_cron` + `pg_net` via SQL Editor, 00:05 IST). Three real bugs surfaced during this, none catchable by the earlier Node-only sanity testing since all three are specific to live infrastructure:

1. All three functions read the legacy `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` env vars, which aren't populated on this project (it uses Supabase's newer `sb_publishable_.../sb_secret_...` key system). Fixed to read `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS` instead, per Supabase's current docs.
2. `service_role` was missing table-level grants on `daily_game_definitions` (`permission denied for table...`) — root cause not fully identified, fixed by explicitly re-running the standard `grant all ... to service_role` statements.
3. None of the three functions handled CORS — the client's `github.io` origin calling `*.supabase.co` triggers a browser preflight `OPTIONS` request, which all three rejected with 405 (only `POST` was ever handled). Added an `OPTIONS` short-circuit and `Access-Control-Allow-*` headers on every response across all three functions.

All three fixes are recorded in detail in docs/DECISIONS.md's 2026-09-14 "deployment debugging" entry, since each changes how any future Edge Function in this repo should be written from the start (key sourcing, grants, CORS boilerplate), not just how this one deployment happened to need patching.

Also cleaned up: two stale pre-Phase-5 disclaimer lines in `client/src/index.html` ("Score shown in-game is not yet server-validated (Phase 5 pending)" on the home screen, and a near-identical line on the attempt-summary screen) — both now contradicted what `attempt.js`'s own dynamic "(server-validated)"/"(validating…)" labels were correctly showing right next to them. Removed both; the dynamic labels already communicate validation status on their own.

**First confirmed end-to-end run:** signed in on a real device, `start-attempt` correctly served two different real daily game definitions across two separate Play taps (different themes each time — confirms server-side game selection, not a client fallback), played a full attempt through to exhausting all 3 lives plus the ad-life, and the summary screen showed "4,843 (server-validated)" — the actual `score-replay` response, not a client-computed placeholder. This is the first time the whole Phase 4 through 6 stack has been confirmed working together on real infrastructure rather than piece by piece in Node.

New gap found during this playthrough (logged in ROADMAP.md, not fixed here — out of scope for a deployment-debugging session): backgrounding the browser tab mid-attempt and returning to it triggers a full page reload on this device/browser (normal mobile memory-reclaim behavior), which wipes all in-memory attempt state with no recovery — the orphaned `attempts` row is left `status: 'in_progress'` forever. Needs its own design (resume-from-storage, or detect-and-abandon-stale-attempt) before it's picked up.

Bugs fixed: the three deployment bugs above, plus the two stale-copy lines. All confirmed fixed via the successful live playthrough, not just reasoned about.

Decisions made: see docs/DECISIONS.md's 2026-09-14 "deployment debugging" entry.

**Next session start point:** Phase 7 — leaderboards. The orphaned-in-progress-attempt gap above is worth deciding on before or alongside Phase 8 (slot-cap enforcement), since both touch what counts as a "real" attempt for capping/scoring purposes.

---

**2026-09-14 (third entry) — Phase 5/6 wiring: client, score-replay, persistence**

Continued same-day directly from the Phase 6 server-pieces session, picking up its own stated next-step rather than waiting for a session boundary.

Modified: `client/src/js/attempt.js` — `startAttempt()` is now async and calls the `start-attempt` Edge Function (showing `screen-loading` while in flight, with an alert + return-to-home fallback on failure), storing the returned `attemptId`/`gameDefinitionId`/`slots`. `beginLevel()` now takes regular-slot boards directly from `slots[slotIndex].boardPattern` (a defensive copy) instead of generating them, using a distinct `:refill`-suffixed rng key for post-match cascades. Bonus-round boards (no stored slot for them) are still generated client-side but now seeded off the shared `gameDefinitionId` rather than a per-player seed. Theme assignment now comes from `slots[slotIndex].themeIndex` instead of a client-side shuffle; the now-unused `newAttemptSeed()`/`slotThemeIds` machinery was removed. `submitAttempt()`'s payload changed from `{seed, levels}` to `{attemptId, gameDefinitionId, levels}`.

Modified: `server/functions/score-replay/index.ts` — no longer accepts or trusts a client-supplied seed. Looks up the attempt's `game_definition_id` from the `attempts` row itself (after verifying that row's `user_id` matches the caller's JWT), fetches the 26 stored `board_pattern` rows from `daily_game_definition_slots`, and uses those directly as regular-slot starting boards; bonus boards are re-derived server-side with the same `gameDefinitionId`-seeded formula the client uses. On a valid replay, now UPDATEs the `attempts` row with the final result (closing the persistence gap flagged twice earlier today) — a write failure after a successful replay is surfaced as `persisted: false` rather than a validation failure. Sanity-tested in Node: a simulated client play-through against a stored board using the new `:refill` key validated correctly, a bonus-level replay validated correctly, and a deliberately mismatched board was correctly rejected as an illegal-move failure.

Bugs fixed: none (planned continuation of the previous session's own scoped-out next step, sanity-tested before delivery).

Decisions made: see docs/DECISIONS.md's 2026-09-14 "Phase 5/6 wiring" block — trusting `attempts.game_definition_id` over the request body, keeping bonus boards un-stored/derived (revisited and reconfirmed, not a schema gap), the `:refill` key naming choice, treating a post-replay write failure as distinct from a validation failure, and `score_day` as an explicit placeholder pending real Phase 8 design.

Known gaps, not oversights: neither function is deployed yet (Phase 11 / manual cron setup, unchanged from earlier today); `start-attempt`'s slot-cap check is still a soft guard, not Phase 8's real enforcement; `score_day` attribution is a same-day placeholder, not Phase 8's eventual real logic; this session's testing was Node-only against transpiled logic, not against the live Supabase Edge Runtime or a real device — the full flow (start-attempt -> play -> score-replay -> persisted attempts row) has never actually run end to end on real infrastructure.

**Next session start point:** deploy both Phase 5 functions (`score-replay`, `start-attempt`) and both Phase 6 functions (`generate-daily-games`, `start-attempt` — same function, listed once) to the live Supabase project via the Dashboard's Edge Functions UI (manual, doesn't need Phase 11's CI), set up `generate-daily-games`'s Cron Trigger, manually invoke it once for today's date, then do a real end-to-end device/browser playthrough from a GitHub Pages-hosted client — this is the first point where the whole Phase 4-6 stack can actually be verified together rather than piece by piece in Node. Phase 7 (leaderboards) is the next roadmap item after that's confirmed working.

---

**2026-09-14 (second entry) — Phase 6 daily game-definition generation**

Continued same-day from the Phase 5 session. Built the two Phase 6 server pieces.

Built: `server/functions/generate-daily-games/index.ts` (new) — service-role, idempotent Edge Function meant to run once daily via a Supabase Cron Trigger. For a given IST date, generates all 12 game definitions: a 0-25 theme shuffle per game (stored as the DB's existing 1-26 `theme_id` convention) and a fixed 8x8 `board_pattern` per slot, generated with the same seeded board-gen algorithm as `game-engine.js`. No-ops if the date already has rows, so a retry or cron misfire can't corrupt an already-served day. Sanity-tested in Node before delivery: deterministic given the same seed, all 312 generated boards (12 games x 26 slots) confirmed playable and match-free, all 12 theme shuffles confirmed as valid 26-length permutations.

Also built: `server/functions/start-attempt/index.ts` (new) — user-authenticated Edge Function. Assigns a player's random 0-11 serving-order permutation on their first call of a day (`player_daily_order`), works out which attempt-of-the-day a call is, maps it through the permutation to a `game_index`, fetches that definition's 26 slots, inserts a new `attempts` row, and returns everything the client needs to play. Sanity-tested the order-permutation logic in Node alongside the generation tests.

Bugs fixed: none (new code, sanity-tested before delivery).

Decisions made: see docs/DECISIONS.md's 2026-09-14 "Phase 6 daily game-definition generation" block — the DB's 1-26/code's 0-25 theme convention and where the conversion lives, storing fully-materialized board grids rather than just seeds, why `generate-daily-games` is idempotent by design, why `start-attempt`'s order assignment is seeded rather than cryptographically random, and why client/score-replay wiring was deliberately left for next session rather than crammed into this one.

Known gaps, not oversights: no CI to deploy either function yet (Phase 11); `generate-daily-games` additionally needs a one-time manual Supabase Cron Trigger setup via the Dashboard (Edge Functions > generate-daily-games > Cron), which this session can't click through remotely; `start-attempt`'s slot-cap check is a soft guard, not Phase 8's real enforcement; `client/src/js/attempt.js` and `server/functions/score-replay/index.ts` are both still running on the Phase 4 client-generated-seed stub and haven't been updated to consume this phase's output yet.

**Next session start point:** wire `attempt.js` to call `start-attempt` at the start of each attempt (replacing its own client-generated seed/theme-shuffle) and consume the returned `slots[].boardPattern` directly as each level's starting board instead of calling `generatePlayableBoard()` locally; then update `score-replay/index.ts` to accept a `gameDefinitionId` (or the slots data) instead of a bare `seed`, and use the stored `board_pattern` as the starting board for replay rather than regenerating it — cascades/refills after the initial board still need their own seeded RNG (e.g. `${gameDefinitionId}:${slotIndex}:refill`) since that part isn't pre-computed. This is a coordinated three-file change (client + score-replay + likely a small ARCHITECTURE.md payload-contract update), best done as its own focused pass rather than split further.

---

**2026-09-14 — Phase 4 manual test confirmed; Phase 5 score-replay Edge Function**

Phase 4's manual device test was confirmed passing. Checked off Phase 4 in ROADMAP.md and proceeded to Phase 5.

Built: `server/functions/score-replay/index.ts` (new) — a 1:1 TypeScript port of `game-engine.js`'s seeded RNG, board generation, match detection, scoring, and cascade resolution, plus a level-by-level replay orchestrator. Accepts `{seed, levels[]}` (see docs/ARCHITECTURE.md Section 5 for the finalized payload contract), regenerates every level's board deterministically from the seed, replays each submitted move (rejecting any that aren't legal, match-producing swaps), and returns the authoritative score/time-bonus/lives-used/ad-lives-used/levels-reached. Also validates: shared 3-life pool never exceeded across the whole attempt, the ad-earned life only used after the pool is spent, move counts matching a slot's fixed target for a claimed-completed level, and elapsed time never exceeding a level's own fixed time budget. Sanity-tested standalone in Node (not shipped, sandbox-only) against `game-engine.js` itself before delivery: identical board generation, identical scores/final-boards across a swap sequence, and a full 9-move slot-A replay (with one life used) producing the exact expected time-bonus figure — plus confirmed rejection of a tampered move and an over-claimed life count.

Also modified: `client/src/js/attempt.js` — restructured the Phase 5 submission payload from a flat, timing-ambiguous `moves[]` log (the original `{slot, from, to, tMs}` shape, where `tMs` reset every time a life extended the timer) to per-level records assembled via a new `pushLevelRecord()`, pushed at the exact moment each level's outcome (completed or, for the final level only, failed) is decided. Added `submitAttempt()`, which POSTs the payload to the `score-replay` function via `window.db.functions.invoke()` at attempt end and stores the response; the attempt-summary screen now shows the client-computed figures only as a "(validating…)" preview until that response arrives, then switches to the server-authoritative numbers (or a "not validated" state if the call fails). No mechanics (lives, timer, level completion/failure rules) changed — this is entirely payload/submission plumbing on top of the existing Phase 4 state machine.

Bugs fixed: none this session (new code, sanity-tested before delivery rather than found broken afterward).

Decisions made: see docs/DECISIONS.md's 2026-09-14 "Phase 5 score-replay Edge Function" block — the payload restructure and why, the deliberate client-reported/budget-bounded time-bonus trust boundary, why persistence to `attempts` is deferred (the table's `game_definition_id` FK has nothing to point at until Phase 6), and the hand-ported-engine maintenance risk.

Known gaps, not oversights: the function is not yet deployed to the live Supabase project (`deploy-functions.yml` is a Phase 11 deliverable — this session's sanity testing was Node-only, not against the actual Supabase Edge Runtime); it performs no database writes at all yet (pending Phase 6's `daily_game_definitions`); and slot-cap/score_day attribution (Section 8) aren't enforced here (Phase 7/8).

**Next session start point:** two options depending on priority — (a) manually deploy `score-replay` to the live Supabase project via the dashboard's Edge Functions UI (doesn't require waiting for Phase 11's CI) and do a real end-to-end test from a GitHub Pages-hosted client through to a live function response, since this session's testing was Node-only; or (b) proceed directly to Phase 6 — daily game-definition generation — which is what actually unblocks persisting attempts. Either is a reasonable next step; Phase 6 is the one that unblocks the most downstream work (Phase 7 leaderboards, Phase 8 attempt caps).

---

**2026-09-13 — Seventh same-day pass (whole-grid blink fixed, toast trimmed again)**

Fixed a confirmed bug: the entire board was flashing/dimming on every match, not just the matched tiles — caused by a leftover `.game-board.settling` animation applied to the whole grid on every post-cascade re-render, redundant with (and fighting against) the tile-level `.blasting` animation that was already the correct feedback. Removed entirely, both the JS toggling it and the CSS keyframes. Also trimmed the toast further: it now sizes to its own content height (a slim centered pill via `top:50%; transform:translateY(-50%)`) instead of stretching to fill the whole reserved gap regardless of padding, and both toast messages were shortened. Full reasoning in DECISIONS.md's seventh 2026-09-13 block.

CSS/JS change; no mechanics touched (score/lives/completion logic untouched — purely rendering and copy).

**Next session start point:** re-check on a real device that matches now animate cleanly (only the matched tiles blast, board stays visually stable otherwise) and that the toast reads as compact. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Sixth same-day pass (top-aligned layout, toast trimmed)**

Two more corrections from a screenshot of the fifth pass's result — full reasoning in DECISIONS.md's sixth 2026-09-13 block. `#screen-game` no longer vertically centers its whole content block as a unit (which left a large empty margin above the banner on tall screens); it now starts near the top with a small deliberate breathing gap instead. The toast filling `.board-gap` was trimmed (smaller padding/font/line-height, small inset instead of flush) to actually fit inside that one-tile-row gap rather than visually overflowing it.

CSS-only change; no JS or mechanics touched.

**Next session start point:** re-check the top-aligned layout on a real device — confirm the breathing space above the banner reads as intentional rather than accidental, and that the toast now sits cleanly within its gap. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Theme emoji set finalized**

Went through all 26 themes one at a time: offered a wider candidate list per theme (8-12 emoji beyond the original 6), weighted toward color/shape distinction from the theme's other pieces, with a recommendation each time; confirmed each theme's final 6 before moving to the next. This was prompted by the earlier same-day tile-color work — that fixed how pieces are color-*coded*, this fixes the actual emoji glyphs, several of which were too visually similar to each other within a theme regardless of any border/color system (lion/tiger/bear all tawny-brown, hamster/rabbit/mouse all small pale rodents, etc.).

Updated `client/src/js/attempt.js`'s `THEMES` array (what ships) and docs/ARCHITECTURE.md Section 3.1's theme table (the canonical reference — this document is the source of truth for the game's data, same as any other spec value, so it needed updating alongside the code, not just the code). All 156 emoji (26 × 6) verified unique across the full set before delivery — one attempted duplicate (🐰 rabbit, already locked into Pets) was caught and rejected mid-process on the Seasonal & Holiday theme specifically because themes were being finalized in sequence with cross-checking against everything already locked in, not all at once at the end. Full theme-by-theme reasoning in DECISIONS.md's 2026-09-13 "Theme emoji set finalized" block.

Caught and fixed before delivery, not from a live report: partway through this session's docs update, ARCHITECTURE.md's theme table was initially edited against a stale local sandbox copy that predated the Phase 4 session's Section 3.6 additions (a leftover from earlier in the conversation, never actually reconciled against what's live) — would have silently reverted that whole section had it shipped. Caught by diffing every file in the sandbox against the actual live repo content before finalizing this session's docs, which is now worth treating as standard practice before any DECISIONS/ARCHITECTURE edit in a long-running conversation, not just this one.

No mechanics or rendering logic changed — this was purely a content/data update (which emoji represent which theme).

**Next session start point:** manually re-check a handful of the redesigned themes on a real device — Wild Animals, Sports Equipment, and Faces & Emotions were the most heavily changed and are worth a specific look to confirm the new picks actually read as more distinct in practice, not just in theory. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Fifth same-day pass (fixed board gap, toast relocated again)**

The `flex: 1` proportional centering added in the previous pass looked right on the screen it was checked against but produced a large, screen-height-dependent gap above the board on a taller device. Replaced with a fixed ~one-tile-row gap (`.board-gap`, height approximated as `boardWidth / 8`) between the score strip and the board, with `#screen-game` reverted to the base `.screen` rule's normal centering. The toast moved once more — now filling `.board-gap` itself (absolutely positioned, `inset: 0`) rather than sitting below the board, continuing the same anti-reflow approach from earlier in the day (a fixed-size reserved area the toast overlays, so its appearance/disappearance never changes any element's layout height). Full reasoning in DECISIONS.md's fifth 2026-09-13 block.

CSS/HTML-only change (toast moved in the DOM into the new spacer); no JS or mechanics touched — attempt.js only ever looks up `#game-toast` by id, so it didn't need any changes despite the DOM move.

**Next session start point:** re-check the board's position and the toast's new location on a real device, ideally across a couple of different screen heights given that's exactly what prompted this pass. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Fourth same-day pass (neutral tile border, board vertical centering)**

Two more corrections — full reasoning in DECISIONS.md's fourth 2026-09-13 block. Made the tile border neutral too (matching the transparent-fill reversal from the pass before this one) — tiles are now visually plain at rest, with the `--tile-color` mapping kept purely as data for the selection glow and match-blast animations rather than a resting-state visual. Fixed the board's vertical position: it was centered as part of one taller block (banner + HUD + board together), which pushed its own visual center below the screen's actual middle; `#screen-game` now stretches to full height and `.board-stage` takes `flex: 1`, so the board centers within the space left below the header instead of the header pushing the whole group's center down.

CSS-only change; no JS or mechanics touched.

**Next session start point:** re-check board vertical position on a real device across a couple of different screen sizes/aspect ratios, and confirm the fully-neutral tile appearance still reads as a comfortable, uncluttered board. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Third same-day pass (toast position, HUD sizing, tile fill reverted)**

Three quick corrections from a screenshot of the previous pass's live result — full reasoning in DECISIONS.md's third 2026-09-13 block. Moved the life-used toast from `bottom: 10px` (which sat inside the board's own box, overlapping its last row) to `top: 100%` with a small margin, so it now renders just below the board instead of on top of it — still fully out of document flow, so the earlier reflow fix stays intact. Enlarged only the Moves and Lives HUD values to 19px, leaving everything else (Timer, labels) untouched. Reverted the tinted tile-background fill added last pass back to a fully transparent background — border-only color coding is back, with the `--tile-color` palette itself unchanged so the selection glow and match-blast animation still work off it.

CSS-only change; no JS or mechanics touched.

**Next session start point:** re-check the toast's new position on a real device (confirm it doesn't render below the visible viewport on shorter screens, since it now extends past the board's bottom edge instead of overlapping inside it), and confirm Moves/Lives read clearly at the new size without crowding the HUD row. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Follow-up visual pass (reflow bug, timer, layout, tile colors)**

Four more items from a fresh round of screenshots against the previous session's build. Full reasoning in DECISIONS.md's 2026-09-13 "Follow-up visual pass" block — summary here:

Fixed a confirmed bug where the board visibly jumped up then back down whenever the life-used toast appeared/disappeared — the toast sat in normal document flow, so its height change shifted where `#screen-game`'s centered midpoint landed. Moved it to an absolutely-positioned overlay anchored to the board so it can no longer affect layout height at all. Split the timer display into big bold seconds with a small muted ms/µs line underneath, instead of one flat equal-weight string. Added a theme banner at the top of the game screen (level icon, name, and — moved out of its own strip — a large score with a pop animation on change), using space that was previously just empty due to the screen's vertical centering leaving a gap above content shorter than the viewport; dropped the now-redundant Level chip from the HUD grid. Rebuilt the 6-tile color palette — the actual cause of "colors blend together" was two hues sitting only 29° apart (teal and blue), not a broader perception problem, since the three hues the feedback called out as fine were already 85-140° apart from their neighbors — and added a tinted background fill under the border (via `color-mix()`) since a large colored area reads far more clearly than a thin ring at small tile sizes.

No mechanics changed this session either — purely rendering/layout.

**Next session start point:** manually re-test on a real device — confirm the toast no longer causes any board movement, the timer's two-tier display reads clearly at a glance, the theme banner looks right across a few different themes (check the icon/name/score layout doesn't clip on a long theme name like "Reptiles & Amphibians"), and the six tile colors are now clearly distinguishable from each other on an actual screen (not just reasoned about via hue math). Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-13 — Visual/interaction pass against screenshots**

Gathered feedback as a batch of screenshots across the whole Phase 4 flow (reveal, in-level HUD/board, life-loss, level completion, bonus prompt, theme variety, attempt summary), noted each one without touching any files per explicit request, then applied everything in one pass at the end. Full list of what changed and the reasoning behind each is in DECISIONS.md's 2026-09-13 "Visual/interaction pass against screenshots" block — summary here:

Fixed two confirmed bugs the screenshots caught: the reveal screen's Skip button was showing on regular (non-bonus) levels because no CSS rule actually matched a bare `.hidden` class outside of `.screen.hidden`/`.error.hidden`; and the attempt summary's "lives used" figure silently excluded the ad-earned life. Reworked board layout to center on both axes and size itself against both viewport width and height so it no longer overflows on short screens. Added swipe as a second input method alongside the existing tap-tap flow (both work), backed by a new `GameEngine.trySwapDetailed` that exposes the swap's immediate match separately from the final cascaded board, enabling a real swap → colored blast → settle animation sequence instead of an instant board replacement, plus a shake + vibration on invalid moves. Gave each of the 6 piece types (by board position, not by which emoji currently fills it) a consistent border color across every theme, and made the selected-tile highlight a pulsating glow in that color. Reformatted the live countdown to show running milliseconds/pseudo-microseconds. Redesigned the HUD as labeled stat-chip cards plus a score strip with a live running time-bonus total. Added a new `screen-level-complete` — a brief confetti celebration plus a stats dashboard — between finishing a level/bonus round and whatever comes next, replacing the previous instant jump straight to the next reveal or bonus prompt. Gave the bonus-round prompt a more deliberately "special" visual treatment and sharper copy. Added theme-aware accent coloring (an evenly-spaced hue per theme, applied as a single CSS custom property) for the reveal ticket, live score, and level-complete screen, kept intentionally independent of the fixed per-tile-type colors. Redesigned the attempt-summary screen as a stat-grid card matching the new level-complete screen.

No mechanics from the previous session changed — life pool behavior, level completion/failure rules, bonus-round eligibility and scoring, and time-bonus accounting are all untouched. This was a rendering/interaction/animation layer added on top.

**Next session start point:** manually re-test the full Phase 4 flow via GitHub Pages, specifically checking what this session couldn't verify without a real device: swipe gesture recognition and threshold feel on an actual touchscreen, vibration firing on invalid moves (Android Chrome/WebView only — won't do anything on iOS Safari, which isn't a target platform here anyway), animation timing feeling right rather than janky, and the level-complete screen's continue button correctly routing to the next regular level, the bonus prompt, or the attempt summary depending on which one it should be. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity.

---

**2026-09-12 — Phase 4 core game client session**

Built: `client/src/js/game-engine.js` (new) — pure match-3 logic: seeded RNG (cyrb53 hash + mulberry32), 8x8 board generation guaranteeing no pre-existing matches and at least one legal move, match detection, the scoring formula from ARCHITECTURE.md Section 3.2 including H+V combo doubling via union-find grouping, and gravity/refill cascade resolution. `client/src/js/attempt.js` (new) — the attempt state machine: 26-slot forced-sequential play against the fixed per-slot move-target table, a mandatory theme-reveal screen before every level, a shared 3-life pool consumed automatically in order (each life extends the current level's 60s timer without touching its board or progress), a single ad-earned life offered only once all 3 regular lives are spent, a level/attempt failure path that ends the whole attempt immediately with the failed level contributing zero score/time bonus, a 30-second no-move-cap bonus round every 3rd completed slot mixing 2 emoji from each of the last 3 completed themes, tap-select-then-tap-adjacent swap input, and `{seed, moves[]}` payload assembly. `client/src/index.html`, `client/src/js/app.js`, `client/src/css/styles.css` updated to add the Play button and the new reveal/game/bonus-prompt/attempt-summary screens to the existing screen router.

This session initially proceeded without the referenced "existing HTML/CSS/JS match-3 prototype" — it wasn't found anywhere in the repo (confirmed via a full tarball listing) — and built a first pass from ARCHITECTURE.md's spec text plus a set of flagged, invented defaults for everything the spec didn't cover (board size, starting lives, level completion/failure rule, bonus-round specifics). That first pass was delivered, and its gaps and assumptions were written up in DECISIONS.md. Immediately afterward, the actual prototype (`daily-match-playable-demo.html`, a 4-level playable proof-of-concept of the full design) was uploaded, and turned out to specify several mechanics differently from the invented first pass — most significantly, that a life extends the current level's timer in place (never regenerating the board), that the 3 regular lives are spent automatically and in order before the ad-life is ever offered, and that failing ends the whole attempt immediately. `client/src/js/attempt.js` and the ARCHITECTURE.md/DECISIONS.md entries below were rewritten against the real prototype before anything was handed off for commit, so what's being delivered this session is the corrected version, not the first pass. The one exception: the prototype's own code lets a failed level's already-earned score silently survive despite its on-screen text claiming otherwise, which contradicts ARCHITECTURE.md Section 3.3's explicit "incomplete level contributes 0" rule — this implementation follows the written spec there instead of the prototype's actual (likely unintentional) behavior. The board-generation algorithm (avoid-pregen-matches, 8x8, 6 piece types) converged independently on the same approach as the prototype, so nothing needed correcting there.

Bugs fixed: one, caught before delivery via a standalone Node sanity test rather than shipped and found later — `generateBoard()`'s no-pregen-match check compared against the in-progress row before that row had been appended to the board array, throwing on the third cell of the very first row. Fixed by appending each row to the board array immediately rather than building it in a separate local array first.

Decisions made: see DECISIONS.md, 2026-09-12 "Phase 4 rebuild against the uploaded prototype" block — the corrected life/timer/failure model, the mandatory reveal screen, bonus-round specifics, the ad-count reconciliation against the standing ad-cadence decision, and the one place the prototype's actual code was treated as a bug rather than copied.

**Next session start point:** manually test the full Phase 4 flow via GitHub Pages (no Capacitor wrapper needed, same as Phase 3 testing) — play a full 26-slot attempt, confirm the theme-reveal screen appears before every level, confirm a life/ad-life extends the same level's timer without resetting the board, confirm the bonus prompt fires after slots C/F/I/L/O/R/U/X with a 30s no-move-cap round, confirm exhausting every life ends the attempt immediately with the in-progress level's score excluded, and confirm the HUD (timer/moves/lives/score) stays accurate throughout. Once confirmed, check off Phase 4 in ROADMAP.md and proceed to Phase 5 — Score integrity (the Edge Function that will make the score this session's client displays actually authoritative).

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
