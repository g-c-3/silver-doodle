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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only.' }), { status: 405, headers: CORS_HEADERS });
  }

  let gameDate = istDateString();
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.gameDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.gameDate)) {
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

  // Idempotency check — see file header.
  const existing = await admin
    .from('daily_game_definitions')
    .select('id', { count: 'exact', head: true })
    .eq('game_date', gameDate);
  if ((existing.count ?? 0) > 0) {
    return new Response(
      JSON.stringify({ ok: true, gameDate, generated: false, note: 'Definitions already exist for this date — no-op.' }),
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

  return new Response(JSON.stringify({ ok: true, gameDate, generated: true, gamesCreated: GAME_COUNT_PER_DAY }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
