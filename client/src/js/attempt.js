// Match Emojis Daily — attempt orchestration (Phase 4: core game client)
//
// KNOWN GAP, not a bug: docs/ARCHITECTURE.md Section 4 describes the daily
// game definitions (12/day, identical for every player, server-generated) as
// a Phase 6 deliverable. Phase 6 doesn't exist yet, so this file generates
// its own attempt seed and theme shuffle client-side purely so the game is
// playable/testable now. Swap `startAttempt()`'s seed/theme-shuffle source
// for the real daily definition + player order once Phase 6 lands — the rest
// of the state machine (forced-sequential slots, lives, bonus trigger,
// scoring) does not need to change.
//
// KNOWN GAP: score submission to the Phase 5 Edge Function is not wired yet
// (Phase 5 doesn't exist). The {seed, moves[]} payload is assembled and
// logged to the console / shown in the summary screen, but nothing is sent
// over the network and nothing is persisted. The score shown to the player
// right now is client-computed and NOT authoritative — this is explicitly
// flagged in the summary screen copy so it's never confused with a real,
// server-validated result.

const Attempt = (() => {
  const SLOT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  // From docs/ARCHITECTURE.md Section 3.1 — fixed move target per slot,
  // independent of which theme is shuffled into that slot.
  const SLOT_MOVE_TARGETS = [
    9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 40, 44, 48,
    52, 56, 60, 64, 68, 72, 76, 81, 86, 91, 96, 101, 107,
  ];

  // From docs/ARCHITECTURE.md Section 3.1 — 26 themes, 6 unique native emoji
  // each, zero glyph repeats across the whole set.
  const THEMES = [
    { name: 'Pets', emojis: ['🐶', '🐱', '🐹', '🐰', '🐭', '🦔'] },
    { name: 'Farm Animals', emojis: ['🐮', '🐷', '🐔', '🐴', '🐑', '🐐'] },
    { name: 'Wild Animals', emojis: ['🦁', '🐯', '🐻', '🐼', '🐨', '🐘'] },
    { name: 'Faces & Emotions', emojis: ['😀', '😂', '😍', '😎', '🤩', '🥳'] },
    { name: 'Birds', emojis: ['🐦', '🦅', '🦉', '🦜', '🐧', '🦢'] },
    { name: 'Sea Creatures', emojis: ['🐟', '🐠', '🐡', '🦈', '🐬', '🐳'] },
    { name: 'Ocean & Reef', emojis: ['🦀', '🐙', '🦑', '🪼', '🐚', '🦞'] },
    { name: 'Reptiles & Amphibians', emojis: ['🐊', '🐍', '🐢', '🦎', '🐸', '🦖'] },
    { name: 'Insects & Bugs', emojis: ['🐝', '🐞', '🐛', '🕷️', '🦗', '🪰'] },
    { name: 'Fantasy Creatures', emojis: ['🐉', '🦄', '🧜', '🧚', '🧞', '🧌'] },
    { name: 'Fruits', emojis: ['🍎', '🍊', '🍌', '🍇', '🍓', '🍉'] },
    { name: 'Tropical Fruits', emojis: ['🍍', '🥭', '🥝', '🍒', '🍑', '🍋'] },
    { name: 'Vegetables', emojis: ['🥕', '🥦', '🍆', '🌽', '🥔', '🍅'] },
    { name: 'Desserts & Sweets', emojis: ['🍰', '🍩', '🍭', '🍫', '🧁', '🍪'] },
    { name: 'Fast Food & Snacks', emojis: ['🍕', '🍔', '🍟', '🌭', '🍿', '🥨'] },
    { name: 'Drinks & Beverages', emojis: ['☕', '🧋', '🥤', '🥛', '🧃', '🍵'] },
    { name: 'Musical Instruments', emojis: ['🎸', '🎹', '🥁', '🎺', '🎷', '🎻'] },
    { name: 'Sports Equipment', emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐'] },
    { name: 'Land Vehicles', emojis: ['🚗', '🚌', '🚚', '🚜', '🏍️', '🚲'] },
    { name: 'Air & Sea Vehicles', emojis: ['✈️', '🚁', '🚀', '🚢', '⛵', '🛸'] },
    { name: 'Weather & Sky', emojis: ['☀️', '🌧️', '⛈️', '❄️', '🌈', '🌪️'] },
    { name: 'Space & Celestial', emojis: ['🪐', '🌍', '🌙', '⭐', '☄️', '🛰️'] },
    { name: 'Tools & Hardware', emojis: ['🔨', '🔧', '🪛', '🪚', '🔩', '⚙️'] },
    { name: 'Electronics & Gadgets', emojis: ['🤖', '💻', '📱', '⌚', '🕹️', '🔋'] },
    { name: 'Card & Game Pieces', emojis: ['🎲', '♟️', '🃏', '🎳', '🎯', '🎰'] },
    { name: 'Seasonal & Holiday', emojis: ['🎄', '🎃', '🎆', '🎁', '🥚', '🧧'] },
  ];

  // New decision (Phase 4, not previously specified): starting lives for the
  // shared per-attempt pool. Flagged in docs/DECISIONS.md for confirmation.
  const STARTING_LIVES = 3;
  const TIME_LIMIT_MS = 60000;
  const BONUS_MOVE_TARGET = 20;

  let a = null; // current attempt state
  let selectedCell = null; // [r,c] or null
  let tickHandle = null;

  function el(id) {
    return document.getElementById(id);
  }

  function shuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function newAttemptSeed() {
    // Dev-only seed source — see file header. Phase 6 will supply the real
    // daily seed/definition instead of this.
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'seed-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function startAttempt() {
    const seed = newAttemptSeed();
    const shuffleRng = GameEngine.makeRng(seed + ':theme-shuffle');
    const slotThemeIds = shuffle(THEMES.map((_, i) => i), shuffleRng);

    a = {
      seed,
      slotThemeIds,
      slotIndex: 0,
      levelsReached: 0,
      totalScore: 0,
      timeBonusMs: 0,
      livesRemaining: STARTING_LIVES,
      moves: [],
      recentThemeIds: [], // last 3 *slot* themes completed, for bonus mixing
      status: 'in_progress',
    };
    selectedCell = null;
    startLevel();
    window.showScreen('screen-game');
  }

  function currentThemeEmojis() {
    if (a.isBonusLevel) return a.bonusEmojis;
    return THEMES[a.slotThemeIds[a.slotIndex]].emojis;
  }

  function levelSeed() {
    const bonusTag = a.isBonusLevel ? 'bonus' : 'slot';
    return `${a.seed}:${bonusTag}:${a.slotIndex}:${a.retryCount || 0}`;
  }

  function startLevel(opts) {
    opts = opts || {};
    a.isBonusLevel = !!opts.bonus;
    a.retryCount = opts.retry ? (a.retryCount || 0) + 1 : 0;
    a.adLifeUsedThisLevel = false;

    if (a.isBonusLevel) {
      const pool = a.recentThemeIds.flatMap((id) => THEMES[id].emojis);
      const pickRng = GameEngine.makeRng(levelSeed() + ':bonus-pool');
      a.bonusEmojis = shuffle(pool, pickRng).slice(0, GameEngine.PIECES_PER_BOARD);
      a.movesTarget = BONUS_MOVE_TARGET;
    } else {
      a.movesTarget = SLOT_MOVE_TARGETS[a.slotIndex];
    }

    const boardRng = GameEngine.makeRng(levelSeed() + ':board');
    a.rng = boardRng;
    a.board = GameEngine.generatePlayableBoard(boardRng);
    a.movesRemaining = a.movesTarget;
    a.levelScore = 0;
    a.levelStartTs = performance.now();
    selectedCell = null;

    setMessage('');
    renderBoard();
    renderHud();
    stopTicking();
    tickHandle = setInterval(tick, 100);
  }

  function stopTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
  }

  function msRemaining() {
    const elapsed = performance.now() - a.levelStartTs;
    return Math.max(0, TIME_LIMIT_MS - elapsed);
  }

  function tick() {
    const remaining = msRemaining();
    renderTimer(remaining);
    if (remaining <= 0) {
      stopTicking();
      handleTimeout();
    }
  }

  function handleTimeout() {
    if (a.isBonusLevel) {
      // Bonus rounds carry no downside risk beyond not finishing — whatever
      // score was made stands, no life is lost. New decision (Phase 4),
      // recorded in docs/DECISIONS.md — ARCHITECTURE.md doesn't define
      // bonus-round failure behavior.
      finishLevel();
      return;
    }
    if (!a.adLifeUsedThisLevel) {
      offerLifeChoice();
      return;
    }
    loseLifeAndContinue();
  }

  function offerLifeChoice() {
    const box = el('game-message');
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = "Time's up. Use your one ad-earned life for this level, or spend a life from your pool?";
    box.appendChild(p);

    const adBtn = document.createElement('button');
    adBtn.className = 'secondary';
    adBtn.textContent = 'Watch ad for +60s (dev stub)';
    adBtn.addEventListener('click', () => {
      // DEV STUB — Phase 10 replaces this with a real AdMob rewarded-video
      // flow verified server-side via SSV, per the score-integrity rule.
      // Never trust a client "ad watched" flag once that phase lands.
      a.adLifeUsedThisLevel = true;
      a.levelStartTs = performance.now();
      setMessage('');
      stopTicking();
      tickHandle = setInterval(tick, 100);
    });

    const lifeBtn = document.createElement('button');
    lifeBtn.className = 'danger';
    lifeBtn.textContent = `Use a life (${a.livesRemaining} left)`;
    lifeBtn.addEventListener('click', () => loseLifeAndContinue());

    box.appendChild(adBtn);
    box.appendChild(lifeBtn);
  }

  function loseLifeAndContinue() {
    a.livesRemaining--;
    if (a.livesRemaining <= 0) {
      endAttempt();
      return;
    }
    setMessage(`Out of time — life used. ${a.livesRemaining} left.`);
    startLevel({ retry: true });
  }

  function finishLevel() {
    stopTicking();
    const leftoverMs = a.isBonusLevel ? 0 : msRemaining();
    a.timeBonusMs += leftoverMs;
    a.totalScore += a.levelScore;
    a.levelsReached++;

    if (!a.isBonusLevel) {
      const themeId = a.slotThemeIds[a.slotIndex];
      a.recentThemeIds.push(themeId);
      if (a.recentThemeIds.length > 3) a.recentThemeIds.shift();
    }

    if (a.isBonusLevel) {
      a.isBonusLevel = false;
      advanceOrFinishAttempt();
      return;
    }

    a.slotIndex++;
    if (a.slotIndex >= SLOT_LETTERS.length) {
      endAttempt();
      return;
    }

    // Bonus round offered every 3rd *completed* slot, per
    // docs/ARCHITECTURE.md Section 3.5.
    if (a.slotIndex % 3 === 0 && a.recentThemeIds.length === 3) {
      showBonusPrompt();
      return;
    }

    startLevel();
  }

  function advanceOrFinishAttempt() {
    if (a.slotIndex >= SLOT_LETTERS.length) {
      endAttempt();
    } else {
      startLevel();
      window.showScreen('screen-game');
    }
  }

  function showBonusPrompt() {
    window.showScreen('screen-bonus-prompt');
  }

  function endAttempt() {
    stopTicking();
    a.status = 'completed';
    renderSummary();
    window.showScreen('screen-attempt-summary');

    // Payload Phase 5's Edge Function will eventually consume. Not sent
    // anywhere yet — see file header.
    // eslint-disable-next-line no-console
    console.log('Attempt payload (not yet submitted — Phase 5 pending):', {
      seed: a.seed,
      moves: a.moves,
    });
  }

  // ---- Input ----

  function onCellTap(r, c) {
    if (!selectedCell) {
      selectedCell = [r, c];
      renderBoard();
      return;
    }
    const [r1, c1] = selectedCell;
    if (r1 === r && c1 === c) {
      selectedCell = null;
      renderBoard();
      return;
    }
    const result = GameEngine.trySwap(a.board, r1, c1, r, c, a.rng);
    selectedCell = null;
    if (!result.valid) {
      // Invalid swap — does not consume a move, per
      // docs/ARCHITECTURE.md Section 3.1.
      renderBoard();
      return;
    }
    a.board = result.board;
    a.levelScore += result.score;
    a.movesRemaining--;
    a.moves.push({
      slot: a.isBonusLevel ? 'bonus' : SLOT_LETTERS[a.slotIndex],
      from: [r1, c1],
      to: [r, c],
      tMs: Math.round(performance.now() - a.levelStartTs),
    });
    renderBoard();
    renderHud();

    if (a.movesRemaining <= 0) {
      finishLevel();
    }
  }

  // ---- Rendering ----

  function setMessage(text) {
    el('game-message').innerHTML = '';
    if (text) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = text;
      el('game-message').appendChild(p);
    }
  }

  function renderBoard() {
    const boardEl = el('game-board');
    boardEl.innerHTML = '';
    const emojis = currentThemeEmojis();
    for (let r = 0; r < GameEngine.BOARD_SIZE; r++) {
      for (let c = 0; c < GameEngine.BOARD_SIZE; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'game-cell';
        if (selectedCell && selectedCell[0] === r && selectedCell[1] === c) {
          cell.classList.add('selected');
        }
        cell.textContent = emojis[a.board[r][c]];
        cell.addEventListener('click', () => onCellTap(r, c));
        boardEl.appendChild(cell);
      }
    }
  }

  function renderHud() {
    el('game-slot-label').textContent = a.isBonusLevel ? 'Bonus' : `Level ${SLOT_LETTERS[a.slotIndex]}`;
    el('game-moves').textContent = `Moves left: ${a.movesRemaining}`;
    el('game-lives').textContent = '❤️'.repeat(a.livesRemaining) || 'No lives';
    el('game-score').textContent = `Score: ${Math.round(a.totalScore + a.levelScore)}`;
  }

  function renderTimer(remainingMs) {
    el('game-timer').textContent = `${(remainingMs / 1000).toFixed(1)}s`;
  }

  function renderSummary() {
    const timeBonusMicros = Math.round(a.timeBonusMs * 1000);
    el('summary-score').textContent = `Score: ${Math.round(a.totalScore)} (client-computed, not yet server-validated)`;
    el('summary-time-bonus').textContent = `Time bonus: ${timeBonusMicros.toLocaleString()} µs`;
    el('summary-lives').textContent = `Lives remaining: ${a.livesRemaining}`;
    el('summary-levels').textContent = `Levels reached: ${a.levelsReached}`;
  }

  // ---- Bonus prompt screen hooks ----

  function acceptBonus() {
    // DEV STUB — Phase 10 replaces this with a real AdMob rewarded-video
    // flow, verified server-side, per the score-integrity rule.
    startLevel({ bonus: true });
    window.showScreen('screen-game');
  }

  function skipBonus() {
    startLevel();
    window.showScreen('screen-game');
  }

  return { startAttempt, acceptBonus, skipBonus };
})();

window.Attempt = Attempt;
