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
// PHASE 6 (daily game definitions): startAttempt() calls the `start-attempt`
// Edge Function, which assigns this player's daily serving order (on their
// first call of the day) and returns the shared, server-generated 26 slots
// (theme + fixed board pattern) for whichever of the day's 12 identical game
// definitions this attempt is. Regular-slot boards come straight from that
// response (server-authoritative, identical for every player); bonus-round
// boards aren't pre-stored (no schema slot for them) and are instead derived
// client-side from the shared gameDefinitionId, which still guarantees every
// player sees the same bonus board at the same point — see
// docs/DECISIONS.md's 2026-09-14 Phase 6 entry for the reasoning.
//
// PHASE 8 (forfeit detection): startAttempt() also starts a ~20s heartbeat
// (startHeartbeat()/sendHeartbeat()) for the lifetime of the attempt,
// stopped on both terminal paths (failAttempt(), finishAttempt()). This only
// proves liveness to the server — see server/functions/attempt-heartbeat/
// index.ts and forfeit-stale-attempts/index.ts (the scheduled sweep that
// actually marks a stale attempt forfeited) for the full mechanism.
//
// PHASE 5 (score integrity): the attempt payload — {attemptId,
// gameDefinitionId, levels[]}, one record per finished/failed level via
// pushLevelRecord() — is submitted to the `score-replay` Supabase Edge
// Function via submitAttempt() at attempt end. The client-computed
// a.totalScore/timeBonusMicros/etc. shown live during play are NEVER
// treated as final — the attempt-summary screen shows them only as a
// "Score is being saved, please wait..." preview until the Edge Function's
// response (a.serverResult) arrives, then switches to the server-authoritative
// figures. See docs/ARCHITECTURE.md Section 5 and server/functions/
// score-replay/index.ts for the payload contract and replay logic.
//
// PHASE 10 (ads): offerAdLife()'s ad button and acceptBonus() now call
// playRewardedAd(), a real AdMob rewarded-video flow (not a dev stub) via
// window.Capacitor.Plugins.AdMob, with ssv.customData set to
// `${attemptId}:${slotIndex}:life|bonus`. The reward the client sees here
// is purely a UX signal, never trusted for scoring — score-replay/index.ts
// independently requires a matching row in ad_verifications, written only
// by admob-ssv/index.ts after verifying Google's own signed server-to-
// server callback. See docs/ARCHITECTURE.md Section 5.

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
  // SECURITY/COMPATIBILITY FIX (2026-09-19, §5.13): the 7 glyphs below
  // that used to be 🦭 🪲 🧋 🪚 🪜 🧌 🪼 were Emoji 13.0–15.0 — unsupported
  // on a real share of this app's target devices, rendering as blank boxes
  // (see docs/DECISIONS.md's 2026-09-19 (later still) entry). Two blank
  // tiles in the same theme are indistinguishable, so a valid match looked
  // like a non-match. Replaced with Emoji ≤12.0 equivalents (verified via
  // web search against Unicode's own emoji-data.txt / Emojipedia, not
  // assumed from memory — 🦐 Emoji 9.0, 🦑 Emoji 3.0, 🧙 Emoji 5.0, the
  // rest Emoji 0.6–1.0) and minSdk raised to 29 (Android 10) below, which
  // is the actual floor Emoji 12.0 needs — see client/android's generated
  // build.gradle / .github/workflows/scripts/patch_build_gradle.py for
  // where that's enforced. Chosen to keep each theme thematically
  // coherent and every glyph within a theme still visually distinct:
  //   Sea Creatures:    🦭 seal      -> 🦐 shrimp
  //   Insects & Bugs:   🪲 beetle    -> 🐜 ant
  //   Drinks:           🧋 boba      -> 🍹 tropical drink
  //   Tools & Hardware: 🪚 saw       -> 🔨 hammer
  //                     🪜 ladder    -> 🔧 wrench
  //   Fantasy Creatures: 🧌 troll    -> 🧙 mage
  //   Ocean & Reef:      🪼 jellyfish -> 🦑 squid
  const THEMES = [
    { name: 'Pets', emojis: ['🐶', '🐱', '🐰', '🦔', '🐢', '🐾'] },
    { name: 'Farm Animals', emojis: ['🐮', '🐴', '🐑', '🦃', '🐔', '🦆'] },
    { name: 'Wild Animals', emojis: ['🐯', '🐼', '🐘', '🦓', '🦒', '🦏'] },
    { name: 'Faces & Emotions', emojis: ['😍', '😎', '🥳', '😡', '🤯', '🥶'] },
    { name: 'Birds', emojis: ['🦉', '🦜', '🐤', '🦢', '🦩', '🦚'] },
    { name: 'Sea Creatures', emojis: ['🐠', '🐡', '🦈', '🐬', '🐳', '🦐'] },
    { name: 'Ocean & Reef', emojis: ['🦀', '🐙', '🦑', '🐚', '🦞', '🐌'] },
    { name: 'Reptiles & Amphibians', emojis: ['🐊', '🐍', '🦎', '🐸', '🦖', '🦕'] },
    { name: 'Insects & Bugs', emojis: ['🐝', '🐞', '🐛', '🕷️', '🐜', '🦋'] },
    { name: 'Fantasy Creatures', emojis: ['🐉', '🦄', '🧜', '🧚', '🧙', '👻'] },
    { name: 'Fruits', emojis: ['🍏', '🍊', '🍌', '🍇', '🍓', '🍉'] },
    { name: 'Tropical Fruits', emojis: ['🍍', '🍑', '🥝', '🍒', '🥥', '🍋'] },
    { name: 'Vegetables', emojis: ['🥕', '🥦', '🍆', '🌽', '🧄', '🍅'] },
    { name: 'Desserts & Sweets', emojis: ['🍰', '🎂', '🍭', '🍫', '🧁', '🍪'] },
    { name: 'Fast Food & Snacks', emojis: ['🍕', '🍔', '🍟', '🌮', '🥙', '🥨'] },
    { name: 'Drinks & Beverages', emojis: ['☕', '🍹', '🥛', '🧃', '🍺', '🍷'] },
    { name: 'Musical Instruments', emojis: ['🎸', '🎹', '🥁', '🪕', '🎷', '🎤'] },
    { name: 'Sports Equipment', emojis: ['⚽', '🏈', '🎾', '🥎', '🏀', '🥊'] },
    { name: 'Land Vehicles', emojis: ['🚗', '🚌', '🚚', '🚜', '🏍️', '🚲'] },
    { name: 'Air & Sea Vehicles', emojis: ['✈️', '🚁', '🚀', '🚢', '⛵', '🛸'] },
    { name: 'Weather & Sky', emojis: ['☀️', '🌧️', '⚡', '❄️', '🌈', '🌪️'] },
    { name: 'Space & Celestial', emojis: ['🪐', '🌍', '🌙', '⭐', '☄️', '🌕'] },
    { name: 'Tools & Hardware', emojis: ['🔨', '⚙️', '🧰', '🔧', '🧲', '📏'] },
    { name: 'Electronics & Gadgets', emojis: ['🤖', '💻', '⌚', '🕹️', '🔋', '💡'] },
    { name: 'Card & Game Pieces', emojis: ['🎲', '♟️', '🧩', '🎳', '🎯', '🎰'] },
    { name: 'Seasonal & Holiday', emojis: ['🎄', '🧨', '🎁', '🎊', '🥚', '🕯️'] },
  ];

  const STARTING_LIVES = 3;
  const LEVEL_SECONDS = 60;
  const BONUS_SECONDS = 30;
  const LIFE_EXTENSION_SECONDS = 60;
  const SWIPE_THRESHOLD_PX = 18; // pointer movement below this is treated as a tap, not a swipe
  const HINT_IDLE_MS = 5000; // no successful move for this long -> highlight all available moves
  const HEARTBEAT_INTERVAL_MS = 20000; // proves liveness to the Phase 8 forfeit-detection sweep

  // Phase 1's registered AdMob Rewarded ad unit (docs/ARCHITECTURE.md
  // Section 12) — usable for development as-is; Phase 12 swaps to a
  // separate production unit ID, not this constant, when that phase lands.
  const ADMOB_REWARDED_AD_UNIT_ID = 'ca-app-pub-6922359485200410/1441491988';

  let a = null; // current attempt state
  let selectedCell = null; // [r,c] or null — used by the tap-tap flow only
  let tickHandle = null;
  let toastHideHandle = null;
  let pendingNext = null; // function to call from the level-complete screen's continue button
  let hintTimeoutHandle = null;
  let hintedCells = []; // "r,c" keys currently glowing — re-applied by renderBoard() on every re-render
  let heartbeatHandle = null;

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

  // Calls the Phase 6 start-attempt Edge Function, which assigns this
  // player's daily serving order (on their first call of the day), works
  // out which of the day's 12 shared game definitions this attempt is, and
  // returns its 26 pre-generated slots plus a fresh attempts row id.
  async function startAttempt() {
    window.showScreen('screen-loading');
    let result;
    try {
      const { data, error } = await window.db.functions.invoke('start-attempt', { body: {} });
      if (error) throw error;
      result = data;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('start-attempt failed:', err);
      await window.showAlert("Couldn't start a new game — check your connection and try again.", 'error');
      window.showScreen('screen-home');
      return;
    }

    // Index by slot_index for O(1) lookup during play.
    const slots = new Array(SLOT_LETTERS.length);
    result.slots.forEach((s) => {
      slots[s.slotIndex] = s;
    });

    a = {
      attemptId: result.attemptId,
      gameDefinitionId: result.gameDefinitionId,
      slots, // slots[slotIndex] = { slotIndex, themeIndex, boardPattern }
      slotIndex: 0,
      levelsReached: 0,
      totalScore: 0,
      timeBonusMicros: 0,
      livesUsedInRun: 0, // shared across the WHOLE attempt, never reset per level
      adLivesUsedInRun: 0, // count of ad-lives actually used, across the whole attempt
      recentThemeIds: [], // last 3 *slot* themes completed, for bonus mixing
      payloadLevels: [], // Phase 5 submission payload — one record per finished/failed level, see pushLevelRecord()
      serverResult: null, // filled in once submitAttempt()'s Edge Function call resolves
      submitting: false, // guards against overlapping submitAttempt() calls (auto-retry + a manual Retry tap)
      submitAttempts: 0, // how many submitAttempt() calls have been made for this attempt so far
    };
    selectedCell = null;
    startHeartbeat();
    prepareLevel({ bonus: false });
  }

  function prepareLevel(opts) {
    a.isBonusLevel = !!opts.bonus;
    a.adLifeUsedThisLevel = false;

    if (a.isBonusLevel) {
      const pickRng = GameEngine.makeRng(`${a.gameDefinitionId}:bonus:${a.slotIndex}:pick`);
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
      const themeId = a.slots[a.slotIndex].themeIndex;
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
    if (a.isBonusLevel) {
      // Bonus boards aren't pre-stored (Phase 2 schema has no slot for
      // them) — derived on the fly, seeded off the shared gameDefinitionId
      // rather than a per-player seed, so every player who reaches this
      // bonus point in the same daily game still sees the identical board.
      // See docs/DECISIONS.md's 2026-09-14 Phase 6 entry for the tradeoff.
      const boardRng = GameEngine.makeRng(`${a.gameDefinitionId}:bonus:${a.slotIndex}:board`);
      a.rng = boardRng;
      a.board = GameEngine.generatePlayableBoard(boardRng);
    } else {
      // The 26 regular slots ARE pre-stored (start-attempt handed them over
      // already) — no generation here, just a defensive copy so this
      // level's play can't mutate the shared a.slots data. Cascades/refills
      // still need their own fresh rng stream, seeded distinctly from the
      // key that produced the (already-fixed) starting layout.
      a.rng = GameEngine.makeRng(`${a.gameDefinitionId}:slot:${a.slotIndex}:refill`);
      a.board = a.slots[a.slotIndex].boardPattern.map((row) => row.slice());
    }
    a.movesMade = 0;
    a.levelScore = 0; // scratch total for this level only — committed to a.totalScore on completion
    a.locked = false;
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): separate from a.locked
    // (which is also true during the ad-life prompt) — a.animating is true
    // ONLY during the 420ms move-resolution window in attemptSwapAt(),
    // narrowly scoped so tick() can tell "a move is resolving" apart from
    // "the board is locked for some other reason." a.pendingTimeout is set
    // when the clock hits zero WHILE a.animating is true, so the move that
    // was already in flight gets to finish and be judged on its own merits
    // (did it complete the level?) before the timeout is actually acted on.
    a.animating = false;
    a.pendingTimeout = false;
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
    clearHints();
    scheduleHintTimer();
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

  // ---- Idle hints ----
  // Highlights ONE tile — the one the player should move — after
  // HINT_IDLE_MS with no successful move, and leaves it showing (no
  // re-flicker) until the next successful move, which both clears it and
  // restarts the countdown from zero. An invalid swap attempt does NOT
  // count as a successful move, so it doesn't reset this timer, matching
  // "if there is no successful move" from the request. Only ever scheduled
  // from beginLevel() (fresh level) and from attemptSwapAt()'s success path
  // (a completed move) — see those two call sites.

  function scheduleHintTimer() {
    clearTimeout(hintTimeoutHandle);
    hintTimeoutHandle = setTimeout(showHints, HINT_IDLE_MS);
  }

  function clearHints() {
    clearTimeout(hintTimeoutHandle);
    hintTimeoutHandle = null;
    if (hintedCells.length === 0) return;
    hintedCells.forEach((key) => {
      const [r, c] = key.split(',').map(Number);
      const node = cellEl(r, c);
      if (node) node.classList.remove('hint-glow');
    });
    hintedCells = [];
  }

  function showHints() {
    if (!a || a.locked) return; // mid-animation or mid-prompt — nothing stable to highlight
    const key = GameEngine.findHintCell(a.board);
    hintedCells = key ? [key] : [];
    hintedCells.forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      const node = cellEl(r, c);
      if (node) node.classList.add('hint-glow');
    });
  }

  // ---- Heartbeat (Phase 8 forfeit detection) ----
  // Proves this attempt is still actually being played, server-side. Never
  // reports score/status — attempt-heartbeat only bumps a timestamp. See
  // that function and forfeit-stale-attempts/index.ts (the scheduled sweep
  // that actually marks a stale attempt forfeited) for the full mechanism.

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatHandle = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }

  async function sendHeartbeat() {
    if (!a || !a.attemptId) return;
    try {
      const { data, error } = await window.db.functions.invoke('attempt-heartbeat', { body: { attemptId: a.attemptId } });
      if (error) throw error;
      if (data && data.forfeited) {
        // The server-side sweep already gave up on this attempt before this
        // heartbeat arrived (e.g. the app was backgrounded well past the
        // timeout) — stop treating it as live rather than letting the
        // player keep playing a run that can never be scored.
        stopHeartbeat();
        stopTicking();
        clearHints();
        await window.showAlert('This attempt timed out from inactivity and was forfeited.', 'warning');
        // FIXED 2026-09-16: same stale-badge bug as summary-home-btn in
        // app.js — this path also leaves screen-game without ever
        // re-fetching the Home attempts-left count.
        if (window.refreshAttemptsLeftToday) window.refreshAttemptsLeftToday();
        window.showScreen('screen-home');
      }
    } catch (err) {
      // Best-effort — a single missed heartbeat from a flaky connection
      // isn't itself fatal; the server's timeout window has generous margin
      // for exactly this. Just log and let the next interval try again.
      // eslint-disable-next-line no-console
      console.error('attempt-heartbeat failed:', err);
    }
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
      // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): a move accepted in
      // the last ~420ms before expiry was previously judged AFTER
      // handleTimeout() had already fired — burning a life (and, worse,
      // banking that life's full fresh 60s segment as time bonus) for a
      // move that may have legitimately cleared the level. Now: if a move
      // is still resolving, defer — attemptSwapAt()'s own callback decides
      // what actually happened once the move is done, not this tick.
      if (a.animating) {
        a.pendingTimeout = true;
        return;
      }
      handleTimeout();
    }
  }

  // ---- Timeout / life handling ----

  function handleTimeout() {
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): see failAttempt().
    if (a.status === 'completed') return;
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

  // ---- Phase 10: real AdMob rewarded-video flow ----
  //
  // Requests and shows a rewarded ad for the given `type` ('life' or
  // 'bonus'), tagging the request with ssv.customData =
  // `${attemptId}:${slotIndex}:${type}` and ssv.userId = the signed-in
  // player's id, so Google's AdMob servers include both in the signed
  // server-side-verification callback admob-ssv/index.ts receives directly
  // — see that function's header comment. Resolves with the reward info
  // once the player actually earns the reward; rejects on any failure
  // (not native, no ad available, load failure, or the player closing the
  // ad before finishing it).
  //
  // IMPORTANT, confirmed by reading the plugin's own native Android source
  // (com.getcapacitor.community.admob's RewardedAdCallbackAndListeners.kt)
  // before writing this: showRewardVideoAd()'s own promise ONLY ever
  // settles by resolving, exactly once the reward is earned — it does NOT
  // reject if the player closes the ad early without finishing it. Left as
  // just `await AdMob.showRewardVideoAd()`, a player backing out of an ad
  // would leave this function (and the caller's UI) hung forever. The
  // Dismissed listener below is what actually catches that case — it's not
  // just cleanup, it's load-bearing.
  async function playRewardedAd(type) {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
      throw new Error('Ads are only available in the installed app.');
    }
    const AdMob = window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob;
    if (!AdMob) throw new Error('AdMob plugin not available.');

    const {
      data: { user },
    } = await window.db.auth.getUser();
    if (!user) throw new Error('Not signed in.');

    const customData = `${a.attemptId}:${a.slotIndex}:${type}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let dismissHandle = null;
      let failHandle = null;

      const cleanup = () => {
        if (dismissHandle) dismissHandle.remove();
        if (failHandle) failHandle.remove();
      };
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String((err && err.message) || err || 'Ad failed.')));
      };
      const settleResolve = (reward) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(reward);
      };

      Promise.all([
        AdMob.addListener('onRewardedVideoAdDismissed', () => settleReject(new Error('Ad closed before finishing.'))),
        AdMob.addListener('onRewardedVideoAdFailedToShow', (err) => settleReject(err)),
      ])
        .then(([dHandle, fHandle]) => {
          dismissHandle = dHandle;
          failHandle = fHandle;
        })
        .catch(() => {
          /* listener registration itself failing shouldn't block the ad attempt below */
        });

      AdMob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_AD_UNIT_ID, ssv: { userId: user.id, customData } })
        .then(() => AdMob.showRewardVideoAd())
        .then((reward) => settleResolve(reward))
        .catch((err) => settleReject(err));
    });
  }

  // Turns a playRewardedAd() rejection into text a mobile-only player can
  // actually read and report back — there's no way to check this device's
  // console/Logcat output without a terminal, so whatever the native AdMob
  // SDK says needs to reach the screen directly rather than only going to
  // console.error().
  //
  // "No ad available" (AdMob has nothing to serve — most commonly "No
  // fill." or "Publisher data not found." on a new/low-traffic ad unit,
  // not a code bug) gets its own honest, context-specific copy instead of
  // a generic "ad failed" — context is 'life' or 'bonus', since what
  // happens next differs (declining a life ends the attempt; declining a
  // bonus just continues to the next regular level). The underlying
  // decision — decline, same as any other ad failure — does NOT change
  // based on this distinction: granting the life/bonus for free on a
  // claimed no-fill would let a modified client always claim "no ad
  // available" to get free, unverified rewards, exactly the client-
  // trusted-flag hole score-replay's ad_verifications check (Phase 10)
  // exists to close. Wording is the only thing this improves.
  const NO_AD_AVAILABLE_PATTERNS = [/no fill/i, /publisher data not found/i, /ad request expired/i, /no.?ad.?to.?show/i];

  function describeAdError(err, context) {
    const msg = (err && err.message) || String(err || '');
    if (msg === 'Ad closed before finishing.') {
      return 'Ad was closed before it finished — try again.';
    }
    if (NO_AD_AVAILABLE_PATTERNS.some((re) => re.test(msg))) {
      // 'bonus' deliberately has no trailing clause here — acceptBonus()'s
      // catch appends "Bonus round skipped this time." itself for every
      // failure reason, not just this one, so adding it here too would
      // duplicate it for this specific case.
      return context === 'bonus' ? 'No ad available right now.' : 'No ad available right now — this attempt ends here.';
    }
    if (msg) {
      return `Ad failed: ${msg}`;
    }
    return 'Ad failed to load or play.';
  }

  function offerAdLife() {
    // Blocks play until the player picks an option below — without this,
    // the board (still on screen-game underneath this prompt) stayed fully
    // tappable, letting moves/score keep changing while "out of lives" was
    // showing. See docs/DECISIONS.md's 2026-09-14 "offerAdLife lock" entry.
    a.locked = true;

    const box = el('game-message');
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Out of lives for this attempt. Watch an ad for +${LIFE_EXTENSION_SECONDS}s on this level, or give up?`;
    box.appendChild(p);

    const adBtn = document.createElement('button');
    adBtn.className = 'secondary';
    adBtn.textContent = 'Watch ad for extra time';

    const errorLine = document.createElement('p');
    errorLine.className = 'muted';
    errorLine.style.display = 'none';

    adBtn.addEventListener('click', async () => {
      adBtn.disabled = true;
      adBtn.textContent = 'Loading ad…';
      errorLine.style.display = 'none';
      try {
        await playRewardedAd('life');
        // The reward itself is a UX signal only — score-replay
        // independently requires admob-ssv to have recorded a verified
        // completion for this exact attempt+slot+type before it will
        // credit the level; see docs/ARCHITECTURE.md Section 5.
        a.adLifeUsedThisLevel = true;
        a.adLivesUsedInRun++;
        a.levelElapsedBaseMs += a.currentSegmentMs;
        a.currentSegmentMs = LIFE_EXTENSION_SECONDS * 1000;
        setMessage('');
        showToast(`🎬 Ad watched — +${LIFE_EXTENSION_SECONDS}s`);
        renderHud();
        a.locked = false; // re-enable play now that the prompt is resolved
        extendTimer(LIFE_EXTENSION_SECONDS);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Rewarded ad (life) failed:', err);
        adBtn.disabled = false;
        adBtn.textContent = 'Watch ad for extra time';
        // Surfaced on-screen, not just console.error — there's no way to
        // check device logs without a terminal, so the actual native
        // AdMob error text (e.g. "No fill.", the most common cause on a
        // new/sideloaded ad unit) needs to reach the player directly.
        errorLine.textContent = describeAdError(err, 'life');
        errorLine.style.display = '';
        // a.locked stays true — the board underneath stays non-interactive
        // until the player picks an option, same as the original lock.
      }
    });

    const giveUpBtn = document.createElement('button');
    giveUpBtn.className = 'danger';
    giveUpBtn.textContent = 'Give up';
    giveUpBtn.addEventListener('click', () => failAttempt());

    box.appendChild(adBtn);
    box.appendChild(giveUpBtn);
    box.appendChild(errorLine);
  }

  // Ends the whole attempt immediately — not just the current level. The
  // level in progress still contributes whatever score was earned before
  // running out of lives (matches the score the HUD was already showing),
  // but not levelsReached or time bonus — the level itself was never
  // cleared. See docs/DECISIONS.md's 2026-09-15 entry; this replaces the
  // prior "incomplete level scores 0" rule from ARCHITECTURE.md Section 3.3.
  function failAttempt() {
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): defense-in-depth on top
    // of the animating/pendingTimeout fix above — if anything ever still
    // manages to call this after the attempt is already done, it's a no-op
    // rather than a second 'failed' record and a second submitAttempt().
    if (a.status === 'completed') return;
    stopTicking();
    clearHints();
    a.totalScore += a.levelScore; // last-shown score is preserved, not dropped
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

  // Submits {attemptId, gameDefinitionId, levels} to the score-replay Edge
  // Function (Phase 5/6), which fetches the day's stored board data for
  // gameDefinitionId directly from the database (never trusting anything
  // about the board from the client), replays each level's moves through
  // the same match/cascade/scoring rules as GameEngine, and returns the
  // authoritative score/time bonus/lives used/levels reached — also
  // updating the attemptId row with the final result. The client-computed
  // a.totalScore shown up to this point is never trusted as-is — only the
  // server's response is.
  //
  // FIXED 2026-09-16: a single failed network call here used to be
  // unrecoverable data loss for a fully-played attempt. The old code set
  // serverResult to a terminal "not validated" error with no retry path,
  // AND finishAttempt()/failAttempt() had already called stopHeartbeat()
  // before this ever ran — so the attempts row sat at status: 'in_progress'
  // with a frozen last_heartbeat_at, and forfeit-stale-attempts (the 5-min
  // scheduled sweep, server/functions/forfeit-stale-attempts/index.ts)
  // would eventually flip it to 'forfeited'/score 0, discarding a
  // completely legitimate playthrough. Two changes fix this together:
  //   1. The heartbeat is no longer stopped until submitAttempt() actually
  //      succeeds (see the two call sites above) — score-replay itself only
  //      refuses an attempt whose status is already 'completed' (see its
  //      own comment), not 'forfeited', so as long as last_heartbeat_at
  //      keeps getting bumped the row never goes stale in the first place
  //      and the sweep never touches it, however long submission takes.
  //   2. This function now retries itself automatically a few times with
  //      backoff before giving up, and exposes retrySubmitAttempt() for a
  //      manual "Retry" button (renderSummary()) so the player can try
  //      again themselves once they're back on a connection, at any point
  //      after that.
  const SUBMIT_RETRY_DELAYS_MS = [2000, 5000, 12000]; // 3 automatic retries after the first attempt

  async function submitAttempt() {
    if (a.submitting) return; // a retry is already in flight — don't overlap it
    a.submitting = true;
    a.submitAttempts++;
    const myAttemptId = a.attemptId; // guards against a stale timer firing after startAttempt() replaces `a`

    try {
      const { data, error } = await window.db.functions.invoke('score-replay', {
        body: { attemptId: a.attemptId, gameDefinitionId: a.gameDefinitionId, levels: a.payloadLevels },
      });
      if (error) throw error;
      if (a.attemptId !== myAttemptId) return; // superseded — a new attempt started while this was in flight
      a.serverResult = data;
      a.submitting = false;
      stopHeartbeat(); // only now — submission is confirmed persisted server-side
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Score-replay submission failed (try ${a.submitAttempts}):`, err);
      if (a.attemptId !== myAttemptId) return;
      a.submitting = false;

      // A retry can legitimately land after an earlier try actually
      // succeeded server-side but its response never made it back (e.g. the
      // connection dropped right after the server wrote the row). score-
      // replay reports that as a 409 "already submitted" — good news, not a
      // failure — so it's worth unwrapping the structured body rather than
      // treating it like every other network error and retrying forever.
      let structured = null;
      if (err && err.context && typeof err.context.json === 'function') {
        try { structured = await err.context.json(); } catch { /* not JSON — a genuine network failure, fall through */ }
      }
      if (structured && typeof structured.error === 'string' && /already been submitted/i.test(structured.error)) {
        a.serverResult = { valid: false, error: 'Already saved on the server — check History for your final score.', alreadySaved: true };
        stopHeartbeat(); // the row is genuinely completed server-side now, safe to stop
        if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) renderSummary();
        return;
      }

      const retryIndex = a.submitAttempts - 1; // 0-based into SUBMIT_RETRY_DELAYS_MS
      if (retryIndex < SUBMIT_RETRY_DELAYS_MS.length) {
        a.serverResult = { valid: false, error: 'Could not reach the server — retrying…', retrying: true };
        renderSummary();
        setTimeout(() => {
          if (a.attemptId === myAttemptId) submitAttempt();
        }, SUBMIT_RETRY_DELAYS_MS[retryIndex]);
        return;
      }
      // Automatic retries exhausted — hand it to the player. The heartbeat
      // is still running (see above), so nothing is lost by waiting; tapping
      // Retry calls this same function again with no extra limit.
      a.serverResult = {
        valid: false,
        error: 'Could not reach the server. Your result is safe — tap Retry once you\'re back online.',
      };
    }
    // Only re-render if the summary screen is still what's showing — a fast
    // player could in principle already be elsewhere, though nothing in the
    // current flow lets them navigate away from it.
    if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) {
      renderSummary();
    }
  }

  // Manual retry, wired to summary-retry-btn (app.js). Just re-runs
  // submitAttempt() — the guard/backoff logic above is all shared.
  function retrySubmitAttempt() {
    if (!a || a.submitting) return;
    submitAttempt();
  }

  // ---- Level completion ----

  function finishRegularLevel() {
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): see failAttempt()'s
    // matching comment — this is the specific path the report's race
    // scenario #2 hit (a move landing after failAttempt() had already run).
    if (a.status === 'completed') return;
    stopTicking();
    clearHints();
    const leftoverMs = msRemaining();
    const bankedThisLevel = bankedMicros(leftoverMs);
    a.timeBonusMicros += bankedThisLevel;
    a.totalScore += a.levelScore;
    a.levelsReached++;
    pushLevelRecord('completed'); // before slotIndex++ — record belongs to the slot just finished

    const themeId = a.slots[a.slotIndex].themeIndex;
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
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): see failAttempt().
    if (a.status === 'completed') return;
    clearHints();
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
    // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): see failAttempt().
    if (a.status === 'completed') return;
    stopTicking();
    clearHints();
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
    const btn = el('bonus-play-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.defaultLabel || btn.textContent;
    }
    window.showScreen('screen-bonus-prompt');
  }

  async function acceptBonus() {
    const btn = el('bonus-play-btn');
    if (btn) {
      if (!btn.dataset.defaultLabel) btn.dataset.defaultLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Loading ad…';
    }
    try {
      // The reward itself is a UX signal only — score-replay independently
      // requires admob-ssv to have recorded a verified completion for this
      // exact attempt+slot+type before it will credit the bonus level; see
      // docs/ARCHITECTURE.md Section 5.
      await playRewardedAd('bonus');
      prepareLevel({ bonus: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Rewarded ad (bonus) failed:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.defaultLabel;
      }
      await window.showAlert(`${describeAdError(err, 'bonus')} Bonus round skipped this time.`, 'error');
      prepareLevel({ bonus: false });
    }
  }

  function skipBonus() {
    prepareLevel({ bonus: false });
  }

  // ---- Reveal screen ----
  // No skip option here for a bonus round, deliberately: the one legitimate
  // point to decline a bonus round is showBonusPrompt()'s pre-ad "Skip"
  // button, before any ad is requested. Once acceptBonus() has actually
  // watched the ad through to completion, the player is committed — there
  // used to be a second "Skip bonus round" link on this reveal screen too,
  // letting the ad be watched and then the round declined anyway with
  // nothing to show for it; removed on request.

  function confirmReveal() {
    beginLevel();
  }

  // ---- Input: tap-tap AND swipe both work ----

  function cellEl(r, c) {
    return document.querySelector(`.game-cell[data-r="${r}"][data-c="${c}"]`);
  }

  function onPointerDown(r, c, e) {
    if (a.locked) return;
    // Multi-touch guard: only ever track ONE gesture at a time. Without
    // this, a second finger touching down before the first lifts silently
    // overwrote a.dragStart below, so the eventual pointerup — from
    // WHICHEVER finger happened to lift first — computed its swipe vector
    // from one finger's start point and a different finger's release
    // point. That's a garbage vector, but a dense 8x8/6-symbol board (see
    // docs/DECISIONS.md) still resolves a lot of garbage vectors into a
    // valid adjacent swap, which is exactly what looked like "blind
    // swiping anywhere clears levels" — confirmed against a real screen
    // recording, not assumed. Extra fingers are now ignored outright: the
    // gesture already in progress owns input until it ends.
    if (a.dragStart && a.dragStart.pointerId !== e.pointerId) return;
    a.dragStart = { r, c, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  }

  // Registered once on the document, not per-cell — a swipe released
  // outside any cell (e.g. dragged off the board edge) would otherwise
  // never fire and leave a.dragStart stale, corrupting the next touch.
  document.addEventListener('pointerup', (e) => {
    if (!a || a.locked || !a.dragStart) return;
    if (e.pointerId !== a.dragStart.pointerId) return; // not the finger that started this gesture — ignore
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

  // A gesture can end without ever firing pointerup — Android delivers
  // pointercancel instead if e.g. a system gesture (notification shade,
  // back-swipe) takes over mid-touch. Without handling this, a.dragStart
  // would stay stuck holding that pointerId forever, permanently locking
  // out all future input (every new finger would fail the ownership check
  // above and be silently ignored) until the level ends and a.dragStart is
  // reset elsewhere.
  document.addEventListener('pointercancel', (e) => {
    if (a && a.dragStart && a.dragStart.pointerId === e.pointerId) {
      a.dragStart = null;
    }
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
    a.animating = true; // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11) — see tick()
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
      a.animating = false;
      clearHints();
      scheduleHintTimer();

      // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): a move that lands
      // right at expiry is judged on its own result FIRST — if it actually
      // completed the level, that's what happened, full stop, regardless
      // of whether the clock also hit zero during its 420ms resolution.
      // Only if it did NOT complete the level does a deferred timeout (or
      // one that expires exactly now) actually get acted on.
      if (!a.isBonusLevel && a.movesMade >= a.levelMovesTarget) {
        finishRegularLevel();
      } else if (a.pendingTimeout || msRemaining() <= 0) {
        a.pendingTimeout = false;
        handleTimeout();
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
    }, 5000);
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
  }

  function renderBoard() {
    const boardEl = el('game-board');
    boardEl.innerHTML = '';
    const hintedSet = new Set(hintedCells);
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
        if (hintedSet.has(`${r},${c}`)) {
          cell.classList.add('hint-glow');
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
    const retryBtn = el('summary-retry-btn');
    if (!r) {
      // Submission still in flight — client-computed figures shown as a
      // provisional preview only, explicitly labeled as such.
      el('summary-score').textContent = `${Math.round(a.totalScore).toLocaleString()}`;
      el('summary-time-bonus').textContent = `${formatTimeBonus(a.timeBonusMicros)} (mm:ss:ms:µs, provisional)`;
      el('summary-lives').textContent = `${livesStatusText()} (provisional)`;
      el('summary-levels').textContent = `${a.levelsReached} (provisional)`;
      el('summary-status-message').textContent = 'Score is being saved, please wait...';
      if (retryBtn) retryBtn.classList.add('hidden');
      return;
    }
    if (!r.valid) {
      el('summary-score').textContent = '—';
      el('summary-time-bonus').textContent = '—';
      el('summary-lives').textContent = '—';
      el('summary-levels').textContent = '—';
      el('summary-status-message').textContent = `Not validated — ${r.error || 'unknown error'}`;
      // No Retry button while an automatic retry is already scheduled, or
      // once the server's confirmed the row is already saved (retrying
      // that case would only ever hit the same 409 again).
      if (retryBtn) retryBtn.classList.toggle('hidden', !!r.retrying || !!r.alreadySaved);
      return;
    }
    // Server-authoritative figures — this is what actually counts once
    // Phase 6/7 wire attempts into persistence and the leaderboard.
    el('summary-score').textContent = `${Math.round(r.score).toLocaleString()}`;
    el('summary-time-bonus').textContent = `${formatTimeBonus(r.timeBonusMicros)} (mm:ss:ms:µs)`;
    el('summary-lives').textContent =
      `${r.livesUsed}/${STARTING_LIVES} regular` + (r.adLivesUsed > 0 ? ` + ${r.adLivesUsed} ad-life${r.adLivesUsed === 1 ? '' : 's'}` : '');
    el('summary-levels').textContent = `${r.levelsReached}`;
    el('summary-status-message').textContent = 'Score successfully saved in Game server';
    if (retryBtn) retryBtn.classList.add('hidden');
  }

  return {
    startAttempt,
    confirmReveal,
    acceptBonus,
    skipBonus,
    continueAfterLevelComplete,
    retrySubmitAttempt,
  };
})();

window.Attempt = Attempt;
