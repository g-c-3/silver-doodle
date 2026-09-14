// Match Emojis Daily — score-replay Edge Function (Phase 5, updated Phase 6)
//
// Accepts { attemptId, levels[] } (see client/src/js/attempt.js's
// pushLevelRecord/submitAttempt for the exact producer) and deterministically
// re-derives the authoritative score, time bonus, lives used, and levels
// reached. The client never sends a raw score — only the ordered list of
// swaps it made per level — per docs/ARCHITECTURE.md Section 5 and the
// standing score-integrity rule in docs/DECISIONS.md.
//
// PHASE 6 UPDATE: regular-slot (A-Z) starting boards are no longer derived
// from a client-supplied seed — they're fetched directly from
// daily_game_definition_slots using the game_definition_id read off the
// `attempts` row itself (NOT from the request body), so a tampered client
// can't point replay at an easier game definition than the one
// start-attempt actually assigned. Bonus-round boards still aren't
// pre-stored (no schema slot for them) and are derived deterministically
// from the shared game_definition_id — identical for every player who
// reaches that bonus point in the same daily game, without needing storage.
// See docs/DECISIONS.md's 2026-09-14 Phase 6 entry.
//
// PHASE 6 UPDATE: this function now persists its result — on a valid
// replay, it UPDATEs the `attempts` row (status, completed_at, score,
// time_bonus_micros, lives_used, levels_reached, and a same-day score_day
// as a placeholder — real score_day attribution edge cases are Phase 8).
// Auth is required (the caller's JWT) specifically to verify attemptId
// belongs to the calling user before anything is read or written.
//
// KNOWN, DELIBERATE TRUST BOUNDARY: match/cascade scoring is fully replayed
// and is NOT client-trusted in any way — every point comes from re-running
// the same deterministic logic as GameEngine against server-authoritative
// board data and the submitted move list. Per-level *timing*
// (elapsedMsAtEnd, which drives time bonus) is still client-reported, since
// there's no live per-move round-trip to the server during play (that's the
// whole point of the batched-payload design — see DECISIONS.md's "Score
// integrity model" entry on invocation-volume cost). This function bounds
// elapsedMsAtEnd to each level's own fixed budget (60s/30s + 60s per
// life/ad-life actually used, both of which ARE independently checked
// against the shared 3-life pool and the "ad life only after the pool is
// spent" rule) so a modified client can only ever shift a fixed, small
// time-bonus figure within its own level's budget — it can never fabricate
// points, extra lives, extra levels, or an inflated move count, which is
// what actually matters for score and rank.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// ---- Game engine (ported 1:1 from client/src/js/game-engine.js) ----
// Kept as a straight port rather than a shared module so this function has
// no build-time dependency on client/ — Deno Edge Functions deploy each
// function's own directory in isolation. If game-engine.js's match/scoring
// rules ever change, this block must be updated to match or replay results
// will silently diverge from what the client shows the player.

const BOARD_SIZE = 8;
const PIECES_PER_BOARD = 6;

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

interface Run {
  type: 'h' | 'v';
  cells: [number, number][];
}

function findRuns(board: Board): Run[] {
  const runs: Run[] = [];

  for (let r = 0; r < BOARD_SIZE; r++) {
    let c = 0;
    while (c < BOARD_SIZE) {
      const piece = board[r][c];
      let end = c;
      while (end + 1 < BOARD_SIZE && board[r][end + 1] === piece) end++;
      const len = end - c + 1;
      if (len >= 3) {
        const cells: [number, number][] = [];
        for (let k = c; k <= end; k++) cells.push([r, k]);
        runs.push({ type: 'h', cells });
      }
      c = end + 1;
    }
  }

  for (let c = 0; c < BOARD_SIZE; c++) {
    let r = 0;
    while (r < BOARD_SIZE) {
      const piece = board[r][c];
      let end = r;
      while (end + 1 < BOARD_SIZE && board[end + 1][c] === piece) end++;
      const len = end - r + 1;
      if (len >= 3) {
        const cells: [number, number][] = [];
        for (let k = r; k <= end; k++) cells.push([k, c]);
        runs.push({ type: 'v', cells });
      }
      r = end + 1;
    }
  }

  return runs;
}

function cellKey(r: number, c: number): string {
  return r + ',' + c;
}

function lineScore(n: number): number {
  return 10 * n * (1 + n / 10);
}

function scoreRuns(runs: Run[]): { score: number; clearedCells: Set<string> } {
  if (runs.length === 0) return { score: 0, clearedCells: new Set() };

  const parent = runs.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const cellToRuns = new Map<string, number[]>();
  runs.forEach((run, i) => {
    run.cells.forEach(([r, c]) => {
      const k = cellKey(r, c);
      if (!cellToRuns.has(k)) cellToRuns.set(k, []);
      cellToRuns.get(k)!.push(i);
    });
  });
  cellToRuns.forEach((idxs) => {
    for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
  });

  const groups = new Map<number, { types: Set<string>; runIdxs: number[] }>();
  runs.forEach((run, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { types: new Set(), runIdxs: [] });
    const g = groups.get(root)!;
    g.types.add(run.type);
    g.runIdxs.push(i);
  });

  let total = 0;
  const clearedCells = new Set<string>();
  groups.forEach((g) => {
    let groupScore = 0;
    g.runIdxs.forEach((i) => {
      groupScore += lineScore(runs[i].cells.length);
      runs[i].cells.forEach(([r, c]) => clearedCells.add(cellKey(r, c)));
    });
    const isCombo = g.types.has('h') && g.types.has('v');
    total += isCombo ? groupScore * 2 : groupScore;
  });

  return { score: total, clearedCells };
}

function applyGravityAndRefill(board: Board, rng: () => number) {
  for (let c = 0; c < BOARD_SIZE; c++) {
    const column: number[] = [];
    for (let r = BOARD_SIZE - 1; r >= 0; r--) {
      if (board[r][c] !== null) column.push(board[r][c]);
    }
    while (column.length < BOARD_SIZE) column.push(randomPiece(rng));
    for (let r = BOARD_SIZE - 1; r >= 0; r--) {
      board[r][c] = column[BOARD_SIZE - 1 - r];
    }
  }
}

function resolveCascades(board: Board, rng: () => number): number {
  let totalScore = 0;
  let rounds = 0;
  for (;;) {
    const runs = findRuns(board);
    if (runs.length === 0) break;
    const { score, clearedCells } = scoreRuns(runs);
    totalScore += score;
    clearedCells.forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      // deno-lint-ignore no-explicit-any
      (board[r] as any)[c] = null;
    });
    applyGravityAndRefill(board, rng);
    rounds++;
    if (rounds > 40) break;
  }
  return totalScore;
}

function isAdjacent(r1: number, c1: number, r2: number, c2: number): boolean {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

// Returns { valid, board, score }. Mirrors GameEngine.trySwap exactly,
// including "an unsuccessful swap attempt does not consume a move" (caller
// must not advance its move counter when valid === false).
function trySwap(
  board: Board,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  rng: () => number
): { valid: boolean; board: Board; score: number } {
  if (
    r1 < 0 || r1 >= BOARD_SIZE || c1 < 0 || c1 >= BOARD_SIZE ||
    r2 < 0 || r2 >= BOARD_SIZE || c2 < 0 || c2 >= BOARD_SIZE
  ) {
    return { valid: false, board, score: 0 };
  }
  if (!isAdjacent(r1, c1, r2, c2)) return { valid: false, board, score: 0 };
  const next = cloneBoard(board);
  const tmp = next[r1][c1];
  next[r1][c1] = next[r2][c2];
  next[r2][c2] = tmp;

  const runs = findRuns(next);
  if (runs.length === 0) return { valid: false, board, score: 0 };

  const score = resolveCascades(next, rng);
  return { valid: true, board: next, score };
}

function hasLegalMove(board: Board): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (c + 1 < BOARD_SIZE) {
        const test = cloneBoard(board);
        const t = test[r][c];
        test[r][c] = test[r][c + 1];
        test[r][c + 1] = t;
        if (findRuns(test).length > 0) return true;
      }
      if (r + 1 < BOARD_SIZE) {
        const test = cloneBoard(board);
        const t = test[r][c];
        test[r][c] = test[r + 1][c];
        test[r + 1][c] = t;
        if (findRuns(test).length > 0) return true;
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

// ---- Attempt-level replay ----
// From docs/ARCHITECTURE.md Section 3.1 — fixed move target per slot A..Z,
// independent of which theme is shuffled into it (theme identity never
// affects scoring, so it's irrelevant to replay and isn't part of the
// payload at all).
const SLOT_MOVE_TARGETS = [
  9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 40, 44, 48,
  52, 56, 60, 64, 68, 72, 76, 81, 86, 91, 96, 101, 107,
];
const SLOT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const STARTING_LIVES = 3;
const LEVEL_MS = 60_000;
const BONUS_MS = 30_000;
const LIFE_EXTENSION_MS = 60_000;
const TIME_SLACK_MS = 3_000; // tolerance for animation/network latency around a level's own budget

interface LevelPayload {
  slot: string;
  isBonus: boolean;
  moves: [number, number, number, number][];
  livesUsedThisLevel: number;
  adLifeUsed: boolean;
  elapsedMsAtEnd: number;
  outcome: 'completed' | 'failed';
}

interface ReplayResult {
  valid: boolean;
  error?: string;
  score?: number;
  timeBonusMicros?: number;
  livesUsed?: number;
  adLivesUsed?: number;
  levelsReached?: number;
  status?: 'completed';
}

function fail(error: string): ReplayResult {
  return { valid: false, error };
}

// boardsBySlotIndex holds the 26 pre-stored, server-authoritative regular-
// slot boards (fetched from daily_game_definition_slots by the caller) —
// this function never generates a regular level's board itself, only
// bonus-round boards (which aren't pre-stored, see file header).
function replayAttempt(gameDefinitionId: string, boardsBySlotIndex: Map<number, Board>, levels: LevelPayload[]): ReplayResult {
  if (typeof gameDefinitionId !== 'string' || gameDefinitionId.length === 0) {
    return fail('Missing or invalid gameDefinitionId.');
  }
  if (!Array.isArray(levels) || levels.length === 0) return fail('Missing or empty levels array.');
  if (levels.length > SLOT_LETTERS.length + Math.ceil(SLOT_LETTERS.length / 3) + 1) {
    return fail('Levels array longer than an attempt could ever produce.');
  }

  let slotIndex = 0;
  let livesPoolUsed = 0; // shared 3-life pool, cumulative across the WHOLE attempt
  let adLivesUsed = 0;
  let totalScore = 0;
  let timeBonusMicros = 0;
  let levelsReached = 0;

  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const isLast = i === levels.length - 1;

    if (typeof lvl.isBonus !== 'boolean') return fail(`Level ${i}: missing isBonus.`);
    if (!Array.isArray(lvl.moves)) return fail(`Level ${i}: missing moves array.`);
    if (lvl.outcome !== 'completed' && lvl.outcome !== 'failed') return fail(`Level ${i}: invalid outcome.`);
    if (lvl.outcome === 'failed' && (!isLast || lvl.isBonus)) {
      return fail('Only the final, non-bonus level of an attempt may fail.');
    }
    const livesUsedThisLevel = Number(lvl.livesUsedThisLevel) || 0;
    if (livesUsedThisLevel < 0 || !Number.isInteger(livesUsedThisLevel)) {
      return fail(`Level ${i}: invalid livesUsedThisLevel.`);
    }
    if (livesPoolUsed + livesUsedThisLevel > STARTING_LIVES) {
      return fail(`Level ${i}: shared life pool exceeded (${STARTING_LIVES} max per attempt).`);
    }
    const adLifeUsed = !!lvl.adLifeUsed;
    // Per docs/ARCHITECTURE.md Section 3.4/3.6: the ad-earned life is only
    // ever offered once the 3 regular lives are already spent.
    if (adLifeUsed && livesPoolUsed + livesUsedThisLevel < STARTING_LIVES) {
      return fail(`Level ${i}: ad-life used before the regular life pool was exhausted.`);
    }

    // Starting board + rng source must match client/src/js/attempt.js's
    // beginLevel() exactly. Regular slots: the pre-stored board fetched by
    // the caller, with a *separate* refill-only rng stream (the board
    // itself consumed no rng here, since it was never generated — it's
    // stored data). Bonus levels: not pre-stored, generated on the fly from
    // a key that reuses the *current* slotIndex (the slot about to be
    // played next, already incremented past whichever regular slot
    // triggered the bonus) — one combined rng stream for gen + refill, same
    // as before Phase 6.
    let board: Board;
    let rng: () => number;
    if (lvl.isBonus) {
      rng = makeRng(`${gameDefinitionId}:bonus:${slotIndex}:board`);
      board = generatePlayableBoard(rng);
    } else {
      const stored = boardsBySlotIndex.get(slotIndex);
      if (!stored) return fail(`Level ${i}: no stored board for slot index ${slotIndex} — data integrity issue.`);
      board = stored;
      rng = makeRng(`${gameDefinitionId}:slot:${slotIndex}:refill`);
    }

    let levelScore = 0;
    let workingBoard = board;
    for (const mv of lvl.moves) {
      if (!Array.isArray(mv) || mv.length !== 4 || mv.some((n) => !Number.isInteger(n))) {
        return fail(`Level ${i}: malformed move entry.`);
      }
      const [r1, c1, r2, c2] = mv;
      const result = trySwap(workingBoard, r1, c1, r2, c2, rng);
      if (!result.valid) {
        return fail(`Level ${i}: submitted move (${r1},${c1})->(${r2},${c2}) is not a legal match-producing swap.`);
      }
      workingBoard = result.board;
      levelScore += result.score;
    }

    const budgetMs = (lvl.isBonus ? BONUS_MS : LEVEL_MS) + livesUsedThisLevel * LIFE_EXTENSION_MS + (adLifeUsed ? LIFE_EXTENSION_MS : 0);
    const elapsedMsAtEnd = Number(lvl.elapsedMsAtEnd);
    if (!Number.isFinite(elapsedMsAtEnd) || elapsedMsAtEnd < 0 || elapsedMsAtEnd > budgetMs + TIME_SLACK_MS) {
      return fail(`Level ${i}: elapsedMsAtEnd outside this level's own time budget.`);
    }

    if (!lvl.isBonus) {
      const expectedMoves = SLOT_MOVE_TARGETS[slotIndex];
      if (expectedMoves === undefined) return fail(`Level ${i}: slot index out of range.`);
      if (lvl.outcome === 'completed' && lvl.moves.length !== expectedMoves) {
        return fail(`Level ${i}: move count ${lvl.moves.length} does not match slot ${SLOT_LETTERS[slotIndex]}'s target of ${expectedMoves}.`);
      }
      if (lvl.outcome === 'failed' && lvl.moves.length >= expectedMoves) {
        return fail(`Level ${i}: marked failed but already reached its move target.`);
      }
    }

    livesPoolUsed += livesUsedThisLevel;
    if (adLifeUsed) adLivesUsed++;

    if (lvl.outcome === 'completed') {
      totalScore += levelScore;
      levelsReached++;
      // Bonus rounds never bank time bonus (Section 3.5); a regular level
      // banks its own leftover time, digit-clock style (kept as raw
      // microseconds here — the mm:ss:ms:µs formatting is a display concern,
      // handled client-side the same way it already is for the live HUD).
      if (!lvl.isBonus) {
        const leftoverMs = Math.max(0, budgetMs - elapsedMsAtEnd);
        timeBonusMicros += Math.round(leftoverMs * 1000);
      }
    }
    // 'failed' outcome contributes 0 to both score and time bonus, per
    // ARCHITECTURE.md Section 3.3 — levelScore/leftover time are computed
    // above only for validation, never added to the running totals.

    if (!lvl.isBonus) slotIndex++;
  }

  return {
    valid: true,
    score: Math.round(totalScore),
    timeBonusMicros,
    livesUsed: livesPoolUsed,
    adLivesUsed,
    levelsReached,
    status: 'completed',
  };
}

function istDateString(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---- HTTP handler ----

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify(fail('POST only.')), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify(fail('Missing Authorization header.')), { status: 401 });
  }

  let body: { attemptId?: string; gameDefinitionId?: string; levels?: LevelPayload[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(fail('Invalid JSON body.')), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (typeof body.attemptId !== 'string' || body.attemptId.length === 0) {
    return new Response(JSON.stringify(fail('Missing attemptId.')), { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify(fail('Not authenticated.')), { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // The attempt's game_definition_id is read from the `attempts` row itself
  // — NOT trusted from body.gameDefinitionId — so a tampered client can't
  // point replay at an easier game definition than the one start-attempt
  // actually assigned it. This also confirms attemptId belongs to the
  // calling user before anything else happens.
  const attemptRow = await admin.from('attempts').select('id, user_id, game_definition_id, status').eq('id', body.attemptId).maybeSingle();
  if (!attemptRow.data) {
    return new Response(JSON.stringify(fail('Unknown attemptId.')), { status: 404 });
  }
  if (attemptRow.data.user_id !== user.id) {
    return new Response(JSON.stringify(fail('This attempt does not belong to the authenticated user.')), { status: 403 });
  }
  if (attemptRow.data.status === 'completed') {
    return new Response(JSON.stringify(fail('This attempt has already been submitted and validated.')), { status: 409 });
  }
  const gameDefinitionId = attemptRow.data.game_definition_id as string;

  const slotsResult = await admin
    .from('daily_game_definition_slots')
    .select('slot_index, board_pattern')
    .eq('game_definition_id', gameDefinitionId);
  if (slotsResult.error || !slotsResult.data || slotsResult.data.length !== 26) {
    return new Response(JSON.stringify(fail('Could not load this game definition\'s stored boards — data integrity issue.')), { status: 500 });
  }
  const boardsBySlotIndex = new Map<number, Board>();
  slotsResult.data.forEach((row) => boardsBySlotIndex.set(row.slot_index, row.board_pattern as Board));

  const result = replayAttempt(gameDefinitionId, boardsBySlotIndex, body.levels ?? []);

  if (result.valid) {
    // Persistence (closes the Phase 5 "not yet done" gap now that Phase 6
    // supplies a real game_definition_id). score_day is set to today's IST
    // date as a straightforward default — real score_day attribution
    // (Section 8: e.g. an attempt started just before midnight, or a late
    // submission) is still a Phase 8 concern, not handled specially here.
    const update = await admin
      .from('attempts')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        score_day: istDateString(),
        score: result.score,
        time_bonus_micros: result.timeBonusMicros,
        lives_used: result.livesUsed,
        levels_reached: result.levelsReached,
      })
      .eq('id', body.attemptId);
    if (update.error) {
      // The replay itself succeeded and is correct — only the write failed.
      // Surface this distinctly rather than as a validation failure, since
      // the client's displayed score IS the correct one; it just may not be
      // persisted. A future retry/reconciliation job is Phase 7/8 territory.
      return new Response(
        JSON.stringify({ ...result, persisted: false, persistError: update.error.message }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(JSON.stringify({ ...result, persisted: result.valid }), {
    status: result.valid ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
});
