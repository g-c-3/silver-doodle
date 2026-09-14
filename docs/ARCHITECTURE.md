# Architecture

Last updated: 2026-09-14 (Phase 6 daily game-definition generation).

## 1. Stack

| Concern | Choice |
|---|---|
| Client | HTML/CSS/JavaScript match-3 game, wrapped as a native Android app via Capacitor |
| Backend | Supabase — Postgres (data + leaderboards), Auth (email OTP), Edge Functions (TypeScript, score-replay validation) |
| Analytics / crash reporting | Firebase — Analytics (linked to AdMob for revenue-by-cohort reporting) + Crashlytics only. No Firestore, no Firebase Auth — kept deliberately separate from the Supabase-owned auth/database/functions layer |
| Ads | Google AdMob via `@capacitor-community/admob` — rewarded (primary trigger for ad-life and bonus-round entry), interstitial (capped), banner (optional) |
| CI/CD | GitHub Actions — `build-apk.yml` (Capacitor + Gradle, produces an APK artifact/release), `deploy-functions.yml` (deploys Supabase Edge Functions on push to `server/functions/`) |
| Distribution | Manual APK sideload via GitHub Releases during development; Google Play is a later phase |

Capacitor was chosen over Unity or Godot specifically because scene/layout work in those engines is authored visually in a GUI editor, which cannot be previewed without running the editor. Plain HTML/CSS/JS can be authored and reasoned about correctly as text. The existing playable browser prototype's match/cascade/scoring logic is reused directly as the app core rather than rewritten.

Supabase was chosen over Firebase primarily because the leaderboard ranking model (Section 8) is a multi-column `ORDER BY` in Postgres, versus hand-rolled denormalized aggregate fields in Firestore.

## 2. Repo Layout

```
docs/
  ROADMAP.md
  DECISIONS.md
  SESSIONS.md
  ARCHITECTURE.md
client/
  src/                 game HTML/CSS/JS
    js/game-engine.js  pure match-3 logic (seeded RNG, board, matches, scoring, cascades)
    js/attempt.js      attempt orchestration (forced-sequential slots, lives, bonus trigger, rendering)
  android/             Capacitor Android project
  capacitor.config.json
server/
  functions/           Supabase Edge Functions (score replay validation, daily game-definition generation, leaderboard settlement)
supabase/
  migrations/           Postgres schema migrations (SQL Editor, run manually — Phase 2 onward)
.github/workflows/
  build-apk.yml
  deploy-functions.yml
privacy-policy.html     served via GitHub Pages, required before Google Play submission
```

## 3. Game Mechanics Reference

### 3.1 Levels, slots, and move targets

26 themes, each with a fixed set of 6 native Unicode emoji, unique across all 26 sets (no glyph repeats anywhere in the game, so bonus-round mixing across any 3 themes never produces a duplicate-looking piece). Each theme's 6 were picked from a wider candidate list specifically for color/shape distinction from each other within that theme — several in the original list had 2-3 pieces that were too visually similar at small tile size (e.g. lion/tiger/bear all tawny-brown, or hamster/rabbit/mouse all small pale rodents); see docs/DECISIONS.md's 2026-09-13 "Theme emoji set finalized" block for the theme-by-theme reasoning:

| # | Theme | Piece set |
|---|---|---|
| 1 | Pets | 🐶🐱🐰🦔🐢🐾 |
| 2 | Farm Animals | 🐮🐴🐑🦃🐔🦆 |
| 3 | Wild Animals | 🐯🐼🐘🦓🦒🦏 |
| 4 | Faces & Emotions | 😍😎🥳😡🤯🥶 |
| 5 | Birds | 🦉🦜🐤🦢🦩🦚 |
| 6 | Sea Creatures | 🐠🐡🦈🐬🐳🦭 |
| 7 | Ocean & Reef | 🦀🐙🪼🐚🦞🐌 |
| 8 | Reptiles & Amphibians | 🐊🐍🦎🐸🦖🦕 |
| 9 | Insects & Bugs | 🐝🐞🐛🕷️🪲🦋 |
| 10 | Fantasy Creatures | 🐉🦄🧜🧚🧌👻 |
| 11 | Fruits | 🍏🍊🍌🍇🍓🍉 |
| 12 | Tropical Fruits | 🍍🍑🥝🍒🥥🍋 |
| 13 | Vegetables | 🥕🥦🍆🌽🧄🍅 |
| 14 | Desserts & Sweets | 🍰🎂🍭🍫🧁🍪 |
| 15 | Fast Food & Snacks | 🍕🍔🍟🌮🥙🥨 |
| 16 | Drinks & Beverages | ☕🧋🥛🧃🍺🍷 |
| 17 | Musical Instruments | 🎸🎹🥁🪕🎷🎤 |
| 18 | Sports Equipment | ⚽🏈🎾🥎🏀🥊 |
| 19 | Land Vehicles | 🚗🚌🚚🚜🏍️🚲 |
| 20 | Air & Sea Vehicles | ✈️🚁🚀🚢⛵🛸 |
| 21 | Weather & Sky | ☀️🌧️⚡❄️🌈🌪️ |
| 22 | Space & Celestial | 🪐🌍🌙⭐☄️🌕 |
| 23 | Tools & Hardware | 🪚⚙️🧰🪜🧲📏 |
| 24 | Electronics & Gadgets | 🤖💻⌚🕹️🔋💡 |
| 25 | Card & Game Pieces | 🎲♟️🧩🎳🎯🎰 |
| 26 | Seasonal & Holiday | 🎄🧨🎁🎊🥚🕯️ |

A level's **slot** (A–Z) is a fixed position in the 26-level sequence and carries a fixed move target, regardless of which theme is shuffled into it for a given game:

| Slot | Moves | Slot | Moves | Slot | Moves | Slot | Moves |
|---|---|---|---|---|---|---|---|
| A | 9 | H | 30 | O | 56 | V | 86 |
| B | 12 | I | 33 | P | 60 | W | 91 |
| C | 15 | J | 36 | Q | 64 | X | 96 |
| D | 18 | K | 40 | R | 68 | Y | 101 |
| E | 21 | L | 44 | S | 72 | Z | 107 |
| F | 24 | M | 48 | T | 76 | | |
| G | 27 | N | 52 | U | 81 | | |

Each level runs a fixed 60-second timer. An unsuccessful swap attempt does not consume a move. Board size, piece-type count, and absence of blockers/obstacles stay flat across all 26 levels — only the move target scales.

Play is forced-sequential within an attempt (no free level selection): a player always plays slot A, then B, then C, in order, through Z. What varies per game is which of the 26 themes has been shuffled into each slot (Section 4).

Piece art for every theme is native Unicode emoji glyphs only — no custom-drawn or licensed art assets, no art-production pipeline or asset bundle to ship. The finalized 26-theme list and piece sets are given above; the original theme list's thin categories (Dinosaurs, Butterflies & moths, Gemstones & crystals, generic "emojis") were replaced or merged during that redefinition specifically to guarantee 6 available native emoji per theme with zero glyph repeats across the full set.

### 3.2 Scoring formula

Each tile is worth 10 points. A match of `n` tiles (n = 3–6) scores `10n × (1 + n/10)`:

- match-3 = 39
- match-4 = 56
- match-5 = 75
- match-6 = 96

A simultaneous horizontal+vertical combo sums each line's own score using the same formula (the shared intersection tile counted once per line), then doubles the total.

No power-ups, bombs, or special tiles exist at any match size — every match produces points only.

### 3.3 Time Bonus

Leftover time is captured per completed level as `sec:milli:micro` and accumulated digit-clock-style across every completed level in the attempt (1,000 microseconds → +1 millisecond, 1,000 milliseconds → +1 second, 60 seconds → +1 minute). The result is a raw duration, not a points figure. An incomplete level contributes 0 to both Score and Time Bonus.

### 3.4 Lives

One shared life pool per attempt, carried across the whole forced-sequential run (not per level, not per free-order session — free level selection was considered and reversed; see DECISIONS.md). One ad-earned life is available per level, gated behind a single rewarded-video ad (reduced from an earlier two-ad design).

### 3.5 Bonus levels

Offered as play-or-skip every 3rd completed level, using a mix of emojis from the previous 3 themes. Entry is gated behind a single rewarded-video ad (reduced from an earlier two-ad design).

### 3.6 Client implementation values (Phase 4)

These values are not derivable from Section 3.1's scoring/move-target spec alone. Fixed during Phase 4, corrected mid-session after an uploaded playable prototype (`daily-match-playable-demo.html`, a 4-level proof-of-concept of the full 26-slot design) clarified several mechanics an earlier pass had guessed at incorrectly — see docs/DECISIONS.md's 2026-09-12 "Phase 4 rebuild against the uploaded prototype" block for the full reasoning and what changed:

- **Board size:** 8x8. **Piece types per board:** 6 (matches the 6-emoji-per-theme design).
- **Starting lives (shared per-attempt pool):** 3, consumed automatically and in order on timeout — no player choice while any remain.
- **A life does not regenerate the board.** Using a life (regular or the one ad-earned life) adds 60 seconds to the current level's clock and continues on the same board with moves/score progress intact.
- **Level completion:** a level is completed when its move budget is fully used (every valid swap counts down the budget, regardless of the matches it produces).
- **On level failure:** once all 3 regular lives are already spent, the player is offered the single ad-earned life for that level (once per level) before the level — and the whole attempt — fails. Failing ends the attempt immediately, at its current `levels_reached`, with status `completed`. The failed level contributes 0 to both score and time bonus (Section 3.3) — its in-progress score is held in a scratch total that is only committed to the attempt's running total on that level's successful completion, never on failure.
- **Mandatory theme reveal.** Every level, bonus or not, is preceded by a reveal screen showing its theme name, its 6 (or, for a bonus round, 6 mixed) piece emoji, and its requirements, before the timer starts. Only the bonus-round reveal has a Skip.
- **Bonus rounds:** a flat 30-second timer, no move cap at all, and no life risk — the timer simply ends the round and whatever was scored stands. Bonus levels count toward `levels_reached` but their score is never subject to the "incomplete = 0" rule regular slots use. The piece mix is deterministic: 2 emoji drawn from each of the 3 most recently completed slot themes.
- **Ad count:** both the ad-life grant and the bonus-round entry gate are single-ad, per the existing 2026-09-11 "Ad cadence" decision — the uploaded prototype simulates 2 ads per gate, but is judged to predate that decision rather than supersede it.

Implemented in `client/src/js/game-engine.js` (pure match/cascade/scoring logic) and `client/src/js/attempt.js` (state machine, rendering, input). Both files currently stub two later-phase dependencies rather than blocking on them: the daily game-definition seed/theme-shuffle is generated client-side pending Phase 6, and the ad-life/bonus-ad gates grant immediately with no real AdMob flow pending Phase 10. Score submission to the Phase 5 `score-replay` Edge Function is wired (`attempt.js`'s `submitAttempt()`) — the attempt-summary screen shows the client-computed figures only as a brief "(validating…)" preview, then switches to the server-authoritative response. See Section 5 for the payload contract and the function's current deployment/persistence gaps.

## 4. Daily Game Generation & Fairness Model

Once per day, the server generates **12 fixed game definitions**, each pairing a board tile-pattern with an independent theme-to-slot shuffle (which of the 26 themes sits at A, which at B, … through Z — move target stays fixed per slot regardless of theme). All 12 game definitions are identical for every player that day.

What is individually randomized per player is the **order** the 12 games are served in — each player gets their own permutation of the 12 game-definition indices, assigned at their first attempt of the day. This prevents scouting another player's upcoming game while guaranteeing everyone plays the same 12 challenges by day's end.

**Implementation (Phase 6, 2026-09-14):**

- `server/functions/generate-daily-games/index.ts` — service-role, idempotent, meant to run once daily via a Supabase Cron Trigger. For a given IST calendar date, generates all 12 definitions: a 0-25 theme-to-slot shuffle (stored in `daily_game_definition_slots.theme_id` as 1-26, per that column's existing check constraint — the +1/-1 conversion happens only at this function's DB boundary and `start-attempt`'s response, nowhere else) and a fixed 8x8 `board_pattern` (jsonb) per slot, generated once with the same seeded-RNG board-gen algorithm as `game-engine.js`/`score-replay` and stored as a fully-materialized grid rather than just a seed — see docs/DECISIONS.md for why. Idempotent by checking for existing rows for the date before writing anything, so a cron misfire or manual retry can't double-generate or corrupt a day already served.
- `server/functions/start-attempt/index.ts` — user-authenticated. Assigns a player's random 0-11 serving-order permutation on their first call of a given IST day (`player_daily_order`, seeded off `${gameDate}:${userId}:order` — safe since order carries no fairness stakes between players, see DECISIONS.md), works out which attempt-of-the-day the call represents (a plain count of that player's `attempts` rows already started today — not yet cap-enforced, see Section 3.9/Phase 8), maps it through the permutation to a `game_index`, fetches that definition's 26 slots, inserts a new `attempts` row, and returns `{attemptId, gameDefinitionId, attemptNumberToday, slots: [{slotIndex, themeIndex, boardPattern}]}`.

**Not yet wired:** `client/src/js/attempt.js` still generates its own client-side seed/theme-shuffle (the original Phase 4 stub) instead of calling `start-attempt`, and `server/functions/score-replay/index.ts` still regenerates boards from that client-supplied seed instead of consuming a stored `board_pattern`. Both are the natural next task — see docs/SESSIONS.md's latest entry.

## 5. Score Integrity Model

The client never sends a raw score. Each attempt submits one batched payload to a single Supabase Edge Function call (`server/functions/score-replay`) at attempt completion. The function deterministically replays the run server-side (board seed, matches, cascades) and computes the authoritative score, time bonus, lives used, and levels reached. This is a single call per attempt (not per level), which is both the anti-cheat model and the basis of the Supabase cost model in DECISIONS.md — roughly 12 Edge Function calls per player per day at 12 attempts/day, rather than ~96 under a per-level-call design.

**Payload contract (finalized Phase 5, 2026-09-14 — supersedes the earlier indicative `{seed, moves[]}` sketch. NOTE: this contract predates Phase 6 and still reflects the client-generated-seed model; once `attempt.js`/`score-replay` are updated to consume Phase 6's stored `board_pattern` data, the `seed` field here is expected to be replaced or supplemented by `gameDefinitionId` — not yet done, see Section 4):**

```
{
  seed: string,
  levels: [
    {
      slot: "A".."Z" | "bonus",
      isBonus: boolean,
      moves: [[r1, c1, r2, c2], ...],   // ordered valid swaps made on this level's board
      livesUsedThisLevel: number,        // regular-pool lives spent to keep this level alive (0-3)
      adLifeUsed: boolean,               // whether the single ad-earned life was used this level
      elapsedMsAtEnd: number,            // cumulative elapsed ms on this level's own clock, across any extensions, at the moment it ended
      outcome: "completed" | "failed"    // "failed" only ever valid on the payload's last, non-bonus entry
    }
  ]
}
```

One record per level actually played (finished or, for at most the final entry, failed) — not a flat move log — so the server never has to reconstruct which moves/lives/timing belonged to which level after the fact. See docs/DECISIONS.md's 2026-09-14 "Phase 5 score-replay Edge Function" block for why the original flat-log sketch was replaced.

**Response contract:** `{ valid: true, score, timeBonusMicros, livesUsed, adLivesUsed, levelsReached, status: "completed" }` on success, or `{ valid: false, error }` (HTTP 400) if any level's data fails validation (illegal move, life-pool overclaim, wrong move count for a claimed completion, elapsed time outside that level's own budget, etc).

**Trust boundary, by design:** match/cascade scoring is fully replayed and never client-trusted — every point is recomputed from the seed and the submitted move list, with illegal moves rejected outright. Per-level elapsed time (which drives time bonus) remains client-reported, since the batched single-call design has no per-move server round-trip to measure it independently; the function instead bounds `elapsedMsAtEnd` to each level's own fixed time budget (60s/30s base + 60s per life/ad-life actually used, cross-checked against the shared 3-life pool). This limits a modified client to shifting a small time-bonus figure within one level's own budget — it cannot fabricate points, extra lives, extra levels, or an inflated move count.

**Not yet wired (deferred to later phases):** the function currently computes and returns a result but does not persist a row to `attempts` (Section 6's `game_definition_id` FK has nothing to point at until Phase 6 generates `daily_game_definitions` rows), is not yet deployed to the live Supabase project (Phase 11 builds `deploy-functions.yml`), and slot-cap/score_day attribution (Section 8) aren't enforced here (Phase 7/8).

Ad-life grants and bonus-round entries are verified server-side via AdMob SSV callbacks, never trusted from a client-reported "ad watched" flag — this remains a Phase 10 item, unaffected by Phase 5.

## 6. Data Model (Postgres, Supabase)

Implemented in `supabase/migrations/20260912000000_phase2_schema.sql` (Phase 2, 2026-09-12). Refined from the original indicative list — see DECISIONS.md's Phase 2 block for the reasoning behind each deviation:

- `users` — id (references `auth.users`), email, display_name, created_at, updated_at. Kept in sync with `auth.users` via trigger; only `display_name` is client-editable. A `leaderboard_profiles` view exposes id + display_name (never email) for public leaderboard display.
- `daily_game_definitions` — id, game_date, game_index (0–11), created_at (12 rows/day, one per game definition)
- `daily_game_definition_slots` — id, game_definition_id (FK), slot_index (0–25), theme_id, board_pattern (26 child rows per definition; move_target is a fixed constant per slot_index, not stored)
- `player_daily_order` — user_id, game_date, game_order (validated 0–11 permutation), assigned_at
- `attempts` — id, user_id, game_definition_id, started_at, completed_at, score_day (the calendar day this attempt is scored against — see Section 9), status (in_progress/completed/forfeited), score, time_bonus_micros, lives_used, levels_reached. Summary-only — raw `{seed, moves[]}` replay payloads are never persisted.
- `daily_stats`, `weekly_stats`, `all_time_stats` — per-user rolling aggregates: max_score, sum_score, max/sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed. The average-based cascade tiers (Section 7, tiers 2/4/5/7) divide by attempts_completed; the attempt-count tier (tier 6) uses attempts_started. Updated transactionally on each attempt completion.
- `user_year_activity` — user_id, activity_date, attempts_count — a lightweight index for the calendar view, avoiding a full-month scan of `attempts` on every calendar render

All tables have RLS enabled. Players can read their own private rows and the public aggregate/reference tables; no table accepts client-side writes except `users.display_name` — attempt lifecycle, stats aggregation, and game-definition/order generation are all service-role-only operations performed by Edge Functions in later phases. This makes the score-integrity rule (Section 5) a database-level guarantee, not just an application-level convention.

## 7. Leaderboard Cascade

Applied identically across all three scopes — daily, weekly (resets Monday 00:00 IST), all-time (never resets) — over each scope's respective attempt pool:

1. Highest single-attempt Score (descending).
2. Average Score across attempts actually played in the period (descending) — unplayed attempts excluded from the average, not counted as zero.
3. Highest single-attempt Time Bonus (descending).
4. Average Time Bonus across attempts actually played (descending).
5. Average lives used per attempt, including any ad-earned life (ascending — fewer used ranks higher).
6. Number of attempts played in the period (ascending — fewer attempts to reach the same result ranks higher).
7. Average levels played per attempt, including bonus levels (ascending — fewer needed ranks higher).

Each tier is only consulted if every player above it is exactly tied on all prior tiers. The per-player rank-breakdown UI shows which tier decided the player's placement.

## 8. Attempt Accounting Rules

Slot-cap enforcement and score attribution are deliberately decoupled, each keyed to a different timestamp:

- **Slot cap (12/day) uses the attempt's start timestamp.** Checked and decremented server-side when a run begins.
- **Leaderboard placement uses the attempt's completion timestamp.** An attempt that starts before midnight and finishes after is scored against the day it finished, keeping each day's leaderboard closeable and immutable once its settlement job runs — no reconciliation of an already-closed day is ever needed.

Net effect: a player can occasionally have an attempt's score land on the following day without it costing that day a slot — bounded to at most one such attempt per player per day boundary.

An attempt is marked **forfeited** if the app is closed or force-terminated while a game is live, detected server-side via a heartbeat/timeout check — never a client-reported flag. Attempt history shows, per attempt: start time, status (score achieved / forfeited), and which day it was scored against.

## 9. All-Time Stats & Calendar

Per-player all-time stats (days played, total attempts, best day, least day) and a month/year calendar (dot-marked played days) drilling into per-day attempt/score detail. Best/least day use the same metric as leaderboard tier 1 (highest single-attempt score that day), to keep one consistent definition of "performance" across leaderboard, all-time stats, and calendar. The calendar reads the lightweight `user_year_activity` index per year rather than scanning `attempts` per visible month.

## 10. Auth

Email + OTP only, via Supabase Auth — no phone verification. Implemented as a tap-the-link confirmation email rather than a typed 6-digit code (see DECISIONS.md Phase 3 "link-flow pivot" block for why) — the link itself is the one-time-use token. Only name and email are collected at signup; no other personal data. Name and email are editable later; an email change requires tapping a confirmation link sent to the new address. No minimum age gate (see DECISIONS.md for the associated open DPDP risk note).

## 11. CI/CD

- `build-apk.yml` — Capacitor + Gradle build, produces an APK artifact and/or GitHub Release. Reads Android signing secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and writes `GOOGLE_SERVICES_JSON` out to `client/android/app/google-services.json` during the build. Note: the keystore is PKCS12 format, which does not support separate store/key passwords — `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD` hold the same value.
- `deploy-functions.yml` — deploys Supabase Edge Functions on push to `server/functions/`. Reads `SUPABASE_ACCESS_TOKEN` (scoped to this project only, Edge Functions: Read-write, no other permissions) and `SUPABASE_PROJECT_REF`.

Neither workflow file exists yet (Phase 11); the secrets they'll read are provisioned and confirmed in place ahead of that phase.

GitHub Actions handles all building; no local terminal build steps are ever required.

## 12. Provisioned Infrastructure

Non-secret identifiers only — actual credentials live in GitHub Actions secrets, never in this file. Established during Phase 1 (2026-09-12).

| Item | Value |
|---|---|
| Android package name | `com.gc.matchemojisdaily` |
| Firebase project ID | `match-emojis-daily` |
| Firebase project number | `103425074643` |
| Firebase storage bucket | `match-emojis-daily.firebasestorage.app` |
| Supabase project ref | `wgkcxixocfzydawurluh` |
| Supabase region | South Asia (Mumbai) |
| AdMob App ID | `ca-app-pub-6922359485200410~4812181773` |
| AdMob Rewarded ad unit ID | `ca-app-pub-6922359485200410/1441491988` |
| AdMob Interstitial ad unit ID | `ca-app-pub-6922359485200410/2621132707` |
| AdMob Banner ad unit ID | `ca-app-pub-6922359485200410/6368806025` |
| Android keystore alias | `match-emojis-daily` |
| Android keystore validity | 30 years (until 2056) |

GitHub Actions secrets on record (names only): `GOOGLE_SERVICES_JSON`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

Deliberately not yet done: custom SMTP for Supabase Auth (dev-mode sender in use), Firebase Crashlytics SDK integration (deferred to Phase 4), production AdMob ad unit IDs (current IDs are development/test-appropriate, Phase 12 swaps to production), Google Play Console account.
