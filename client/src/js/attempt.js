// Match Emojis Daily — attempt orchestration (Phase 4: core game client)
//
// Ported from an uploaded playable spec demo (daily-match-playable-demo.html,
// a 4-level proof-of-concept of the full 26-slot design) after an earlier
// version of this file was written from ARCHITECTURE.md's spec text alone —
// the ARCHITECTURE.md text alone did not have (and the demo clarified):
//   - losing a life extends the SAME level's timer by 60s and continues on
//     the same board/moves progress — it does NOT regenerate the board.
//   - the 3 regular lives are consumed automatically, in order, before the
//     one ad-earned life is ever offered.
//   - running out of every life (3 regular + the ad-life) ends the WHOLE
//     ATTEMPT immediately, not just the current level.
//   - every level (bonus or not) is preceded by a mandatory theme-reveal
//     screen; only the bonus reveal has a Skip.
//   - bonus rounds run a flat 30s clock with no move cap and no life risk,
//     using 2 emoji drawn from each of the 3 most recently completed themes.
// See docs/DECISIONS.md's 2026-09-12 "Phase 4 rebuild against the uploaded
// prototype" block for the full reconciliation, including the one place
// this file deliberately does NOT copy the prototype: the demo's own
// on-timeout copy claims an incomplete level "banks zero score," but its
// code never rolls back the score already earned from matches made mid-
// level. ARCHITECTURE.md Section 3.3 is explicit ("An incomplete level
// contributes 0 to both Score and Time Bonus") and is treated as the
// correct spec here — this file holds a level's score in a scratch total
// and only commits it to the attempt total on successful completion.
//
// KNOWN GAP: score submission to the Phase 5 Edge Function is not wired yet
// (Phase 5 doesn't exist). The {seed, moves[]} payload is assembled and
// logged to the console / shown in the summary screen, but nothing is sent
// over the network and nothing is persisted. The score shown to the player
// right now is client-computed and NOT authoritative.
//
// KNOWN GAP: docs/ARCHITECTURE.md Section 4 describes the daily game
// definitions (12/day, identical for every player, server-generated) as a
// Phase 6 deliverable. Phase 6 doesn't exist yet, so this file generates its
// own attempt seed and theme shuffle client-side purely so the game is
// playable/testable now. Swap `startAttempt()`'s seed/theme-shuffle source
// for the real daily definition + player order once Phase 6 lands.

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

  const STARTING_LIVES = 3; // confirmed by the uploaded prototype
  const LEVEL_SECONDS = 60;
  const BONUS_SECONDS = 30; // from the prototype — not previously specified anywhere
  const LIFE_EXTENSION_SECONDS = 60; // from the prototype — a life/ad-life adds this much time, doesn't reset the board

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

  // ---- Attempt lifecycle ----

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
      timeBonusMicros: 0,
      livesUsedInRun: 0, // shared across the WHOLE attempt, never reset per level
      recentThemeIds: [], // last 3 *slot* themes completed, for bonus mixing
      moves: [],
    };
    selectedCell = null;
    prepareLevel({ bonus: false });
  }

  function prepareLevel(opts) {
    a.isBonusLevel = !!opts.bonus;
    a.adLifeUsedThisLevel = false;

    if (a.isBonusLevel) {
      const pickRng = GameEngine.makeRng(`${a.seed}:bonus:${a.slotIndex}:pick`);
      // 2 emoji from each of the last 3 completed themes — a visible mix,
      // not an arbitrary pool, per the uploaded prototype.
      a.levelEmojis = a.recentThemeIds.flatMap((id) =>
        shuffle(THEMES[id].emojis, pickRng).slice(0, 2)
      );
      a.levelThemeName = 'Bonus mix';
      a.levelMovesTarget = null; // no move cap in a bonus round
      a.levelSeconds = BONUS_SECONDS;
    } else {
      const themeId = a.slotThemeIds[a.slotIndex];
      a.levelEmojis = THEMES[themeId].emojis;
      a.levelThemeName = THEMES[themeId].name;
      a.levelMovesTarget = SLOT_MOVE_TARGETS[a.slotIndex];
      a.levelSeconds = LEVEL_SECONDS;
    }

    renderReveal();
    window.showScreen('screen-level-reveal');
  }

  function beginLevel() {
    const boardRng = GameEngine.makeRng(`${a.seed}:${a.isBonusLevel ? 'bonus' : 'slot'}:${a.slotIndex}:board`);
    a.rng = boardRng;
    a.board = GameEngine.generatePlayableBoard(boardRng);
    a.movesMade = 0;
    a.levelScore = 0; // scratch total for this level only — committed to a.totalScore on completion
    selectedCell = null;

    setMessage('');
    renderBoard();
    renderHud();
    startTimer(a.levelSeconds);
    window.showScreen('screen-game');
  }

  // ---- Timer ----
  // Deadline-based (tickTarget = performance.now() + remaining), not
  // elapsed-based, specifically so a life/ad-life can extend the deadline
  // in place without disturbing the board or move count.

  function startTimer(seconds) {
    a.tickTarget = performance.now() + seconds * 1000;
    stopTicking();
    tickHandle = setInterval(tick, 100);
    tick();
  }

  function extendTimer(seconds) {
    a.tickTarget = performance.now() + seconds * 1000;
    stopTicking();
    tickHandle = setInterval(tick, 100);
  }

  function stopTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
  }

  function msRemaining() {
    return Math.max(0, a.tickTarget - performance.now());
  }

  function tick() {
    const remaining = msRemaining();
    renderTimer(remaining);
    if (remaining <= 0) {
      stopTicking();
      handleTimeout();
    }
  }

  // ---- Timeout / life handling ----

  function handleTimeout() {
    if (a.isBonusLevel) {
      // Bonus rounds carry no life risk — whatever was scored stands, and
      // no time bonus is banked for them (only regular slots feed the
      // Section 3.3 time-bonus accumulator).
      finishBonusLevel();
      return;
    }
    if (a.livesUsedInRun < STARTING_LIVES) {
      a.livesUsedInRun++;
      flashLifeToast(`Life used (${a.livesUsedInRun}/${STARTING_LIVES} this attempt) — +${LIFE_EXTENSION_SECONDS}s`);
      renderHud();
      extendTimer(LIFE_EXTENSION_SECONDS);
      return;
    }
    if (!a.adLifeUsedThisLevel) {
      offerAdLife();
      return;
    }
    failAttempt();
  }

  function offerAdLife() {
    const box = el('game-message');
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Out of lives for this attempt. Watch an ad for +${LIFE_EXTENSION_SECONDS}s on this level, or give up?`;
    box.appendChild(p);

    const adBtn = document.createElement('button');
    adBtn.className = 'secondary';
    adBtn.textContent = 'Watch ad for extra time (dev stub)';
    adBtn.addEventListener('click', () => {
      // DEV STUB — Phase 10 replaces this with a real AdMob rewarded-video
      // flow verified server-side via SSV. Never trust a client "ad
      // watched" flag once that phase lands.
      a.adLifeUsedThisLevel = true;
      setMessage('');
      renderHud();
      extendTimer(LIFE_EXTENSION_SECONDS);
    });

    const giveUpBtn = document.createElement('button');
    giveUpBtn.className = 'danger';
    giveUpBtn.textContent = 'Give up';
    giveUpBtn.addEventListener('click', () => failAttempt());

    box.appendChild(adBtn);
    box.appendChild(giveUpBtn);
  }

  function flashLifeToast(text) {
    setMessage(text);
  }

  // Ends the whole attempt immediately — not just the current level. The
  // level in progress contributes 0 score and 0 time bonus (ARCHITECTURE.md
  // Section 3.3), since a.levelScore was never committed to a.totalScore.
  function failAttempt() {
    stopTicking();
    a.status = 'completed';
    renderSummary();
    window.showScreen('screen-attempt-summary');
    logPayload();
  }

  // ---- Level completion ----

  function finishRegularLevel() {
    stopTicking();
    const leftoverMs = msRemaining();
    a.timeBonusMicros += bankedMicros(leftoverMs);
    a.totalScore += a.levelScore;
    a.levelsReached++;

    const themeId = a.slotThemeIds[a.slotIndex];
    a.recentThemeIds.push(themeId);
    if (a.recentThemeIds.length > 3) a.recentThemeIds.shift();

    a.slotIndex++;
    if (a.slotIndex >= SLOT_LETTERS.length) {
      finishAttempt();
      return;
    }

    // Bonus round offered every 3rd *completed* slot, per
    // docs/ARCHITECTURE.md Section 3.5.
    if (a.slotIndex % 3 === 0 && a.recentThemeIds.length === 3) {
      showBonusPrompt();
      return;
    }

    prepareLevel({ bonus: false });
  }

  function finishBonusLevel() {
    a.totalScore += a.levelScore; // bonus score is never subject to the "incomplete = 0" rule
    a.levelsReached++;
    if (a.slotIndex >= SLOT_LETTERS.length) {
      finishAttempt();
    } else {
      prepareLevel({ bonus: false });
    }
  }

  function finishAttempt() {
    stopTicking();
    a.status = 'completed';
    renderSummary();
    window.showScreen('screen-attempt-summary');
    logPayload();
  }

  function logPayload() {
    // Payload Phase 5's Edge Function will eventually consume. Not sent
    // anywhere yet — see file header.
    // eslint-disable-next-line no-console
    console.log('Attempt payload (not yet submitted — Phase 5 pending):', {
      seed: a.seed,
      moves: a.moves,
    });
  }

  // sec:milli:micro digit-clock accumulation, per ARCHITECTURE.md Section 3.3.
  function bankedMicros(remainingMs) {
    const wholeMs = Math.floor(remainingMs);
    const fractionalUs = Math.round((remainingMs - wholeMs) * 1000);
    return wholeMs * 1000 + fractionalUs;
  }

  // ---- Bonus prompt ----

  function showBonusPrompt() {
    window.showScreen('screen-bonus-prompt');
  }

  function acceptBonus() {
    // DEV STUB — Phase 10 replaces this with a real AdMob rewarded-video
    // flow, verified server-side, per the score-integrity rule.
    prepareLevel({ bonus: true });
  }

  function skipBonus() {
    prepareLevel({ bonus: false });
  }

  // ---- Reveal screen ----

  function skipBonusFromReveal() {
    prepareLevel({ bonus: false });
  }

  function confirmReveal() {
    beginLevel();
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
    if (!a.isBonusLevel) a.movesMade++;
    a.moves.push({
      slot: a.isBonusLevel ? 'bonus' : SLOT_LETTERS[a.slotIndex],
      from: [r1, c1],
      to: [r, c],
      tMs: Math.round(a.levelSeconds * 1000 - msRemaining()),
    });
    renderBoard();
    renderHud();

    if (!a.isBonusLevel && a.movesMade >= a.levelMovesTarget) {
      finishRegularLevel();
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

  function renderReveal() {
    el('reveal-eyebrow').textContent = a.isBonusLevel ? 'Optional Bonus' : 'Theme Reveal';
    el('reveal-title').textContent = a.isBonusLevel
      ? 'Bonus round'
      : `Level ${SLOT_LETTERS[a.slotIndex]} — ${a.levelThemeName}`;
    el('reveal-emojis').textContent = a.levelEmojis.join(' ');
    el('reveal-theme-name').textContent = a.levelThemeName;
    el('reveal-sub').textContent = a.isBonusLevel
      ? `${BONUS_SECONDS} seconds · no lives · mix of your last 3 themes`
      : `Clear ${a.levelMovesTarget} moves in ${LEVEL_SECONDS} seconds.`;
    el('reveal-skip-btn').classList.toggle('hidden', !a.isBonusLevel);
  }

  function renderBoard() {
    const boardEl = el('game-board');
    boardEl.innerHTML = '';
    for (let r = 0; r < GameEngine.BOARD_SIZE; r++) {
      for (let c = 0; c < GameEngine.BOARD_SIZE; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'game-cell';
        if (selectedCell && selectedCell[0] === r && selectedCell[1] === c) {
          cell.classList.add('selected');
        }
        cell.textContent = a.levelEmojis[a.board[r][c]];
        cell.addEventListener('click', () => onCellTap(r, c));
        boardEl.appendChild(cell);
      }
    }
  }

  function renderHud() {
    el('game-slot-label').textContent = a.isBonusLevel ? 'Bonus' : `Level ${SLOT_LETTERS[a.slotIndex]}`;
    el('game-moves').textContent = a.isBonusLevel ? 'Moves: —' : `Moves: ${a.movesMade}/${a.levelMovesTarget}`;
    const livesLeft = STARTING_LIVES - a.livesUsedInRun;
    el('game-lives').textContent = a.isBonusLevel
      ? '—'
      : '❤️'.repeat(Math.max(0, livesLeft)) + (a.adLifeUsedThisLevel ? ' 🩹' : '');
    el('game-score').textContent = `Score: ${Math.round(a.totalScore + a.levelScore)}`;
  }

  function renderTimer(remainingMs) {
    const timerEl = el('game-timer');
    const secs = Math.ceil(remainingMs / 1000);
    timerEl.textContent = `${secs}s`;
    timerEl.classList.toggle('timer-warn', secs <= 10);
  }

  function formatTimeBonus(micros) {
    const totalMs = Math.floor(micros / 1000);
    const us = micros % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const ms = totalMs % 1000;
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    const pad = (n, l) => String(Math.floor(n)).padStart(l, '0');
    return `${pad(mm, 2)}:${pad(ss, 2)}:${pad(ms, 3)}:${pad(us, 3)}`;
  }

  function renderSummary() {
    el('summary-score').textContent = `Score: ${Math.round(a.totalScore)} (client-computed, not yet server-validated)`;
    el('summary-time-bonus').textContent = `Time bonus: ${formatTimeBonus(a.timeBonusMicros)} (mm:ss:ms:µs)`;
    el('summary-lives').textContent = `Lives used: ${a.livesUsedInRun}/${STARTING_LIVES}`;
    el('summary-levels').textContent = `Levels reached: ${a.levelsReached}`;
  }

  return { startAttempt, confirmReveal, skipBonusFromReveal, acceptBonus, skipBonus };
})();

window.Attempt = Attempt;
