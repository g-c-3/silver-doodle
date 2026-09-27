// Match Emojis Daily — daily game-definition generation (Phase 6)
//
// Service-role Edge Function, meant to run once per calendar day (IST) via a
// Supabase Cron Trigger (Dashboard > Edge Functions > this function > Cron —
// a manual one-time setup, same pattern as the Phase 1 account/infra work;
// this session can't click through the dashboard remotely, see
// docs/SESSIONS.md for the exact steps to do it). Idempotent: if today's 12
// definitions already exist, it no-ops rather than erroring, so a duplicate
// or retried invocation (e.g. a cron misfire, or a manual test run) can
// never double-generate or corrupt a day already being served to players.
//
// Generates, once, for every game_index 0-11:
//   - a theme shuffle: which of the 26 themes sits at slot A..Z. Stored as
//     theme_id 1-26 to match daily_game_definition_slots' existing check
//     constraint (Phase 2 schema) — everywhere else in this codebase
//     (client THEMES array, score-replay) themes are 0-25 array-indexed.
//     The +1/-1 conversion happens ONLY at this boundary and in
//     start-attempt's response — nowhere else needs to know about it.
//   - a fixed 8x8 board_pattern per slot, generated with the exact same
//     generatePlayableBoard() logic as game-engine.js / score-replay's port,
//     seeded by `${game_date}:${game_index}:${slot_index}:board` — so a
//     board a player is served here is byte-identical to what score-replay
//     will independently regenerate and verify against once that function
//     is updated to consume stored board_pattern data (see docs/ROADMAP.md's
//     Phase 6 entry for what's still open after this session).
//
// All 12 definitions are identical for every player that day (Section 4 of
// docs/ARCHITECTURE.md) — per-player variation is only in *which order* the
// 12 are served, assigned separately by start-attempt/index.ts on each
// player's first attempt of the day.
//
// SECURITY FIX (2026-09-19): this function now requires a shared secret
// (CRON_SECRET) sent as the x-cron-secret header — see the check at the top
// of the handler and docs/DECISIONS.md's 2026-09-19 (later still) entry.
// THIS CODE CHANGE ALONE DOES NOTHING until two things happen outside this
// repo, same as this file's original Cron Trigger setup below: (1) set a
// CRON_SECRET value under Project Settings > Edge Functions > Secrets, and
// (2) edit the existing Cron Trigger (Dashboard > Edge Functions > this
// function > Cron) to send that same value as an x-cron-secret header on
// its scheduled call — Supabase Cron Triggers support custom headers in
// their HTTP request config. Until both are done, every call (including
// the legitimate daily cron) will get 403 Forbidden.
//
// 2026-09-27: also now runs the day-end half of forfeit detection, folded
// into this function's existing once-daily cron run rather than standing
// up a third scheduled function. Replaces attempt-heartbeat (deleted) and
// forfeit-stale-attempts (deleted) — see docs/DECISIONS.md's 2026-09-27
// entry for the full reasoning (storage-write cost, no score-integrity
// impact either way). The other half — a new attempt forfeiting the SAME
// user's other dangling in_progress attempts — lives in start_attempt_slot
// (supabase/migrations/20260927000000_event_driven_forfeit.sql). This
// function's half catches whatever trigger #1 can't: an attempt abandoned
// on a day the player never returns to play again. Runs before the
// idempotency check below so it still executes even when today's
// definitions already exist (e.g. a re-fired cron) — the sweep is
// idempotent either way, a second run simply finds nothing left to update.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// CORS: the client calls these functions from a github.io origin, which is
// cross-origin from *.supabase.co, so the browser sends an OPTIONS
// preflight before the real POST. Every response (including error
// responses) needs these headers, or the browser discards the response
// before the caller's code ever sees it — see docs/DECISIONS.md's
// 2026-09-14 "CORS" entry for why this was missing initially and how it
// was found (405s on OPTIONS in the Invocations log, not a local repro).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};


const BOARD_SIZE = 8;
const PIECES_PER_BOARD = 6;
const THEME_COUNT = 26;
const GAME_COUNT_PER_DAY = 12;

// ---- Seeded RNG (identical to game-engine.js / score-replay/index.ts —
// keep all three in sync by hand; see the standing maintenance-risk note in
// docs/DECISIONS.md's 2026-09-14 "Phase 5 score-replay Edge Function" block,
// which applies equally here.) ----
function hashSeed(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function makeRng(seedStr: string): () => number {
  let a = hashSeed(String(seedStr)) >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPiece(rng: () => number): number {
  return Math.floor(rng() * PIECES_PER_BOARD);
}

type Board = number[][];

function wouldMatchAt(board: Board, r: number, c: number, piece: number): boolean {
  if (c >= 2 && board[r][c - 1] === piece && board[r][c - 2] === piece) return true;
  if (r >= 2 && board[r - 1][c] === piece && board[r - 2][c] === piece) return true;
  return false;
}

function generateBoard(rng: () => number): Board {
  const board: Board = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    board.push([]);
    for (let c = 0; c < BOARD_SIZE; c++) {
      let piece = 0;
      let guard = 0;
      do {
        piece = randomPiece(rng);
        guard++;
      } while (wouldMatchAt(board, r, c, piece) && guard < 50);
      board[r].push(piece);
    }
  }
  return board;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

function findRunAt(board: Board): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE - 2; c++) {
      if (board[r][c] === board[r][c + 1] && board[r][c] === board[r][c + 2]) return true;
    }
  }
  for (let c = 0; c < BOARD_SIZE; c++) {
    for (let r = 0; r < BOARD_SIZE - 2; r++) {
      if (board[r][c] === board[r + 1][c] && board[r][c] === board[r + 2][c]) return true;
    }
  }
  return false;
}

function hasLegalMove(board: Board): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (c + 1 < BOARD_SIZE) {
        const test = cloneBoard(board);
        const t = test[r][c];
        test[r][c] = test[r][c + 1];
        test[r][c + 1] = t;
        if (findRunAt(test)) return true;
      }
      if (r + 1 < BOARD_SIZE) {
        const test = cloneBoard(board);
        const t = test[r][c];
        test[r][c] = test[r + 1][c];
        test[r + 1][c] = t;
        if (findRunAt(test)) return true;
      }
    }
  }
  return false;
}

function generatePlayableBoard(rng: () => number): Board {
  let board = generateBoard(rng);
  let guard = 0;
  while (!hasLegalMove(board) && guard < 20) {
    board = generateBoard(rng);
    guard++;
  }
  return board;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// IST (Asia/Kolkata) calendar date, since the Supabase project region and
// the game's daily/weekly reset points are both IST-anchored per
// docs/ARCHITECTURE.md.
function istDateString(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`; // YYYY-MM-DD, matches a Postgres `date`
}

// Start of the given IST calendar date, as a UTC instant — the cutoff for
// the 2026-09-27 forfeit sweep below. IST is a fixed UTC+5:30 offset (no
// DST), so this is safe as a constant rather than needing real
// timezone-database math — same reasoning as start-attempt/index.ts's own
// istDayBoundsUtc().
function istDayStartUtc(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00+05:30`).toISOString();
}

// ---- 2026-09-27: leaderboard snapshot refresh (yesterday/all-time half) ----
// See supabase/migrations/20260927010000_leaderboard_snapshot_caching.sql.
// REWRITTEN later the same session, before that migration was ever applied
// live (see the migration file's own header) — 'daily'/'weekly' renamed to
// 'today'/'yesterday' per the account holder's direct request, and 'today'
// stopped being cached/refreshed on any schedule at all (it's now ranked
// live by leaderboard/index.ts on every request instead — "will refresh
// fresh"), so the standalone refresh-leaderboard-snapshot/index.ts function
// (the old 3-hourly 'daily' half) is retired outright, same treatment as
// the attempt-heartbeat retirement earlier this session — its code is
// removed from this repo; the deployed Edge Function itself (it has no
// Cron Trigger configured yet, so nothing was ever actually calling it on
// a schedule) still needs manual deletion from the Supabase Dashboard.
// 'yesterday' only needs ranking ONCE, right here, right after the day it
// describes ends — never again afterward, since that day is now over —
// so it's folded into this function's existing once-daily midnight run
// alongside 'all-time', exactly like 'weekly' used to be.

// The calendar date immediately before `dateStr`, as a plain date-string
// subtraction (no timezone conversion needed — `dateStr` is already an IST
// calendar date, and shifting a bare calendar date back by one day is the
// same operation in any timezone). Duplicated per-file rather than shared,
// same convention as this codebase's other small cross-file constants —
// replaces the old mondayOfWeek() helper, which is no longer needed now
// that this run's leaderboard half describes a single frozen day, not a
// rolling week.
function dayBeforeIst(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Fixed sentinel period_key for the 'all-time' scope's single row —
// leaderboard_snapshots/leaderboard_ranks are keyed by (scope, period_key),
// and 'all-time' has no real period, but the column is NOT NULL. Using
// today's date here (like get_leaderboard_page's now-unused p_period_key
// parameter did) would insert a NEW row every single day instead of
// updating the same one — this constant must stay IDENTICAL across this
// file and leaderboard/index.ts's read side, by hand, forever.
const ALL_TIME_PERIOD_KEY = '2000-01-01';

// Next midnight IST strictly after `now` — for 'all-time', which only ever
// refreshes once a day, at the same boundary this whole function already
// runs on. Also stamped onto 'yesterday's row purely for schema consistency
// (the column is NOT NULL) — 'yesterday' is never actually re-read against
// this value, since that day's ranking is genuinely final the moment it's
// written; see leaderboard/index.ts, which reads 'yesterday' unconditionally
// rather than checking next_refresh_at the way the old 'daily' scope did.
function nextMidnightIstUtc(gameDate: string): string {
  const next = new Date(istDayStartUtc(gameDate));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only.' }), { status: 405, headers: CORS_HEADERS });
  }

  // SECURITY FIX (2026-09-19, DECISIONS.md — external audit §5.8): this
  // function runs with verify_jwt = false (supabase/config.toml) — required
  // because the daily cron trigger has no user JWT to send — but that also
  // meant the previous code had NO check of any kind: anyone who could
  // derive this project's function URL (the ref is public, in config.js)
  // could call it directly with the public anon key. Confirmed by reading
  // this file: the only "authorization" strings that existed were in the
  // CORS header list. A shared secret, known only to the cron caller and
  // this function's own environment, closes that — nothing else about this
  // function's logic changed.
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'Forbidden.' }), { status: 403, headers: CORS_HEADERS });
  }

  let gameDate = istDateString();
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.gameDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.gameDate)) {
      // SECURITY FIX (2026-09-19, §5.8): even authenticated (see above),
      // gameDate is now restricted to today or tomorrow — the legitimate
      // "manual/backfill override" use case never needs anything further
      // out, and this bounds how many days ahead a future day's boards
      // (readable by every signed-in player — see §5.6's related, separate
      // design note) can ever be disclosed early.
      const today = istDateString();
      const tomorrow = new Date(new Date(`${today}T00:00:00+05:30`).getTime() + 86_400_000);
      const tomorrowStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
      if (body.gameDate !== today && body.gameDate !== tomorrowStr) {
        return new Response(
          JSON.stringify({ ok: false, error: 'gameDate must be today or tomorrow (IST).' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
      gameDate = body.gameDate; // manual/backfill override, e.g. a missed cron day
    }
  } catch {
    // no body supplied — fine, default to today
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  // This project uses the new sb_secret_.../sb_publishable_... key system —
  // SUPABASE_SECRET_KEYS is a JSON dictionary (see docs/DECISIONS.md's
  // 2026-09-14 "Edge Function key sourcing" entry for why the legacy
  // SUPABASE_SERVICE_ROLE_KEY var was dropped instead of just fixed in place).
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const serviceRoleKey = secretKeys['default'];
  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ ok: false, error: 'SUPABASE_SECRET_KEYS is missing a "default" entry.' }), { status: 500, headers: CORS_HEADERS });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  // 2026-09-27: forfeit trigger #2 (file header) — any attempt still
  // in_progress from BEFORE today (gameDate, not necessarily "today" if
  // this was called with a backfill override — deliberately using the
  // resolved gameDate here, not a fresh istDateString() call, so a manual
  // backfill run sweeps relative to the date it's generating for) is
  // definitely abandoned: the player never returned to either finish it or
  // start a new attempt that would have caught it via trigger #1. score_day
  // is set to gameDate (the day this forfeit is detected/settled), same
  // rule forfeit-stale-attempts always used. Best-effort: a failure here
  // logs but doesn't block today's game generation below — stale rows
  // just get swept on the next run instead.
  const forfeitSweep = await admin
    .from('attempts')
    .update({ status: 'forfeited', completed_at: new Date().toISOString(), score_day: gameDate })
    .eq('status', 'in_progress')
    .lt('started_at', istDayStartUtc(gameDate))
    .select('id');
  if (forfeitSweep.error) {
    console.error(`Forfeit sweep failed for ${gameDate}: ${forfeitSweep.error.message}`);
  }

  // 2026-09-27: leaderboard snapshot refresh — 'yesterday' and 'all-time'.
  // 'yesterday' is keyed to the day just BEFORE gameDate (the day that just
  // ended, now being frozen for good), not gameDate itself — gameDate is
  // the day this run is generating game definitions FOR, i.e. the new
  // "today". Best-effort per scope, same reasoning as the forfeit sweep
  // above — a failure here delays the leaderboard, not today's game
  // generation.
  const yesterday = dayBeforeIst(gameDate);
  const nextMidnight = nextMidnightIstUtc(gameDate);
  for (const [scope, periodKey, nextRefreshAt] of [
    ['yesterday', yesterday, nextMidnight],
    ['all-time', ALL_TIME_PERIOD_KEY, nextMidnight],
  ] as const) {
    const refresh = await admin.rpc('refresh_leaderboard_snapshot', {
      p_scope: scope,
      p_period_key: periodKey,
      p_next_refresh_at: nextRefreshAt,
    });
    if (refresh.error) {
      console.error(`Leaderboard snapshot refresh failed for ${scope}/${periodKey}: ${refresh.error.message}`);
    }
  }

  // Idempotency check — see file header.
  const existing = await admin
    .from('daily_game_definitions')
    .select('id', { count: 'exact', head: true })
    .eq('game_date', gameDate);
  if ((existing.count ?? 0) > 0) {
    return new Response(
      JSON.stringify({ ok: true, gameDate, generated: false, forfeited: forfeitSweep.data?.length ?? 0, note: 'Definitions already exist for this date — no-op.' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  for (let gameIndex = 0; gameIndex < GAME_COUNT_PER_DAY; gameIndex++) {
    const { data: def, error: defErr } = await admin
      .from('daily_game_definitions')
      .insert({ game_date: gameDate, game_index: gameIndex })
      .select('id')
      .single();
    if (defErr || !def) {
      return new Response(JSON.stringify({ ok: false, error: `Failed to insert game_index ${gameIndex}: ${defErr?.message}` }), { status: 500, headers: CORS_HEADERS });
    }

    const themeShuffleRng = makeRng(`${gameDate}:${gameIndex}:theme-shuffle`);
    // 0-25 internally, converted to the DB's 1-26 convention on insert only.
    const slotThemeIndices = shuffle(
      Array.from({ length: THEME_COUNT }, (_, i) => i),
      themeShuffleRng
    );

    const slotRows = [];
    for (let slotIndex = 0; slotIndex < THEME_COUNT; slotIndex++) {
      const boardRng = makeRng(`${gameDate}:${gameIndex}:${slotIndex}:board`);
      const board = generatePlayableBoard(boardRng);
      slotRows.push({
        game_definition_id: def.id,
        slot_index: slotIndex,
        theme_id: slotThemeIndices[slotIndex] + 1, // 0-25 -> 1-26
        board_pattern: board,
      });
    }

    const { error: slotsErr } = await admin.from('daily_game_definition_slots').insert(slotRows);
    if (slotsErr) {
      return new Response(JSON.stringify({ ok: false, error: `Failed to insert slots for game_index ${gameIndex}: ${slotsErr.message}` }), { status: 500, headers: CORS_HEADERS });
    }
  }

  return new Response(JSON.stringify({ ok: true, gameDate, generated: true, gamesCreated: GAME_COUNT_PER_DAY, forfeited: forfeitSweep.data?.length ?? 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
