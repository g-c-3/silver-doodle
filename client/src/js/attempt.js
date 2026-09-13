// Match Emojis Daily — attempt orchestration (Phase 4: core game client)
//
// Mechanics (life pool, level completion/failure, bonus-round rules, time-
// bonus accounting) were ported from an uploaded playable prototype and are
// unchanged from the previous revision of this file — see docs/DECISIONS.md's
// 2026-09-12 "Phase 4 rebuild against the uploaded prototype" block for that
// history. This revision is a visual/interaction pass on top of that,
// requested against screenshots of the live build: swipe input, animated
// match feedback, a redesigned HUD, theme-colored accents, a level-complete
// celebration screen, and a couple of small bugs the screenshots caught
// (the reveal screen's Skip button showing on regular levels; the attempt
// summary's "lives used" count silently excluding the ad-earned life).
// See docs/DECISIONS.md's 2026-09-13 "Visual/interaction pass against
// screenshots" block for the specifics and reasoning behind each.
//
// PHASE 5 (score integrity): the attempt payload — {seed, levels[]}, one
// record per finished/failed level via pushLevelRecord() — is submitted to
// the `score-replay` Supabase Edge Function via submitAttempt() at attempt
// end. The client-computed a.totalScore/timeBonusMicros/etc. shown live
// during play are NEVER treated as final — the attempt-summary screen shows
// them only as a "(validating…)" preview until the Edge Function's response
// (a.serverResult) arrives, then switches to the server-authoritative
// figures. See docs/ARCHITECTURE.md Section 5 and server/functions/
// score-replay/index.ts for the payload contract and replay logic.
//
// KNOWN GAP: the Edge Function currently only computes and returns the
// authoritative result — it does not yet persist a row to `attempts`, since
// that table's game_definition_id is a NOT NULL FK into
// `daily_game_definitions`, which Phase 6 (not yet built) is what actually
// populates. Persistence, slot-cap enforcement, and score_day attribution
// are wired once Phase 6/7/8 land.
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

  // 26 themes, 6 emoji each — finalized by picking each theme's 6 from a
  // wider candidate list, one theme at a time, specifically to maximize
  // color/shape distinction within a theme (the original set had several
  // themes where 2-3 pieces were too visually similar — e.g. lion/tiger/
  // bear all tawny-brown, or hamster/rabbit/mouse all small pale rodents).
  // Every glyph is unique across the whole set — verified in the sandbox
  // before delivery, not just assumed.
  const THEMES = [
    { name: 'Pets', emojis: ['🐶', '🐱', '🐰', '🦔', '🐢', '🐾'] },
    { name: 'Farm Animals', emojis: ['🐮', '🐴', '🐑', '🦃', '🐔', '🦆'] },
    { name: 'Wild Animals', emojis: ['🐯', '🐼', '🐘', '🦓', '🦒', '🦏'] },
    { name: 'Faces & Emotions', emojis: ['😍', '😎', '🥳', '😡', '🤯', '🥶'] },
    { name: 'Birds', emojis: ['🦉', '🦜', '🐤', '🦢', '🦩', '🦚'] },
    { name: 'Sea Creatures', emojis: ['🐠', '🐡', '🦈', '🐬', '🐳', '🦭'] },
    { name: 'Ocean & Reef', emojis: ['🦀', '🐙', '🪼', '🐚', '🦞', '🐌'] },
    { name: 'Reptiles & Amphibians', emojis: ['🐊', '🐍', '🦎', '🐸', '🦖', '🦕'] },
    { name: 'Insects & Bugs', emojis: ['🐝', '🐞', '🐛', '🕷️', '🪲', '🦋'] },
    { name: 'Fantasy Creatures', emojis: ['🐉', '🦄', '🧜', '🧚', '🧌', '👻'] },
    { name: 'Fruits', emojis: ['🍏', '🍊', '🍌', '🍇', '🍓', '🍉'] },
    { name: 'Tropical Fruits', emojis: ['🍍', '🍑', '🥝', '🍒', '🥥', '🍋'] },
    { name: 'Vegetables', emojis: ['🥕', '🥦', '🍆', '🌽', '🧄', '🍅'] },
    { name: 'Desserts & Sweets', emojis: ['🍰', '🎂', '🍭', '🍫', '🧁', '🍪'] },
    { name: 'Fast Food & Snacks', emojis: ['🍕', '🍔', '🍟', '🌮', '🥙', '🥨'] },
    { name: 'Drinks & Beverages', emojis: ['☕', '🧋', '🥛', '🧃', '🍺', '🍷'] },
    { name: 'Musical Instruments', emojis: ['🎸', '🎹', '🥁', '🪕', '🎷', '🎤'] },
    { name: 'Sports Equipment', emojis: ['⚽', '🏈', '🎾', '🥎', '🏀', '🥊'] },
    { name: 'Land Vehicles', emojis: ['🚗', '🚌', '🚚', '🚜', '🏍️', '🚲'] },
    { name: 'Air & Sea Vehicles', emojis: ['✈️', '🚁', '🚀', '🚢', '⛵', '🛸'] },
    { name: 'Weather & Sky', emojis: ['☀️', '🌧️', '⚡', '❄️', '🌈', '🌪️'] },
    { name: 'Space & Celestial', emojis: ['🪐', '🌍', '🌙', '⭐', '☄️', '🌕'] },
    { name: 'Tools & Hardware', emojis: ['🪚', '⚙️', '🧰', '🪜', '🧲', '📏'] },
    { name: 'Electronics & Gadgets', emojis: ['🤖', '💻', '⌚', '🕹️', '🔋', '💡'] },
    { name: 'Card & Game Pieces', emojis: ['🎲', '♟️', '🧩', '🎳', '🎯', '🎰'] },
    { name: 'Seasonal & Holiday', emojis: ['🎄', '🧨', '🎁', '🎊', '🥚', '🕯️'] },
  ];

  const STARTING_LIVES = 3;
  const LEVEL_SECONDS = 60;
  const BONUS_SECONDS = 30;
  const LIFE_EXTENSION_SECONDS = 60;
  const SWIPE_THRESHOLD_PX = 18; // pointer movement below this is treated as a tap, not a swipe

  let a = null; // current attempt state
  let selectedCell = null; // [r,c] or null — used by the tap-tap flow only
  let tickHandle = null;
  let toastHideHandle = null;
  let pendingNext = null; // function to call from the level-complete screen's continue button

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

  // A distinct accent hue per theme, spread evenly around the color wheel —
  // 26 hand-picked colors would work too, but this guarantees even, visibly
  // distinct spacing without hand-tuning, and costs nothing to extend if
  // THEMES ever grows.
  function themeAccentColor(themeId) {
    const hue = Math.round((themeId * 360) / THEMES.length);
    return `hsl(${hue}, 72%, 64%)`;
  }

  function setThemeAccent(color) {
    document.documentElement.style.setProperty('--theme-accent', color);
  }

  function vibrate(ms) {
    if (window.navigator && typeof window.navigator.vibrate === 'function') {
      window.navigator.vibrate(ms);
    }
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
      adLivesUsedInRun: 0, // count of ad-lives actually used, across the whole attempt
      recentThemeIds: [], // last 3 *slot* themes completed, for bonus mixing
      payloadLevels: [], // Phase 5 submission payload — one record per finished/failed level, see pushLevelRecord()
      serverResult: null, // filled in once submitAttempt()'s Edge Function call resolves
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
      a.levelIcon = '🎁';
      setThemeAccent('var(--gold)');
    } else {
      const themeId = a.slotThemeIds[a.slotIndex];
      a.levelEmojis = THEMES[themeId].emojis;
      a.levelThemeName = THEMES[themeId].name;
      a.levelMovesTarget = SLOT_MOVE_TARGETS[a.slotIndex];
      a.levelSeconds = LEVEL_SECONDS;
      a.levelIcon = a.levelEmojis[0];
      setThemeAccent(themeAccentColor(themeId));
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
    a.locked = false;
    selectedCell = null;

    // Phase 5 payload tracking for this level — see pushLevelRecord() and
    // currentLevelElapsedMs(). Reset fresh per level; a life extension updates
    // levelElapsedBaseMs/currentSegmentMs in place rather than resetting these.
    a.currentLevelMoves = [];
    a.levelElapsedBaseMs = 0;
    a.currentSegmentMs = a.levelSeconds * 1000;
    a.livesUsedAtLevelStart = a.livesUsedInRun;

    setMessage('');
    renderBoard();
    renderHud();
    startTimer(a.levelSeconds);
    window.showScreen('screen-game');
  }

  // ---- Timer ----
  // Deadline-based (tickTarget = performance.now() + remaining), not
  // elapsed-based, specifically so a life/ad-life can extend the deadline
  // in place without disturbing the board or move count. Ticks every 50ms
  // (rather than 1s) so the displayed ss:mmm:µµµ clock reads as continuously
  // running rather than jumping once a second — this is a cosmetic
  // consistency choice with the sec:milli:micro time-bonus format, not a
  // claim of real microsecond-accurate timing.

  function startTimer(seconds) {
    a.tickTarget = performance.now() + seconds * 1000;
    stopTicking();
    tickHandle = setInterval(tick, 50);
    tick();
  }

  function extendTimer(seconds) {
    a.tickTarget = performance.now() + seconds * 1000;
    stopTicking();
    tickHandle = setInterval(tick, 50);
  }

  function stopTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
  }

  function msRemaining() {
    return Math.max(0, a.tickTarget - performance.now());
  }

  // Cumulative elapsed ms on THIS level's own clock, since its very first
  // start — survives across any life/ad-life extension, unlike msRemaining()
  // which is always relative to the *current* timer segment. This is what
  // Phase 5's score-replay Edge Function needs to independently recompute
  // time bonus: budgetMs (60s/30s + 60s per life/ad-life used) minus this
  // value at the moment the level ended.
  function currentLevelElapsedMs() {
    return a.levelElapsedBaseMs + (a.currentSegmentMs - msRemaining());
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
      // The just-expired segment is fully spent (timeout only fires at
      // remaining<=0) — bank its whole length before starting the next one.
      a.levelElapsedBaseMs += a.currentSegmentMs;
      a.currentSegmentMs = LIFE_EXTENSION_SECONDS * 1000;
      showToast(`💗 Life used (${a.livesUsedInRun}/${STARTING_LIVES}) — +${LIFE_EXTENSION_SECONDS}s`);
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
      a.adLivesUsedInRun++;
      a.levelElapsedBaseMs += a.currentSegmentMs;
      a.currentSegmentMs = LIFE_EXTENSION_SECONDS * 1000;
      setMessage('');
      showToast(`🎬 Ad watched — +${LIFE_EXTENSION_SECONDS}s`);
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

  // Ends the whole attempt immediately — not just the current level. The
  // level in progress contributes 0 score and 0 time bonus (ARCHITECTURE.md
  // Section 3.3), since a.levelScore was never committed to a.totalScore.
  function failAttempt() {
    stopTicking();
    pushLevelRecord('failed');
    a.status = 'completed';
    renderSummary();
    window.showScreen('screen-attempt-summary');
    submitAttempt();
  }

  // ---- Phase 5 payload assembly ----
  // One record per level (finished or failed), appended right before that
  // level's outcome is committed — not derived after the fact from a flat
  // move log, so there's no ambiguity about which moves/lives/timing belong
  // to which level once the shared life pool and slot index have moved on.
  function pushLevelRecord(outcome) {
    a.payloadLevels.push({
      slot: a.isBonusLevel ? 'bonus' : SLOT_LETTERS[a.slotIndex],
      isBonus: a.isBonusLevel,
      moves: a.currentLevelMoves, // [[r1,c1,r2,c2], ...], in play order
      livesUsedThisLevel: a.livesUsedInRun - a.livesUsedAtLevelStart, // regular-pool lives spent to keep this level alive
      adLifeUsed: a.adLifeUsedThisLevel,
      elapsedMsAtEnd: Math.round(currentLevelElapsedMs()),
      outcome, // 'completed' | 'failed' — 'failed' only ever the payload's last entry
    });
  }

  // Submits {seed, levels} to the score-replay Edge Function (Phase 5),
  // which deterministically re-derives every board from the seed, replays
  // each level's moves through the same match/cascade/scoring rules as
  // GameEngine, and returns the authoritative score/time bonus/lives used/
  // levels reached. The client-computed a.totalScore shown up to this point
  // is never trusted as-is — only the server's response is.
  async function submitAttempt() {
    try {
      const { data, error } = await window.db.functions.invoke('score-replay', {
        body: { seed: a.seed, levels: a.payloadLevels },
      });
      if (error) throw error;
      a.serverResult = data;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Score-replay submission failed:', err);
      a.serverResult = { valid: false, error: 'Could not reach the server. Score not yet validated.' };
    }
    // Only re-render if the summary screen is still what's showing — a fast
    // player could in principle already be elsewhere, though nothing in the
    // current flow lets them navigate away from it.
    if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) {
      renderSummary();
    }
  }

  // ---- Level completion ----

  function finishRegularLevel() {
    stopTicking();
    const leftoverMs = msRemaining();
    const bankedThisLevel = bankedMicros(leftoverMs);
    a.timeBonusMicros += bankedThisLevel;
    a.totalScore += a.levelScore;
    a.levelsReached++;
    pushLevelRecord('completed'); // before slotIndex++ — record belongs to the slot just finished

    const themeId = a.slotThemeIds[a.slotIndex];
    a.recentThemeIds.push(themeId);
    if (a.recentThemeIds.length > 3) a.recentThemeIds.shift();

    a.slotIndex++;
    let next;
    if (a.slotIndex >= SLOT_LETTERS.length) {
      next = finishAttempt;
    } else if (a.slotIndex % 3 === 0 && a.recentThemeIds.length === 3) {
      // Bonus round offered every 3rd *completed* slot, per
      // docs/ARCHITECTURE.md Section 3.5.
      next = showBonusPrompt;
    } else {
      next = () => prepareLevel({ bonus: false });
    }

    showLevelCompleteScreen({
      eyebrow: 'Level cleared',
      title: `${a.levelThemeName} — done! 🎉`,
      points: a.levelScore,
      timeBonusThisLevel: bankedThisLevel,
      continueLabel: a.slotIndex >= SLOT_LETTERS.length ? 'See results' : 'Play next',
      next,
    });
  }

  function finishBonusLevel() {
    a.totalScore += a.levelScore; // bonus score is never subject to the "incomplete = 0" rule
    a.levelsReached++;
    pushLevelRecord('completed');
    const next = a.slotIndex >= SLOT_LETTERS.length ? finishAttempt : () => prepareLevel({ bonus: false });

    showLevelCompleteScreen({
      eyebrow: 'Bonus round over',
      title: 'Nice bonus round! 🎁',
      points: a.levelScore,
      timeBonusThisLevel: 0, // bonus rounds never bank time bonus
      continueLabel: a.slotIndex >= SLOT_LETTERS.length ? 'See results' : 'Continue',
      next,
    });
  }

  function finishAttempt() {
    stopTicking();
    a.status = 'completed';
    renderSummary();
    window.showScreen('screen-attempt-summary');
    submitAttempt();
  }

  // sec:milli:micro digit-clock accumulation, per ARCHITECTURE.md Section 3.3.
  function bankedMicros(remainingMs) {
    const wholeMs = Math.floor(remainingMs);
    const fractionalUs = Math.round((remainingMs - wholeMs) * 1000);
    return wholeMs * 1000 + fractionalUs;
  }

  function livesStatusText() {
    let text = `${a.livesUsedInRun}/${STARTING_LIVES} regular`;
    if (a.adLivesUsedInRun > 0) {
      text += ` + ${a.adLivesUsedInRun} ad-life${a.adLivesUsedInRun === 1 ? '' : 's'}`;
    }
    return text;
  }

  // ---- Level-complete celebration + stats screen ----

  function showLevelCompleteScreen(data) {
    pendingNext = data.next;
    el('level-complete-eyebrow').textContent = data.eyebrow;
    el('level-complete-title').textContent = data.title;
    el('lc-points').textContent = `+${Math.round(data.points)}`;
    el('lc-time-bonus').textContent = data.timeBonusThisLevel > 0 ? formatTimeBonus(data.timeBonusThisLevel) : '—';
    el('lc-total-score').textContent = Math.round(a.totalScore).toLocaleString();
    el('lc-lives').textContent = livesStatusText();
    el('level-complete-continue-btn').textContent = data.continueLabel;
    spawnConfetti();
    window.showScreen('screen-level-complete');
  }

  function continueAfterLevelComplete() {
    const next = pendingNext;
    pendingNext = null;
    if (next) next();
  }

  function spawnConfetti() {
    const field = el('level-complete-confetti');
    field.innerHTML = '';
    const colors = ['#ff6f91', '#7c6fff', '#5eead4', '#f5b942', '#4ade80', '#38bdf8'];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      const angle = Math.random() * Math.PI * 2;
      const dist = 90 + Math.random() * 170;
      piece.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      piece.style.setProperty('--dy', `${Math.sin(angle) * dist - 50}px`);
      piece.style.setProperty('--rot', `${Math.round(Math.random() * 360)}deg`);
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.round(Math.random() * 140)}ms`;
      field.appendChild(piece);
    }
    // Celebration runs ~1.5s total (140ms max stagger + 1.1s animation);
    // clean up afterward so it doesn't linger behind the next screen.
    setTimeout(() => {
      field.innerHTML = '';
    }, 1500);
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

  // ---- Input: tap-tap AND swipe both work ----

  function cellEl(r, c) {
    return document.querySelector(`.game-cell[data-r="${r}"][data-c="${c}"]`);
  }

  function onPointerDown(r, c, e) {
    if (a.locked) return;
    a.dragStart = { r, c, x: e.clientX, y: e.clientY };
  }

  // Registered once on the document, not per-cell — a swipe released
  // outside any cell (e.g. dragged off the board edge) would otherwise
  // never fire and leave a.dragStart stale, corrupting the next touch.
  document.addEventListener('pointerup', (e) => {
    if (!a || a.locked || !a.dragStart) return;
    const start = a.dragStart;
    a.dragStart = null;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dist = Math.hypot(dx, dy);

    if (dist >= SWIPE_THRESHOLD_PX) {
      // Swipe: swap directly with whichever adjacent cell the drag points
      // toward. Any pending tap-selection is discarded — a swipe is a
      // complete gesture on its own.
      selectedCell = null;
      let tr = start.r;
      let tc = start.c;
      if (Math.abs(dx) > Math.abs(dy)) {
        tc += dx > 0 ? 1 : -1;
      } else {
        tr += dy > 0 ? 1 : -1;
      }
      if (tr >= 0 && tr < GameEngine.BOARD_SIZE && tc >= 0 && tc < GameEngine.BOARD_SIZE) {
        attemptSwapAt(start.r, start.c, tr, tc);
      } else {
        renderBoard();
      }
      return;
    }

    // Tap: fall back to the original select-then-tap-adjacent flow.
    handleTap(start.r, start.c);
  });

  function handleTap(r, c) {
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
    selectedCell = null;
    attemptSwapAt(r1, c1, r, c);
  }

  // Runs the swap through the engine, then plays swap → blast → settle as a
  // short animated sequence before checking level completion. Only the
  // swap's own immediate match is blasted at exact positions (see
  // GameEngine.trySwapDetailed's comment) — any further cascade rounds
  // resolve directly to the final board after the same pause.
  function attemptSwapAt(r1, c1, r2, c2) {
    const result = GameEngine.trySwapDetailed(a.board, r1, c1, r2, c2, a.rng);

    if (!result.valid) {
      vibrate(40);
      [cellEl(r1, c1), cellEl(r2, c2)].forEach((node) => {
        if (!node) return;
        node.classList.remove('invalid-shake');
        void node.offsetWidth; // restart the animation if it's already mid-shake
        node.classList.add('invalid-shake');
      });
      renderBoard();
      return;
    }

    a.locked = true;
    a.board = result.swappedBoard;
    renderBoard();

    if (!a.isBonusLevel) a.movesMade++;
    a.currentLevelMoves.push([r1, c1, r2, c2]);

    setTimeout(() => {
      result.firstRoundCleared.forEach((key) => {
        const [r, c] = key.split(',').map(Number);
        const node = cellEl(r, c);
        if (node) node.classList.add('blasting');
      });
    }, 90);

    setTimeout(() => {
      a.board = result.finalBoard;
      a.levelScore += result.totalScore;
      renderBoard();
      renderHud();
      a.locked = false;

      if (!a.isBonusLevel && a.movesMade >= a.levelMovesTarget) {
        finishRegularLevel();
      }
    }, 420);
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

  function showToast(text) {
    const t = el('game-toast');
    clearTimeout(toastHideHandle);
    t.textContent = text;
    t.classList.remove('hidden');
    t.style.animation = 'none';
    void t.offsetWidth; // restart the CSS animation even if a toast is already showing
    t.style.animation = '';
    toastHideHandle = setTimeout(() => {
      t.classList.add('hidden');
    }, 3000);
  }

  function renderReveal() {
    el('reveal-eyebrow').textContent = a.isBonusLevel ? 'Optional Bonus' : 'Theme Reveal';
    el('reveal-title').textContent = a.isBonusLevel
      ? 'Bonus round'
      : `Level ${SLOT_LETTERS[a.slotIndex]} — ${a.levelThemeName}`;
    const emojiGrid = el('reveal-emojis');
    emojiGrid.innerHTML = '';
    a.levelEmojis.forEach((emoji) => {
      const span = document.createElement('span');
      span.textContent = emoji;
      emojiGrid.appendChild(span);
    });
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
        const pieceIndex = a.board[r][c];
        cell.className = `game-cell tile-color-${pieceIndex}`;
        cell.dataset.r = r;
        cell.dataset.c = c;
        if (selectedCell && selectedCell[0] === r && selectedCell[1] === c) {
          cell.classList.add('selected');
        }
        cell.textContent = a.levelEmojis[pieceIndex];
        cell.addEventListener('pointerdown', (e) => onPointerDown(r, c, e));
        boardEl.appendChild(cell);
      }
    }
  }

  function renderThemeBanner() {
    el('theme-banner-icon').textContent = a.levelIcon;
    el('theme-banner-level').textContent = a.isBonusLevel ? 'Bonus round' : `Level ${SLOT_LETTERS[a.slotIndex]}`;
    el('theme-banner-name').textContent = a.levelThemeName;
  }

  function renderHud() {
    renderThemeBanner();
    el('game-moves').textContent = a.isBonusLevel ? '—' : `${a.movesMade}/${a.levelMovesTarget}`;
    const livesLeft = STARTING_LIVES - a.livesUsedInRun;
    el('game-lives').textContent = a.isBonusLevel
      ? '—'
      : '❤️'.repeat(Math.max(0, livesLeft)) + '🤍'.repeat(Math.min(STARTING_LIVES, a.livesUsedInRun)) + (a.adLifeUsedThisLevel ? ' 🎬' : '');

    const scoreEl = el('game-score');
    const newScoreText = Math.round(a.totalScore + a.levelScore).toLocaleString();
    if (scoreEl.textContent !== newScoreText) {
      scoreEl.textContent = newScoreText;
      scoreEl.classList.remove('score-pop');
      void scoreEl.offsetWidth; // restart the pop animation on every change
      scoreEl.classList.add('score-pop');
    }
    el('game-timebonus').textContent = formatTimeBonus(a.timeBonusMicros);
  }

  function formatCountdown(remainingMs) {
    const wholeMs = Math.max(0, Math.floor(remainingMs));
    const fractionalUs = Math.round((remainingMs - Math.floor(remainingMs)) * 1000);
    const s = Math.floor(wholeMs / 1000);
    const ms = wholeMs % 1000;
    const pad = (n, l) => String(n).padStart(l, '0');
    return { sec: pad(s, 2), sub: `${pad(ms, 3)}:${pad(Math.max(0, fractionalUs), 3)}` };
  }

  function renderTimer(remainingMs) {
    const { sec, sub } = formatCountdown(remainingMs);
    el('game-timer-sec').textContent = sec;
    el('game-timer-sub').textContent = sub;
    el('game-timer-sec').closest('.hud-chip-timer').classList.toggle('timer-warn', remainingMs <= 10000);
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
    const r = a.serverResult;
    if (!r) {
      // Submission still in flight — client-computed figures shown as a
      // provisional preview only, explicitly labeled as such.
      el('summary-score').textContent = `${Math.round(a.totalScore).toLocaleString()} (validating…)`;
      el('summary-time-bonus').textContent = `${formatTimeBonus(a.timeBonusMicros)} (mm:ss:ms:µs, provisional)`;
      el('summary-lives').textContent = `${livesStatusText()} (provisional)`;
      el('summary-levels').textContent = `${a.levelsReached} (provisional)`;
      return;
    }
    if (!r.valid) {
      el('summary-score').textContent = `Not validated — ${r.error || 'unknown error'}`;
      el('summary-time-bonus').textContent = '—';
      el('summary-lives').textContent = '—';
      el('summary-levels').textContent = '—';
      return;
    }
    // Server-authoritative figures — this is what actually counts once
    // Phase 6/7 wire attempts into persistence and the leaderboard.
    el('summary-score').textContent = `${Math.round(r.score).toLocaleString()} (server-validated)`;
    el('summary-time-bonus').textContent = `${formatTimeBonus(r.timeBonusMicros)} (mm:ss:ms:µs)`;
    el('summary-lives').textContent =
      `${r.livesUsed}/${STARTING_LIVES} regular` + (r.adLivesUsed > 0 ? ` + ${r.adLivesUsed} ad-life${r.adLivesUsed === 1 ? '' : 's'}` : '');
    el('summary-levels').textContent = `${r.levelsReached}`;
  }

  return {
    startAttempt,
    confirmReveal,
    skipBonusFromReveal,
    acceptBonus,
    skipBonus,
    continueAfterLevelComplete,
  };
})();

window.Attempt = Attempt;
