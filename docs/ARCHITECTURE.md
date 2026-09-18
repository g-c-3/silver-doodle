# Architecture

Last updated: 2026-09-18 (Phase 10 — Ads — implementation complete, not yet deployed or verified live).

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
    js/deep-link.js    completes magic-link sign-in inside the native app via a custom URL scheme
                        handoff — see Section 10
  android/             Capacitor Android project — NOT committed; scaffolded fresh by build-apk.yml
                        on every CI run instead (see DECISIONS.md's 2026-09-16 "android/ generated
                        fresh in CI" entry — the short version: committing it would mean uploading
                        ~50+ generated native files by hand through GitHub's mobile web UI)
  assets/
    icon.svg           app icon source (Phase 11) — every density/adaptive-icon variant regenerated
                        from this by @capacitor/assets on each CI run, same "source committed,
                        generated output is not" pattern as android/ itself
  capacitor.config.json
  package.json          pinned exact @capacitor/* versions — keeps the CI-generated android/
                         project's shape stable run to run, which patch_build_gradle.py depends on
server/
  functions/           Supabase Edge Functions (score replay validation, daily game-definition generation, leaderboard settlement)
    admob-ssv/         Phase 10 — Google AdMob's server-side-verification callback target; see Section 5
supabase/
  migrations/           Postgres schema migrations (SQL Editor, run manually — Phase 2 onward)
                         includes ad_verifications (Phase 10) — server-verified rewarded-ad completions
  config.toml           per-function Edge Function config — currently just pins verify_jwt = false
                         for the two cron-only functions (Phase 11)
.github/workflows/
  build-apk.yml
  deploy-functions.yml
  scripts/patch_build_gradle.py     injects release signingConfig + versionCode/versionName into the
                                     CI-generated app/build.gradle (Phase 11)
  scripts/patch_android_manifest.py registers the matchemojisdaily://auth-callback deep link on the
                                     CI-generated AndroidManifest.xml (Phase 11) — see Section 10
.gitignore
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

Leftover time is captured per completed level as `sec:milli:micro` and accumulated digit-clock-style across every completed level in the attempt (1,000 microseconds → +1 millisecond, 1,000 milliseconds → +1 second, 60 seconds → +1 minute). The result is a raw duration, not a points figure. An incomplete (failed) level contributes its earned score to Score, but 0 to Time Bonus and 0 to `levels_reached` — there's no leftover time to bank on a level that was never cleared, and it shouldn't count as reached. (Changed 2026-09-15 — see DECISIONS.md; previously an incomplete level scored 0 across the board.)

### 3.4 Lives

One shared life pool per attempt, carried across the whole forced-sequential run (not per level, not per free-order session — free level selection was considered and reversed; see DECISIONS.md). One ad-earned life is available per level, gated behind a single rewarded-video ad (reduced from an earlier two-ad design). As of Phase 10, this is a real AdMob rewarded ad, server-verified — see Section 5.

### 3.5 Bonus levels

Offered as play-or-skip every 3rd completed level, using a mix of emojis from the previous 3 themes. Entry is gated behind a single rewarded-video ad (reduced from an earlier two-ad design). As of Phase 10, this is a real AdMob rewarded ad, server-verified — see Section 5.

### 3.6 Client implementation values (Phase 4)

These values are not derivable from Section 3.1's scoring/move-target spec alone. Fixed during Phase 4, corrected mid-session after an uploaded playable prototype (`daily-match-playable-demo.html`, a 4-level proof-of-concept of the full 26-slot design) clarified several mechanics an earlier pass had guessed at incorrectly — see docs/DECISIONS.md's 2026-09-12 "Phase 4 rebuild against the uploaded prototype" block for the full reasoning and what changed:

- **Board size:** 8x8. **Piece types per board:** 6 (matches the 6-emoji-per-theme design).
- **Starting lives (shared per-attempt pool):** 3, consumed automatically and in order on timeout — no player choice while any remain.
- **A life does not regenerate the board.** Using a life (regular or the one ad-earned life) adds 60 seconds to the current level's clock and continues on the same board with moves/score progress intact.
- **Level completion:** a level is completed when its move budget is fully used (every valid swap counts down the budget, regardless of the matches it produces).
- **On level failure:** once all 3 regular lives are already spent, the player is offered the single ad-earned life for that level (once per level) before the level — and the whole attempt — fails. Failing ends the attempt immediately, at its current `levels_reached`, with status `completed`. The failed level's in-progress score IS committed to the attempt's running total on failure (matching what the live HUD was already showing the player) — only time bonus and `levels_reached` stay excluded, since the level itself was never cleared (Section 3.3; changed 2026-09-15, see DECISIONS.md).
- **Mandatory theme reveal.** Every level, bonus or not, is preceded by a reveal screen showing its theme name, its 6 (or, for a bonus round, 6 mixed) piece emoji, and its requirements, before the timer starts. Only the bonus-round reveal has a Skip.
- **Bonus rounds:** a flat 30-second timer, no move cap at all, and no life risk — the timer simply ends the round and whatever was scored stands. Bonus levels count toward `levels_reached` but their score is never subject to the "incomplete = 0" rule regular slots use. The piece mix is deterministic: 2 emoji drawn from each of the 3 most recently completed slot themes.
- **Ad count:** both the ad-life grant and the bonus-round entry gate are single-ad, per the existing 2026-09-11 "Ad cadence" decision — the uploaded prototype simulates 2 ads per gate, but is judged to predate that decision rather than supersede it. Both are real AdMob rewarded ads as of Phase 10 (`client/src/js/attempt.js`'s `playRewardedAd()`), not the earlier dev-stub instant grant — see Section 5.
- **Idle hints (added 2026-09-15, corrected twice same day):** after 5 seconds with no successful move (an invalid swap attempt doesn't count), ONE tile is highlighted with a pulsing colour glow — the single tile the player should move to trigger some available match. Not the whole board (an earlier pass highlighted every cell touched by any legal move, which lit up most of an 8x8 grid) and not the resulting match's full run either — just the one tile to move. The highlight persists — it does not re-flicker or re-scan — until the player's next successful move, which both clears it and restarts the 5-second countdown from zero. Applies to bonus levels too. See `GameEngine.findHintCell()` (singular) and `attempt.js`'s `showHints()`/`scheduleHintTimer()`/`clearHints()`.
- **Life-used/ad-life toast (`.game-toast`):** large bold centered text with no background pill (dropped on request — text-shadow carries readability instead), shown for 5 seconds.

Implemented in `client/src/js/game-engine.js` (pure match/cascade/scoring logic) and `client/src/js/attempt.js` (state machine, rendering, input). Regular-slot boards and theme assignment now come from the server (`start-attempt`, Section 4) rather than being client-generated. The ad-life/bonus-ad gates use a real AdMob rewarded-video flow as of Phase 10, server-verified via SSV rather than a client-trusted flag — see Section 5. Score submission to the `score-replay` Edge Function is wired (`attempt.js`'s `submitAttempt()`) and, as of Phase 6, so is server-side persistence — the attempt-summary screen shows the client-computed figures only as a brief "(validating…)" preview, then switches to the server-authoritative response. See Section 5 for the payload contract and the function's current deployment gap.

## 4. Daily Game Generation & Fairness Model

Once per day, the server generates **12 fixed game definitions**, each pairing a board tile-pattern with an independent theme-to-slot shuffle (which of the 26 themes sits at A, which at B, … through Z — move target stays fixed per slot regardless of theme). All 12 game definitions are identical for every player that day.

What is individually randomized per player is the **order** the 12 games are served in — each player gets their own permutation of the 12 game-definition indices, assigned at their first attempt of the day. This prevents scouting another player's upcoming game while guaranteeing everyone plays the same 12 challenges by day's end.

**Implementation (Phase 6, 2026-09-14):**

- `server/functions/generate-daily-games/index.ts` — service-role, idempotent, meant to run once daily via a Supabase Cron Trigger. For a given IST calendar date, generates all 12 definitions: a 0-25 theme-to-slot shuffle (stored in `daily_game_definition_slots.theme_id` as 1-26, per that column's existing check constraint — the +1/-1 conversion happens only at this function's DB boundary and `start-attempt`'s response, nowhere else) and a fixed 8x8 `board_pattern` (jsonb) per slot, generated once with the same seeded-RNG board-gen algorithm as `game-engine.js`/`score-replay` and stored as a fully-materialized grid rather than just a seed — see docs/DECISIONS.md for why. Idempotent by checking for existing rows for the date before writing anything, so a cron misfire or manual retry can't double-generate or corrupt a day already served.
- `server/functions/start-attempt/index.ts` — user-authenticated. Assigns a player's random 0-11 serving-order permutation on their first call of a given IST day (`player_daily_order`, seeded off `${gameDate}:${userId}:order` — safe since order carries no fairness stakes between players, see DECISIONS.md), works out which attempt-of-the-day the call represents (a plain count of that player's `attempts` rows already started today — not yet cap-enforced, see Section 3.9/Phase 8), maps it through the permutation to a `game_index`, fetches that definition's 26 slots, inserts a new `attempts` row, and returns `{attemptId, gameDefinitionId, attemptNumberToday, slots: [{slotIndex, themeIndex, boardPattern}]}`.
- `client/src/js/attempt.js`'s `startAttempt()` calls `start-attempt` and uses its response directly: regular-slot boards come straight from `slots[slotIndex].boardPattern`, themes from `slots[slotIndex].themeIndex`. Bonus-round boards have no stored slot in the Phase 2 schema and are instead derived client-side, seeded off the shared `gameDefinitionId` (`${gameDefinitionId}:bonus:${slotIndex}:board`) rather than a per-player seed — still identical for every player who reaches that bonus point in the same daily game, without needing storage. See docs/DECISIONS.md for why a bonus-board table was considered and skipped.

## 5. Score Integrity Model

The client never sends a raw score. Each attempt submits one batched payload to a single Supabase Edge Function call (`server/functions/score-replay`) at attempt completion. The function deterministically replays the run server-side (server-stored boards, matches, cascades) and computes the authoritative score, time bonus, lives used, and levels reached. This is a single call per attempt (not per level), which is both the anti-cheat model and the basis of the Supabase cost model in DECISIONS.md — roughly 12 Edge Function calls per player per day at 12 attempts/day, rather than ~96 under a per-level-call design.

**Payload contract (finalized Phase 5, updated Phase 6, 2026-09-14):**

```
{
  attemptId: string,          // the `attempts` row start-attempt created; server reads game_definition_id from THIS row, never trusts a client-supplied one
  gameDefinitionId: string,   // sent for logging/debugging only — not authoritative, see above
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

One record per level actually played (finished or, for at most the final entry, failed) — not a flat move log — so the server never has to reconstruct which moves/lives/timing belonged to which level after the fact. See docs/DECISIONS.md's 2026-09-14 "Phase 5 score-replay Edge Function" block for why the original flat-log sketch was replaced, and the same day's later "Phase 5/6 wiring" block for why `seed` was replaced by `attemptId`/`gameDefinitionId`.

**Response contract:** `{ valid: true, score, timeBonusMicros, livesUsed, adLivesUsed, levelsReached, status: "completed", persisted: true }` on success, or `{ valid: false, error }` (HTTP 400) if any level's data fails validation (illegal move, life-pool overclaim, wrong move count for a claimed completion, elapsed time outside that level's own budget, board mismatch, etc). `persisted: false` (with `persistError`) is possible alongside a `valid: true` result if the replay succeeded but the database write failed — see DECISIONS.md.

**Trust boundary, by design:** match/cascade scoring is fully replayed and never client-trusted — every point is recomputed from server-authoritative board data (fetched from `daily_game_definition_slots` for regular slots; derived from the shared `gameDefinitionId` for bonus rounds) and the submitted move list, with illegal moves and mismatched boards rejected outright. Per-level elapsed time (which drives time bonus) remains client-reported, since the batched single-call design has no per-move server round-trip to measure it independently; the function instead bounds `elapsedMsAtEnd` to each level's own fixed time budget (60s/30s base + 60s per life/ad-life actually used, cross-checked against the shared 3-life pool). This limits a modified client to shifting a small time-bonus figure within one level's own budget — it cannot fabricate points, extra lives, extra levels, or an inflated move count.

**Persistence:** on a valid replay, the function UPDATEs the `attempts` row identified by `attemptId` — `status`, `completed_at`, `score`, `time_bonus_micros`, `lives_used`, `levels_reached`, and a same-day `score_day` (a placeholder — real Section 8 score_day edge-case handling isn't designed yet).

**Not yet wired (deferred to later phases):** not yet deployed to the live Supabase project (Phase 11 builds `deploy-functions.yml`, and `generate-daily-games` additionally needs a one-time manual Supabase Cron Trigger setup), and slot-cap enforcement (Section 3.9/Phase 8) is only a soft guard in `start-attempt` right now.

**Ad-life grants and bonus-round entries (Phase 10, 2026-09-18 — implemented, not yet deployed/verified live).** Neither `adLifeUsed` nor `isBonus` in the payload above is trusted as a bare client-reported boolean. Every rewarded-ad request `client/src/js/attempt.js`'s `playRewardedAd()` makes sets `ssv.customData = ${attemptId}:${slotIndex}:life|bonus` and `ssv.userId` to the player's own id; Google's AdMob infrastructure calls a new Edge Function, `server/functions/admob-ssv/index.ts`, directly and out-of-band from the device once the ad genuinely completes, carrying those same two values in a request whose query parameters are cryptographically signed by Google. `admob-ssv` verifies that signature (ECDSA P-256/SHA-256 against Google's published, rotating key set) before writing a row to a new table, `ad_verifications` (`attempt_id, slot_index, ad_type, transaction_id`, service-role-only — no client RLS access in either direction). `score-replay` now requires a matching row here before crediting any level with `adLifeUsed=true` or `isBonus=true` — a modified client can still set either flag to whatever it wants in its own payload, but without an independently-verified ad completion recorded against that exact attempt+slot+type, the level is rejected outright, same as an illegal move or a tampered board.

Not yet done, in order: run the `ad_verifications` migration, deploy `admob-ssv` as a live Edge Function, set its URL as the Callback URL for the Rewarded ad unit in the AdMob console, use AdMob's console "Send test callback" feature to fire one real signed callback at it and confirm the signature check actually passes (the verification logic was written directly from Google's documented algorithm, not yet exercised against a real signed callback), then a full on-device rewarded-ad watch-through for both the ad-life grant and bonus-round entry. See docs/SESSIONS.md's latest entry.

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

**Backend (2026-09-15, Phase 7):** implemented as the `leaderboard` Edge Function, which fetches the whole scope table (`daily_stats`/`weekly_stats`/`all_time_stats`, populated by `record_attempt_start`/`record_attempt_completion` — see Section 8) and sorts it in Deno rather than via a raw SQL `ORDER BY` chain — see that function's own header comment for why. Returns a ranked `top` list plus the caller's own `you` entry (present even when outside `top`) with `decidingTier`/`decidingTierName`.

**Client (2026-09-15, Phase 7):** `client/src/js/leaderboard.js` + a new `#screen-leaderboard` in `index.html`, reachable from Home. Three tabs (Daily/Weekly/All-time) call the Edge Function on tap; a "you" card shows the caller's own rank and, when not #1, which tier decided it (`decidingTierName` rendered directly, e.g. "Decided by: Average lives used (fewer is better)"). The caller's own row is also outlined in the ranked list when it's within the visible `top` N.

## 8. Attempt Accounting Rules

Slot-cap enforcement and score attribution are deliberately decoupled, each keyed to a different timestamp:

- **Slot cap (12/day) uses the attempt's start timestamp.** Checked and decremented server-side when a run begins, atomically (`start_attempt_slot`, added 2026-09-15) — a Postgres function that advisory-locks per (user, day) so a concurrent second `start-attempt` call can't race past the cap or double-claim the same `game_index`. Replaces an earlier count-then-insert version that had exactly that race, called out in its own code comments as a "soft guard" pending this fix.
- **Leaderboard placement uses the attempt's completion timestamp.** An attempt that starts before midnight and finishes after is scored against the day it finished, keeping each day's leaderboard closeable and immutable once its settlement job runs — no reconciliation of an already-closed day is ever needed.

Net effect: a player can occasionally have an attempt's score land on the following day without it costing that day a slot — bounded to at most one such attempt per player per day boundary.

**Forfeit detection (built 2026-09-15):** an attempt is marked **forfeited** (a distinct `attempts.status` from `completed`, reserved for exactly this) if the app is closed or force-terminated while a game is live — detected server-side via a heartbeat/timeout check, never a client-reported flag. `client/src/js/attempt.js` sends a heartbeat to `attempt-heartbeat` every ~20s for the lifetime of an attempt (started right after `startAttempt()`, stopped on both terminal paths); that function only bumps `attempts.last_heartbeat_at`, it never forfeits anything itself. `forfeit-stale-attempts` — a scheduled function, not client-invoked — sweeps for `in_progress` attempts whose `last_heartbeat_at` is more than 5 minutes stale (generous relative to the 20s heartbeat, to tolerate real flakiness rather than a genuinely abandoned session) and marks them `forfeited`. A forfeited attempt's score/time_bonus/lives_used/levels_reached stay at their DB defaults (0) — the server never received move data for it to replay — and it does not feed `record_attempt_completion`, since it already counted toward `attempts_started` at start time, which is exactly how the leaderboard's tier-6 "fewer attempts for the same score" cascade is meant to work.

**Attempt history (built 2026-09-15):** `#screen-attempt-history` (`client/src/index.html` + `client/src/js/attempt-history.js`), reachable from Home. Lists the player's own past attempts — start time, status, score, scored-day — read directly from `attempts` via the existing `attempts_select_own` RLS policy (Phase 2). No new Edge Function needed: every field the screen shows is already a plain column on that table, and this is a read of the player's own data only (Score Integrity governs writes, not reads of one's own history).

## 9. All-Time Stats & Calendar

Per-player all-time stats (days played, total attempts, best day, least day) and a month/year calendar (dot-marked played days) drilling into per-day attempt/score detail. Best/least day use the same metric as leaderboard tier 1 (highest single-attempt score that day), to keep one consistent definition of "performance" across leaderboard, all-time stats, and calendar. The calendar reads the lightweight `user_year_activity` index per year rather than scanning `attempts` per visible month.

## 10. Auth

Email + OTP only, via Supabase Auth — no phone verification. Implemented as a tap-the-link confirmation email rather than a typed 6-digit code (see DECISIONS.md Phase 3 "link-flow pivot" block for why) — the link itself is the one-time-use token. Only name and email are collected at signup; no other personal data. Name and email are editable later; an email change requires tapping a confirmation link sent to the new address. No minimum age gate (see DECISIONS.md for the associated open DPDP risk note).

**Native-app handoff (Phase 11, 2026-09-17).** `signInWithOtp()` uses Supabase's PKCE flow by default, whose `code_verifier` is stored in whichever origin actually made the request. The emailed link always opens in the system browser — a different origin than the Capacitor app's own WebView — so when sign-in was started inside the app, the code exchange can only succeed if it's routed back into the app, not left in that browser tab (see DECISIONS.md for the full reasoning, including why Android App Links wasn't used instead). Two pieces:
- `index.html`'s inline handoff (`#auth-handoff-overlay`, near the top of `<body>`): detects a bare-browser landing on the callback (`code=` or `access_token=` present) and shows a tappable "Open Match Emojis Daily" link to `matchemojisdaily://auth-callback...`. Deliberately a real tap, not an automatic redirect — browsers require a genuine user gesture to hand off to a custom URL scheme (see DECISIONS.md; an automatic-redirect version of this was tried first and got stuck on a blank page). `app.js`'s own routing is skipped entirely while this is showing (`window.__authHandoffPending` guard), so nothing else tries to draw underneath the fixed-position overlay.
- `client/src/js/deep-link.js`: runs only inside the native app. Catches the handoff via `@capacitor/app`'s `appUrlOpen` (app already running) and `getLaunchUrl()` (cold start), and completes the exchange with the app's own Supabase client — the same origin the request started from, so the stored `code_verifier` actually matches.

The custom scheme is registered on `MainActivity` by `.github/workflows/scripts/patch_android_manifest.py`, injected into the CI-generated `AndroidManifest.xml` the same way release signing is (Section 11) — `client/android/` isn't committed, so this can't live in a checked-in manifest file.

## 11. CI/CD

Built 2026-09-16, out of roadmap order ahead of Phase 10 (Ads) — see DECISIONS.md's 2026-09-16 sequencing entry for why. **Confirmed fully working against live GitHub Actions runs as of 2026-09-17** — both workflows green end to end, a signed APK installs and runs.

**`build-apk.yml`.** `client/android/` is not committed (see Section 2) — this workflow is the only place it's ever created. Per run: scaffolds it fresh via the pinned-version `@capacitor/cli` (`npx cap add android && npx cap sync android`), generates the app icon from `client/assets/icon.svg` via `@capacitor/assets` (Section 2), decodes `ANDROID_KEYSTORE_BASE64` into a keystore file and writes `client/android/keystore.properties` alongside it from `ANDROID_KEYSTORE_PASSWORD`/`ANDROID_KEY_ALIAS`/`ANDROID_KEY_PASSWORD` (the keystore is PKCS12, which doesn't support separate store/key passwords, so those two secrets hold the same value), writes `GOOGLE_SERVICES_JSON` out to `client/android/app/google-services.json` (Capacitor's generated `app/build.gradle` only applies the `google-services` Gradle plugin if this file exists and is non-empty, so nothing further needs wiring for that), registers the auth-callback deep link via `.github/workflows/scripts/patch_android_manifest.py` (Section 10), then runs `.github/workflows/scripts/patch_build_gradle.py` to add a release `signingConfig` reading that `keystore.properties` and to bump `versionCode`/`versionName` from `github.run_number`, before `gradlew assembleRelease`. The resulting APK is uploaded both as a workflow artifact and attached to a GitHub Release (marked prerelease — distribution is manual sideload only until Phase 12).

Runner specifics that weren't obvious until a real run failed on them, in case they need revisiting on a future runner-image update: `sdkmanager` isn't on `PATH`, call it via `$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager`; `@capacitor/cli@8.5.2` requires Node ≥22; `capacitor-android`'s own module needs JDK 21 (not 17); attaching a GitHub Release needs an explicit `permissions: contents: write` block (the default `GITHUB_TOKEN` only gets `contents: read`).

**`deploy-functions.yml`.** Triggers on push to `server/functions/**`. The Supabase CLI expects functions under `supabase/functions/`, which this repo deliberately doesn't use as a real directory (Section 2) — the workflow stages a copy there at deploy time only, then runs `supabase functions deploy --use-api --project-ref "$SUPABASE_PROJECT_REF"` (Docker-free; deploys every function found, no need to name them individually) using `SUPABASE_ACCESS_TOKEN`. `SUPABASE_PROJECT_REF` is a plain literal in the workflow, not a secret (see DECISIONS.md) — it's the same non-sensitive value as `supabase/config.toml`'s `project_id` and Section 12 below.

**`supabase/config.toml`.** Pins `verify_jwt = false` explicitly for `forfeit-stale-attempts` and `generate-daily-games` — both cron-only, both previously relying on a Dashboard-only toggle a CLI deploy could otherwise have silently reset. See DECISIONS.md for why this matters.

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
