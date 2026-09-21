// Match Emojis Daily — core match-3 engine
//
// Pure game logic, no DOM access. This separation matters: Phase 5's score-
// replay Edge Function needs to run the *same* match/cascade/scoring rules
// server-side against a submitted {seed, moves[]} payload, so keeping this
// file free of DOM calls means the logic can eventually be shared or ported
// 1:1 without also dragging rendering code along.
//
// Board size and piece count are not specified anywhere in docs/ARCHITECTURE.md
// Section 3.1 (only move targets per slot are specified). Fixed here at 8x8
// with 6 piece types per board (matching the 6-emoji-per-theme piece sets) —
// recorded as a new decision in docs/DECISIONS.md, flagged for confirmation.

const GameEngine = (() => {
  const BOARD_SIZE = 8;
  const PIECES_PER_BOARD = 6;

  // ---- Seeded RNG ----
  // cyrb53 string hash -> mulberry32 PRNG. Deterministic: same seed string
  // always produces the same sequence, which is required for the seed to be
  // replayable server-side in Phase 5.
  function hashSeed(str) {
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

  function makeRng(seedStr) {
    let a = hashSeed(String(seedStr)) >>> 0;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomPiece(rng) {
    return Math.floor(rng() * PIECES_PER_BOARD);
  }

  // ---- Board setup ----
  function wouldMatchAt(board, r, c, piece) {
    if (c >= 2 && board[r][c - 1] === piece && board[r][c - 2] === piece) return true;
    if (r >= 2 && board[r - 1][c] === piece && board[r - 2][c] === piece) return true;
    return false;
  }

  function generateBoard(rng) {
    const board = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      board.push([]);
      for (let c = 0; c < BOARD_SIZE; c++) {
        let piece;
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

  // ---- Match detection ----
  // Returns { runs, clearedCells } for the current board state. Each run is
  // { type: 'h'|'v', cells: [[r,c],...] }.
  function findRuns(board) {
    const runs = [];

    for (let r = 0; r < BOARD_SIZE; r++) {
      let c = 0;
      while (c < BOARD_SIZE) {
        const piece = board[r][c];
        let end = c;
        while (end + 1 < BOARD_SIZE && board[r][end + 1] === piece) end++;
        const len = end - c + 1;
        if (len >= 3) {
          const cells = [];
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
          const cells = [];
          for (let k = r; k <= end; k++) cells.push([k, c]);
          runs.push({ type: 'v', cells });
        }
        r = end + 1;
      }
    }

    return runs;
  }

  function cellKey(r, c) {
    return r + ',' + c;
  }

  // ---- Scoring ----
  // 10n * (1 + n/10) per run. Runs that intersect (a swap producing an L/T
  // shape, or a cascade round that happens to clear an h-run and v-run
  // sharing a cell) are grouped into one combo and the group's summed score
  // is doubled — the shared tile is still only counted once per line, since
  // each run's own score already only counts its own cells once.
  function lineScore(n) {
    return 10 * n * (1 + n / 10);
  }

  function scoreRuns(runs) {
    if (runs.length === 0) return { score: 0, clearedCells: new Set() };

    // Union-find over runs, unioning any two runs that share a cell.
    const parent = runs.map((_, i) => i);
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    const cellToRuns = new Map();
    runs.forEach((run, i) => {
      run.cells.forEach(([r, c]) => {
        const k = cellKey(r, c);
        if (!cellToRuns.has(k)) cellToRuns.set(k, []);
        cellToRuns.get(k).push(i);
      });
    });
    cellToRuns.forEach((idxs) => {
      for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
    });

    const groups = new Map(); // root -> { types:Set, runIdxs:[] }
    runs.forEach((run, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, { types: new Set(), runIdxs: [] });
      const g = groups.get(root);
      g.types.add(run.type);
      g.runIdxs.push(i);
    });

    let total = 0;
    const clearedCells = new Set();
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

  // ---- Gravity + refill ----
  function applyGravityAndRefill(board, rng) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const column = [];
      for (let r = BOARD_SIZE - 1; r >= 0; r--) {
        if (board[r][c] !== null) column.push(board[r][c]);
      }
      while (column.length < BOARD_SIZE) column.push(randomPiece(rng));
      for (let r = BOARD_SIZE - 1; r >= 0; r--) {
        board[r][c] = column[BOARD_SIZE - 1 - r];
      }
    }
  }

  // Like resolveCascades below, but returns each individual cascade round's
  // own cleared-cell set, score, and the resulting board (after that
  // round's clear + gravity/refill) instead of only the grand total. Added
  // 2026-09-22 so the UI can show a chain reaction round by round instead
  // of jumping straight to the fully-resolved board with one unexplained
  // lump-sum score jump — see docs/DECISIONS.md's 2026-09-13 entry for why
  // this wasn't originally built, and this same date's entry for why and
  // how it now is (device report: a single 3-tile swap paying out 117 —
  // three chained 39-point rounds — with only the first one ever visible).
  function resolveCascadesDetailed(board, rng) {
    const rounds = [];
    let totalScore = 0;
    let iterations = 0;
    for (;;) {
      const runs = findRuns(board);
      if (runs.length === 0) break;
      const { score, clearedCells } = scoreRuns(runs);
      totalScore += score;
      clearedCells.forEach((k) => {
        const [r, c] = k.split(',').map(Number);
        board[r][c] = null;
      });
      applyGravityAndRefill(board, rng);
      rounds.push({ clearedCells, score, board: cloneBoard(board) });
      iterations++;
      if (iterations > 40) break; // safety guard against a logic error looping forever
    }
    return { totalScore, rounds };
  }

  // Resolves all cascades from the current board state (assumed to already
  // contain at least one match). Returns total score across every cascade
  // round; board is mutated in place to the final settled state. A thin
  // wrapper over resolveCascadesDetailed — trySwap only ever needs the
  // total, not the per-round breakdown.
  function resolveCascades(board, rng) {
    return resolveCascadesDetailed(board, rng).totalScore;
  }

  function isAdjacent(r1, c1, r2, c2) {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  // Attempts a swap. Returns { valid, board, score } — if invalid, the
  // returned board is unchanged (caller should not consume a move, matching
  // "an unsuccessful swap attempt does not consume a move").
  function trySwap(board, r1, c1, r2, c2, rng) {
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

  // Whether at least one legal move exists (used to avoid handing the player
  // a dead board on generation).
  function hasLegalMove(board) {
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

  // Finds ONE currently-available match-producing move and returns the
  // single "r,c" key of the tile the player should move — not every legal
  // move on the board (there are usually many, and highlighting all of them
  // lit up nearly the entire 8x8 grid, which is what this replaces) and not
  // the resulting match's full run either. Used by the idle-hint UI
  // (client/src/js/attempt.js), which glows exactly this one tile.
  function findHintCell(board) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (c + 1 < BOARD_SIZE) {
          const test = cloneBoard(board);
          const t = test[r][c];
          test[r][c] = test[r][c + 1];
          test[r][c + 1] = t;
          if (findRuns(test).length > 0) return cellKey(r, c);
        }
        if (r + 1 < BOARD_SIZE) {
          const test = cloneBoard(board);
          const t = test[r][c];
          test[r][c] = test[r + 1][c];
          test[r + 1][c] = t;
          if (findRuns(test).length > 0) return cellKey(r, c);
        }
      }
    }
    return null;
  }

  function generatePlayableBoard(rng) {
    let board = generateBoard(rng);
    let guard = 0;
    while (!hasLegalMove(board) && guard < 20) {
      board = generateBoard(rng);
      guard++;
    }
    return board;
  }

  // Like trySwap, but also exposes the intermediate state so the UI can
  // animate the swap's own immediate match precisely (correct cell
  // positions, correct piece colors) before settling into the fully-
  // resolved board. `rounds` (added 2026-09-22, see resolveCascadesDetailed
  // above and docs/DECISIONS.md's 2026-09-13 and 2026-09-22 entries) carries
  // one entry per cascade round this swap triggered, in order — rounds[0]
  // is always the swap's own direct match (its clearedCells are positions
  // in swappedBoard, matching the original firstRoundCleared/firstRoundScore
  // fields this replaces); rounds[1+] are chain reactions from gravity
  // refill, each one's clearedCells positioned in the PREVIOUS round's
  // board. Every round's `board` is the fully-settled state after that
  // round's own clear + gravity/refill — rounds[rounds.length - 1].board
  // is exactly finalBoard.
  function trySwapDetailed(board, r1, c1, r2, c2, rng) {
    if (!isAdjacent(r1, c1, r2, c2)) return { valid: false };
    const swappedBoard = cloneBoard(board);
    const tmp = swappedBoard[r1][c1];
    swappedBoard[r1][c1] = swappedBoard[r2][c2];
    swappedBoard[r2][c2] = tmp;

    const firstRoundRuns = findRuns(swappedBoard);
    if (firstRoundRuns.length === 0) return { valid: false };

    const finalBoard = cloneBoard(swappedBoard);
    const { totalScore, rounds } = resolveCascadesDetailed(finalBoard, rng);

    return {
      valid: true,
      swappedBoard,
      rounds,
      finalBoard,
      totalScore,
    };
  }

  return {
    BOARD_SIZE,
    PIECES_PER_BOARD,
    makeRng,
    generatePlayableBoard,
    trySwap,
    trySwapDetailed,
    lineScore,
    findHintCell,
  };
})();

window.GameEngine = GameEngine;
