# Server — Supabase Edge Functions

Deno/TypeScript Edge Functions, deployed via `../../.github/workflows/deploy-functions.yml` on
push to this directory. See `../../docs/ARCHITECTURE.md` Sections 4–5 for the daily
game-definition and score-integrity models these implement.

| Function | Trigger | Purpose |
|---|---|---|
| `generate-daily-games` | Scheduled (Supabase Cron, midnight IST daily) | Generates the day's 12 fixed game definitions (board patterns + theme shuffles), forfeits any attempt still `in_progress` from before today, and writes the frozen `yesterday` / `all-time` leaderboard snapshots. Idempotent. |
| `start-attempt` | Client-invoked, user-authenticated | Assigns a player's daily serving order, starts a new attempt, returns that game's 26 slots. |
| `score-replay` | Client-invoked, user-authenticated | Server-side authoritative score computation — replays submitted moves against server-stored boards, rejects illegal/tampered data, persists the result. Never trusts a client-reported score. |
| `leaderboard` | Client-invoked, user-authenticated | Returns the 7-tier ranked leaderboard for a given scope (today/yesterday/all-time). `today` is ranked live per request; `yesterday` and `all-time` are read from snapshots written by `generate-daily-games`. |
| `admob-ssv` | Google AdMob server-to-server callback | Verifies AdMob's signed rewarded-ad-completion callback and records it in `ad_verifications`, which `score-replay` requires before crediting an ad-life or bonus-round level. |

Forfeit detection is event-driven (no heartbeat function): `start_attempt_slot` forfeits a player's other `in_progress` attempts atomically when a new one starts, and the daily `generate-daily-games` run sweeps the rest. Retiring a function requires removing both its folder and its `[functions.*]` block in `supabase/config.toml`.

All functions share the same boilerplate pattern established during Phase 6 deployment
debugging: read keys via `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS` (not the legacy
`SERVICE_ROLE_KEY`/`ANON_KEY` env vars), and handle CORS explicitly (`OPTIONS` preflight +
`Access-Control-Allow-*` on every response, including error responses) — see
`../../docs/DECISIONS.md`'s 2026-09-14 "deployment debugging" entry for why both are required
on this project.
