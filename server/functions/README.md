# Server — Supabase Edge Functions

Deno/TypeScript Edge Functions, deployed via `../../.github/workflows/deploy-functions.yml` on
push to this directory. See `../../docs/ARCHITECTURE.md` Sections 4–5 for the daily
game-definition and score-integrity models these implement.

| Function | Trigger | Purpose |
|---|---|---|
| `generate-daily-games` | Scheduled (Supabase Cron, 00:05 IST daily) | Generates the day's 12 fixed game definitions (board patterns + theme shuffles). Idempotent. |
| `start-attempt` | Client-invoked, user-authenticated | Assigns a player's daily serving order, starts a new attempt, returns that game's 26 slots. |
| `score-replay` | Client-invoked, user-authenticated | Server-side authoritative score computation — replays submitted moves against server-stored boards, rejects illegal/tampered data, persists the result. Never trusts a client-reported score. |
| `leaderboard` | Client-invoked, user-authenticated | Computes and returns the 7-tier ranked leaderboard for a given scope (daily/weekly/all-time). |
| `attempt-heartbeat` | Client-invoked, user-authenticated | Bumps `attempts.last_heartbeat_at` for the lifetime of an in-progress attempt. |
| `forfeit-stale-attempts` | Scheduled (Supabase Cron, every 5 min) | Marks `in_progress` attempts with a stale heartbeat as `forfeited`. Never client-invoked. |
| `admob-ssv` | Google AdMob server-to-server callback | Verifies AdMob's signed rewarded-ad-completion callback and records it in `ad_verifications`, which `score-replay` requires before crediting an ad-life or bonus-round level. |

All functions share the same boilerplate pattern established during Phase 6 deployment
debugging: read keys via `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS` (not the legacy
`SERVICE_ROLE_KEY`/`ANON_KEY` env vars), and handle CORS explicitly (`OPTIONS` preflight +
`Access-Control-Allow-*` on every response, including error responses) — see
`../../docs/DECISIONS.md`'s 2026-09-14 "deployment debugging" entry for why both are required
on this project.
