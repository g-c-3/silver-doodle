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

  // Client-side in-progress-attempt persistence (see docs/ROADMAP.md's
  // "Newly found gap, 2026-09-14" item and docs/DECISIONS.md's entry for
  // this feature). Bumping this invalidates any snapshot saved by an older
  // build (e.g. one with different THEMES/SLOT_MOVE_TARGETS) rather than
  // risking a corrupt resume.
  const RESUME_STORAGE_KEY = 'mese_inprogress_attempt_v1';
  const RESUME_VERSION = 1;

  // COMPLIANCE FIX (2026-09-19, §5.14, report-2.3): this constant used to
  // be the real, live production ad unit ID, hardcoded with no test-mode
  // distinction — meaning every sideloaded dev/test build (which is EVERY
  // build produced so far; see docs/ROADMAP.md, Play Store submission is
  // still a later phase) was generating real impressions/clicks against a
  // live AdMob unit outside AdMob's own traffic-quality expectations for
  // dev testing, which risks the account being flagged for invalid
  // traffic. Default was briefly Google's own official sample
  // rewarded-video test unit ID, but that unit isn't a real ad unit under
  // this project's AdMob account — there's no AdMob console page for it,
  // so a custom SSV callback URL can never be configured on it. Every
  // ad-life/bonus attempt on a build using it would correctly play a test
  // ad client-side, then permanently fail server-side validation, since
  // admob-ssv would never be invoked at all (confirmed live, 2026-09-21 —
  // zero admob-ssv invocations across a full attempt, ruling out a
  // key-rotation or server bug). Fixed 2026-09-22: default is now a
  // second, dedicated Rewarded ad unit created under this project's own
  // AdMob account specifically for this — real enough to carry its own
  // SSV config (pointed at the same admob-ssv endpoint as production),
  // but entirely separate from the live "Rewarded - Ad Life / Bonus" unit,
  // so dev/sideload testing never touches production ad traffic or
  // revenue. The real production unit ID is injected over this
  // placeholder only by an explicit, opt-in CI step (see
  // .github/workflows/build-apk.yml's "Inject production AdMob unit ID"
  // step) gated behind a workflow_dispatch input that defaults to false —
  // every normal push-triggered build, which is still all of them today,
  // keeps using this dev/test ID automatically with no action needed.
  const ADMOB_REWARDED_AD_UNIT_ID = 'ca-app-pub-6922359485200410/4016179270';

  let a = null; // current attempt state
  let selectedCell = null; // [r,c] or null — used by the tap-tap flow only
  let tickHandle = null;
  let toastHideHandle = null;
  let pendingNext = null; // function to call from the level-complete screen's continue button
  let hintTimeoutHandle = null;
  let hintedCells = []; // "r,c" keys currently glowing — re-applied by renderBoard() on every re-render
  let heartbeatHandle = null;
  let currentUserId = null; // set by startAttempt()/tryResume() — scopes the resume snapshot to its owner

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
    // Scopes the resume snapshot (see persistAttempt() below) to whoever's
    // actually playing — same reasoning as clearPersisted()'s sign-out call.
    const {
      data: { user },
    } = await window.db.auth.getUser();
    currentUserId = user ? user.id : null;
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
    a.isFreebieBonus = !!opts.freebie; // practice-only bonus round — see acceptFreebieBonus()
    a.adLifeUsedThisLevel = false;
    a.freebieUsedThisLevel = false;

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
    // startTimer() BEFORE renderHud(): renderHud() now also persists a
    // resume snapshot (see persistAttempt()), which reads a.tickTarget —
    // must be this level's fresh deadline, not whatever was left over from
    // the level that just finished. See docs/DECISIONS.md, 2026-09-22.
    startTimer(a.levelSeconds);
    renderHud();
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

  // ---- Client-side resume ----
  // Mobile browsers reload a backgrounded tab routinely when memory is
  // reclaimed — without this, that reload dropped the player straight back
  // to Home with zero memory of the attempt, leaving its `attempts` row
  // stuck at status: 'in_progress' until the Phase 8 forfeit sweep (which
  // already existed and still runs regardless) eventually gave up on it.
  // This only rebuilds the CLIENT's view of an attempt already known-good
  // server-side — it changes nothing about what score-replay trusts or how
  // an attempt is scored.
  //
  // The board and the seeded rng's internal state are never stored
  // directly — the rng is a closure, not a plain value, and re-deriving
  // both from {gameDefinitionId, slotIndex, currentLevelMoves} via the same
  // trySwap() the live game already uses is simpler and can't silently
  // drift from it. See resumeAttempt() below.

  function persistAttempt() {
    if (!a || a.status === 'completed') return;
    try {
      // 2026-09-22 fix: beginLevel()/handleTimeout()/offerAdLife() were
      // reordered to call startTimer()/extendTimer() before renderHud(),
      // specifically so a.tickTarget is always this segment's real deadline
      // by the time this runs — a real device test caught the bug where
      // renderHud() ran first and persisted the *previous* segment's
      // stale-or-expired deadline instead. This check is now a defensive
      // fallback only (e.g. a future call site that violates that
      // ordering), not the primary safeguard.
      const remainingMs =
        typeof a.tickTarget === 'number' && !Number.isNaN(a.tickTarget) ? msRemaining() : a.currentSegmentMs;
      const snapshot = {
        version: RESUME_VERSION,
        userId: currentUserId,
        attemptId: a.attemptId,
        gameDefinitionId: a.gameDefinitionId,
        slots: a.slots,
        slotIndex: a.slotIndex,
        levelsReached: a.levelsReached,
        totalScore: a.totalScore,
        timeBonusMicros: a.timeBonusMicros,
        livesUsedInRun: a.livesUsedInRun,
        adLivesUsedInRun: a.adLivesUsedInRun,
        recentThemeIds: a.recentThemeIds,
        payloadLevels: a.payloadLevels,
        isBonusLevel: a.isBonusLevel,
        isFreebieBonus: a.isFreebieBonus,
        adLifeUsedThisLevel: a.adLifeUsedThisLevel,
        freebieUsedThisLevel: a.freebieUsedThisLevel,
        currentLevelMoves: a.currentLevelMoves,
        levelElapsedBaseMs: a.levelElapsedBaseMs,
        currentSegmentMs: a.currentSegmentMs,
        livesUsedAtLevelStart: a.livesUsedAtLevelStart,
        deadlineEpochMs: Date.now() + remainingMs,
      };
      window.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      // Private browsing, a full quota, or storage disabled entirely —
      // resume is a nice-to-have; never worth disrupting live play over.
      // eslint-disable-next-line no-console
      console.error('persistAttempt failed (non-fatal):', err);
    }
  }

  // Exposed as Attempt.clearPersisted() too — app.js calls it on sign-out
  // and account deletion so a shared device never silently offers to
  // resume the previous player's board under the next player's session.
  function clearPersistedAttempt() {
    try {
      window.localStorage.removeItem(RESUME_STORAGE_KEY);
    } catch (err) {
      /* nothing to clean up if storage isn't available at all */
    }
  }

  function loadPersistedAttempt() {
    try {
      const raw = window.localStorage.getItem(RESUME_STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved.version !== RESUME_VERSION) return null;
      return saved;
    } catch (err) {
      return null;
    }
  }

  // Called once at boot (app.js's routeAfterAuth()) after the signed-in
  // user is known. Returns true if it resumed play (screen-game is now
  // showing); false means there was nothing to resume, it belonged to a
  // different user, or it no longer checked out — the caller falls back to
  // its normal Home routing in every false case.
  async function tryResume(userId) {
    const saved = loadPersistedAttempt();
    if (!saved || saved.userId !== userId) return false;

    // Confirm the attempt is still alive server-side before spending any
    // effort reconstructing it locally — forfeit-stale-attempts (Phase 8)
    // may already have given up on it while the tab was gone, and a stale
    // local snapshot should never override that. Deliberately just as
    // strict on a genuine network failure here as on a confirmed forfeit —
    // resuming is only ever a convenience, and the attempt's real state
    // still lives safely on the server either way, governed by the same
    // heartbeat/forfeit mechanism as if this tab had simply stayed open.
    let heartbeatOk = false;
    try {
      const { data, error } = await window.db.functions.invoke('attempt-heartbeat', {
        body: { attemptId: saved.attemptId },
      });
      if (error) throw error;
      heartbeatOk = !(data && data.forfeited);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Resume heartbeat check failed:', err);
      heartbeatOk = false;
    }
    if (!heartbeatOk) {
      clearPersistedAttempt();
      return false;
    }

    try {
      resumeAttempt(saved);
      return true;
    } catch (err) {
      // A corrupted snapshot, or one saved by a build with different
      // THEMES/SLOT_MOVE_TARGETS, must never crash the app on boot —
      // discard it and let the player start fresh from Home instead.
      // eslint-disable-next-line no-console
      console.error('Resume reconstruction failed, discarding saved attempt:', err);
      clearPersistedAttempt();
      a = null;
      return false;
    }
  }

  // Rebuilds `a` and the current level's board directly into mid-play —
  // never through prepareLevel()/beginLevel(), since both would show the
  // reveal screen and/or reset progress already made this level.
  function resumeAttempt(saved) {
    currentUserId = saved.userId;

    a = {
      attemptId: saved.attemptId,
      gameDefinitionId: saved.gameDefinitionId,
      slots: saved.slots,
      slotIndex: saved.slotIndex,
      levelsReached: saved.levelsReached,
      totalScore: saved.totalScore,
      timeBonusMicros: saved.timeBonusMicros,
      livesUsedInRun: saved.livesUsedInRun,
      adLivesUsedInRun: saved.adLivesUsedInRun,
      recentThemeIds: saved.recentThemeIds,
      payloadLevels: saved.payloadLevels,
      serverResult: null,
      submitting: false,
      submitAttempts: 0,
    };
    selectedCell = null;
    a.isBonusLevel = saved.isBonusLevel;
    a.isFreebieBonus = saved.isFreebieBonus;
    a.adLifeUsedThisLevel = saved.adLifeUsedThisLevel;
    a.freebieUsedThisLevel = saved.freebieUsedThisLevel;

    // Re-derives this level's theme/emoji/target metadata exactly the way
    // prepareLevel() would — deterministic from gameDefinitionId/slotIndex/
    // recentThemeIds, so it's safe to recompute rather than store it too.
    if (a.isBonusLevel) {
      const pickRng = GameEngine.makeRng(`${a.gameDefinitionId}:bonus:${a.slotIndex}:pick`);
      a.levelEmojis = a.recentThemeIds.flatMap((id) => shuffle(THEMES[id].emojis, pickRng).slice(0, 2));
      a.levelThemeName = 'Bonus mix';
      a.levelMovesTarget = null;
      a.levelSeconds = BONUS_SECONDS;
      a.levelIcon = '🎁';
      setThemeAccent('var(--gold)');
      a.rng = GameEngine.makeRng(`${a.gameDefinitionId}:bonus:${a.slotIndex}:board`);
      a.board = GameEngine.generatePlayableBoard(a.rng);
    } else {
      const themeId = a.slots[a.slotIndex].themeIndex;
      a.levelEmojis = THEMES[themeId].emojis;
      a.levelThemeName = THEMES[themeId].name;
      a.levelMovesTarget = SLOT_MOVE_TARGETS[a.slotIndex];
      a.levelSeconds = LEVEL_SECONDS;
      a.levelIcon = a.levelEmojis[0];
      setThemeAccent(themeAccentColor(themeId));
      a.rng = GameEngine.makeRng(`${a.gameDefinitionId}:slot:${a.slotIndex}:refill`);
      a.board = a.slots[a.slotIndex].boardPattern.map((row) => row.slice());
    }

    // Replays every move made before the reload through the SAME trySwap()
    // the live game itself uses — deterministically lands on the exact
    // board + rng state play was at, the same trust model score-replay.ts
    // already uses server-side, just run locally.
    a.currentLevelMoves = [];
    a.levelScore = 0;
    (saved.currentLevelMoves || []).forEach(([r1, c1, r2, c2]) => {
      const result = GameEngine.trySwap(a.board, r1, c1, r2, c2, a.rng);
      if (!result.valid) {
        throw new Error('Saved move replayed as invalid — snapshot is inconsistent with the current build.');
      }
      a.board = result.board;
      a.levelScore += result.score;
      a.currentLevelMoves.push([r1, c1, r2, c2]);
    });
    a.movesMade = a.isBonusLevel ? 0 : a.currentLevelMoves.length;

    a.levelElapsedBaseMs = saved.levelElapsedBaseMs;
    a.currentSegmentMs = saved.currentSegmentMs;
    a.livesUsedAtLevelStart = saved.livesUsedAtLevelStart;
    a.locked = false;
    a.animating = false;
    a.pendingTimeout = false;

    // Timer deadline set BEFORE renderHud() (which persists a fresh
    // snapshot as a side effect) so that save reads a real value instead of
    // an undefined a.tickTarget — see persistAttempt()'s own fallback too.
    // The level timer never pauses (startTimer()/tick()), so real time that
    // passed while the tab was gone counts exactly as it would have if the
    // tab had simply stayed open.
    const remainingMs = Math.max(0, saved.deadlineEpochMs - Date.now());
    a.tickTarget = performance.now() + remainingMs;

    setMessage('');
    renderBoard();
    renderHud();

    stopTicking();
    tickHandle = setInterval(tick, 50);
    tick();

    clearHints();
    scheduleHintTimer();
    startHeartbeat();
    window.showScreen('screen-game');
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
    if (a.livesUsedInRun < STARTING_LIVES - 1) {
      // 2026-09-22: only the first (STARTING_LIVES - 1) lives buy another
      // segment now — previously all STARTING_LIVES did, for 4 total free
      // minutes (60s initial + 3x60s). The last life (branch below) no
      // longer does, bringing it down to 3.
      a.livesUsedInRun++;
      // The just-expired segment is fully spent (timeout only fires at
      // remaining<=0) — bank its whole length before starting the next one.
      a.levelElapsedBaseMs += a.currentSegmentMs;
      a.currentSegmentMs = LIFE_EXTENSION_SECONDS * 1000;
      showToast(`💗 Life used (${a.livesUsedInRun}/${STARTING_LIVES}) — +${LIFE_EXTENSION_SECONDS}s`);
      // extendTimer() BEFORE renderHud(): same reasoning as beginLevel()'s
      // reordering above — renderHud() persists a.tickTarget, which must
      // already reflect the extension, not the just-expired deadline that
      // triggered this branch.
      extendTimer(LIFE_EXTENSION_SECONDS);
      renderHud();
      // 2026-09-24 fix: a new segment beginning didn't reschedule the hint
      // timer, same bug as offerAdLife()'s two branches below — see that
      // function's header comment for the full explanation.
      clearHints();
      scheduleHintTimer();
      return;
    }
    if (a.livesUsedInRun < STARTING_LIVES) {
      // The last life: spending it just marks it spent (so the 3rd heart
      // shows fully drained) — it no longer buys another segment, so this
      // falls straight through to the ad-offer check below instead of
      // returning. a.currentSegmentMs is deliberately left untouched here,
      // still holding the just-expired segment's length, uncounted into
      // levelElapsedBaseMs yet — offerAdLife()'s own ad-success handler
      // banks it itself once an ad is actually watched, exactly the same
      // lazy-banking pattern already used for whichever segment triggers
      // the ad offer.
      a.livesUsedInRun++;
      showToast(`💔 Out of lives (${a.livesUsedInRun}/${STARTING_LIVES})`);
      renderHud();
    }
    if (!a.adLifeUsedThisLevel && !a.freebieUsedThisLevel) {
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
  // 2026-09-24: simplified to always show the same plain message
  // regardless of the underlying failure reason — the previous version
  // passed through the raw native AdMob error text (e.g. "Account not
  // approved yet." plus a support.google.com link) for anything that
  // wasn't a recognized no-fill pattern, which read as a confusing,
  // unprofessional wall of text to a player who has no use for the
  // technical reason. The full detail still goes to console.error() below
  // for anyone who needs to debug it. "Closed before finishing" keeps its
  // own distinct message since it's a genuinely different, accurate, and
  // actionable case (the ad loaded fine — the player backed out) rather
  // than an unavailability reason.
  //
  // The underlying decision on an actual ad failure — decline the real ad,
  // same as any other failure reason — does not depend on which message is
  // shown: granting the life/bonus for free on any claimed failure would
  // let a modified client always report "failed" to get free, unverified
  // rewards, exactly the client-trusted-flag hole score-replay's
  // ad_verifications check (Phase 10) exists to close. What actually
  // happens next (the honestly-labeled freebie option, added 2026-09-23)
  // is surfaced by offerAdLife()/acceptBonus() themselves, not baked into
  // this string.
  function describeAdError(err, context) {
    const msg = (err && err.message) || String(err || '');
    if (msg === 'Ad closed before finishing.') {
      return 'Ad was closed before it finished — try again.';
    }
    return 'Ad not available right now.';
  }

  // Whenever this prompt grants more time (a real ad or the freebie), the
  // hint timer needs a fresh schedule for the new segment — a bug found
  // 2026-09-24: a.locked=true (set right below) means any hint timeout
  // still pending from before this prompt appeared silently no-ops when it
  // fires (showHints()'s own a.locked guard), and since showHints() never
  // reschedules itself, that was the LAST hint for the rest of the level —
  // none would ever appear again during the granted extra time, however
  // long the player stayed idle. Both extension branches below now call
  // clearHints()/scheduleHintTimer() explicitly, the same way beginLevel()
  // already does for a brand new level.
  function offerAdLife() {
    // Blocks play until the player picks an option below — without this,
    // the board (still on screen-game underneath this prompt) stayed fully
    // tappable, letting moves/score keep changing while "out of lives" was
    // showing. See docs/DECISIONS.md's 2026-09-14 "offerAdLife lock" entry.
    a.locked = true;
    clearHints(); // no stale glow sitting on a now-locked, non-interactive board

    const box = el('game-message');
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Out of lives for this attempt. Watch an ad for +${LIFE_EXTENSION_SECONDS}s on this level, or give up?`;
    box.appendChild(p);

    // One button doing double duty rather than two separate ones: starts
    // as the ad action; if the ad actually fails, it relabels itself to
    // the honestly-labeled freebie action instead of leaving a second
    // "Watch ad" retry sitting next to it — 2026-09-23, in response to the
    // 2-button version being confusing. actionBtn.dataset.mode tracks
    // which behavior the next click should run.
    const actionBtn = document.createElement('button');
    actionBtn.className = 'secondary';
    actionBtn.textContent = 'Watch ad for extra time';
    actionBtn.dataset.mode = 'ad';

    const errorLine = document.createElement('p');
    errorLine.className = 'muted';
    errorLine.style.display = 'none';

    function grantFreebie() {
      // Grants the same +60s a verified ad would, but is NEVER reported as
      // adLifeUsed in the score-replay payload (an unverified claim there
      // gets the WHOLE attempt rejected, not just this level — see the
      // ad_verifications check in score-replay/index.ts). Instead
      // pushLevelRecord() clamps this level's own elapsedMsAtEnd down to
      // what it could honestly claim without the freebie, so the level's
      // real move-based score still submits fine — only its own time
      // bonus is what's sacrificed. See docs/DECISIONS.md.
      a.freebieUsedThisLevel = true;
      a.levelElapsedBaseMs += a.currentSegmentMs;
      a.currentSegmentMs = LIFE_EXTENSION_SECONDS * 1000;
      setMessage('');
      showToast(`🎁 Free life — +${LIFE_EXTENSION_SECONDS}s (ads unavailable — won't count toward this level's time bonus)`);
      a.locked = false;
      extendTimer(LIFE_EXTENSION_SECONDS);
      renderHud();
      clearHints();
      scheduleHintTimer();
    }

    async function tryAd() {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Loading ad…';
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
        a.locked = false; // re-enable play now that the prompt is resolved
        // extendTimer() BEFORE renderHud(): same reasoning as beginLevel()'s
        // reordering above — renderHud() persists a.tickTarget, which must
        // already reflect the extension, not the just-expired deadline that
        // led to this ad prompt.
        extendTimer(LIFE_EXTENSION_SECONDS);
        renderHud();
        clearHints();
        scheduleHintTimer();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Rewarded ad (life) failed:', err);
        // Surfaced on-screen, not just console.error — there's no way to
        // check device logs without a terminal, so the actual native
        // AdMob error text (e.g. "No fill.", the most common cause on a
        // new/sideloaded ad unit) needs to reach the player directly.
        errorLine.textContent = describeAdError(err, 'life');
        errorLine.style.display = '';
        // No automatic retry — the SAME button now grants the freebie on
        // its next tap instead of trying the ad again.
        actionBtn.disabled = false;
        actionBtn.textContent = `Continue anyway (+${LIFE_EXTENSION_SECONDS}s, no ad)`;
        actionBtn.dataset.mode = 'freebie';
        // a.locked stays true — the board underneath stays non-interactive
        // until the player picks an option, same as the original lock.
      }
    }

    actionBtn.addEventListener('click', () => {
      if (actionBtn.dataset.mode === 'freebie') {
        grantFreebie();
      } else {
        tryAd();
      }
    });

    const giveUpBtn = document.createElement('button');
    giveUpBtn.className = 'danger';
    giveUpBtn.textContent = 'Give up';
    giveUpBtn.addEventListener('click', () => failAttempt());

    box.appendChild(actionBtn);
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
    clearPersistedAttempt(); // attempt is over either way — nothing left to resume
    renderSummary();
    window.showScreen('screen-attempt-summary');
    submitAttempt();
  }

  // ---- Phase 5 payload assembly ----
  // One record per level (finished or failed), appended right before that
  // level's outcome is committed — not derived after the fact from a flat
  // move log, so there's no ambiguity about which moves/lives/timing belong
  // to which level once the shared life pool and slot index have moved on.
  // NOTE: never called at all for a freebie bonus round — see
  // acceptFreebieBonus()'s header comment; finishBonusLevel() skips this
  // function entirely in that case.
  function pushLevelRecord(outcome) {
    const livesUsedThisLevel = a.livesUsedInRun - a.livesUsedAtLevelStart; // regular-pool lives spent to keep this level alive
    let elapsedMsAtEnd = Math.round(currentLevelElapsedMs());
    if (a.freebieUsedThisLevel) {
      // 2026-09-23: the life-extension freebie is never SSV-verified, so
      // adLifeUsed below stays false for it — but its +60s must also never
      // let elapsedMsAtEnd exceed what THIS level could honestly claim
      // without it (score-replay's own per-level budget check rejects the
      // level — and with it the whole submission — the same as an
      // unverified adLifeUsed claim would). Clamping down here keeps this
      // level's real, fully move-replayed score submittable; only its own
      // time bonus is what the freebie costs. See docs/DECISIONS.md.
      const honestBudgetMs = (a.isBonusLevel ? BONUS_SECONDS : LEVEL_SECONDS) * 1000 + livesUsedThisLevel * LIFE_EXTENSION_SECONDS * 1000;
      elapsedMsAtEnd = Math.min(elapsedMsAtEnd, honestBudgetMs);
    }
    a.payloadLevels.push({
      slot: a.isBonusLevel ? 'bonus' : SLOT_LETTERS[a.slotIndex],
      isBonus: a.isBonusLevel,
      moves: a.currentLevelMoves, // [[r1,c1,r2,c2], ...], in play order
      livesUsedThisLevel,
      adLifeUsed: a.adLifeUsedThisLevel,
      elapsedMsAtEnd,
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

      // SECURITY/CORRECTNESS FIX (2026-09-19, §5.19, report-2.3): every
      // non-2xx response from score-replay throws here — supabase-js does
      // not distinguish a real, definitive rejection (a forged payload,
      // an already-completed attempt, a too-late forfeit) from a genuine
      // network failure. Previously only the 409 "already submitted" case
      // unwrapped the structured body; everything else — including a
      // legitimate 400 rejection with a real reason attached — fell
      // through to the network-failure branch below, which retried it
      // (pointlessly: a definitively-invalid payload fails identically
      // every time) and then told the player "Could not reach the
      // server," which is simply false and erodes trust in the message
      // the NEXT time it's shown for an actual network problem.
      let structured = null;
      if (err && err.context && typeof err.context.json === 'function') {
        try { structured = await err.context.json(); } catch { /* not JSON — a genuine network failure, fall through */ }
      }

      if (structured && typeof structured.error === 'string') {
        if (/already been submitted/i.test(structured.error)) {
          // Good news, not a failure — an earlier try likely succeeded
          // server-side but its response never made it back.
          a.serverResult = { valid: false, error: 'Already saved on the server — check History for your final score.', alreadySaved: true };
          stopHeartbeat();
          if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) renderSummary();
          return;
        }
        if (/no verified ad completion found/i.test(structured.error)) {
          // The ONE structured-rejection case that's still genuinely worth
          // retrying automatically: score-replay already waits ~3s and
          // re-checks server-side (§5.5) before returning this, but
          // Google's SSV callback can occasionally take longer than that.
          // Gets its own message rather than the generic network one.
          const retryIndex = a.submitAttempts - 1;
          if (retryIndex < SUBMIT_RETRY_DELAYS_MS.length) {
            a.serverResult = { valid: false, error: 'Confirming your ad reward — this can take a few seconds…', retrying: true };
            renderSummary();
            setTimeout(() => {
              if (a.attemptId === myAttemptId) submitAttempt();
            }, SUBMIT_RETRY_DELAYS_MS[retryIndex]);
            return;
          }
          a.serverResult = { valid: false, error: 'Your ad reward could not be confirmed in time. Tap Retry to check again.' };
          stopHeartbeat();
          if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) renderSummary();
          return;
        }
        // Any other structured rejection is definitive — the payload was
        // read and judged, not lost in transit. Show the real reason, do
        // not retry (it would just fail identically), and end the
        // attempt's lifecycle same as a successful submission would.
        a.serverResult = { valid: false, error: structured.error, noRetry: true };
        stopHeartbeat();
        if (el('screen-attempt-summary') && !el('screen-attempt-summary').classList.contains('hidden')) renderSummary();
        return;
      }

      // No structured body at all — a genuine network failure (dropped
      // connection, CORS, DNS, a 5xx with no JSON body), where retrying
      // and eventually saying "could not reach the server" is accurate.
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
  //
  // BUG FIX (2026-09-21, device report): a tap here could take a few
  // seconds to resolve (score-replay's own server-side ad-verification
  // backoff is 3s on top of the network round trip), and the button gave
  // no feedback during that window at all — same size, same "Retry saving
  // score" text, fully clickable. A second tap during that window was
  // silently swallowed by the `a.submitting` guard in submitAttempt(),
  // with nothing on screen explaining why. Reported as "the Retry button
  // is disabled" — not literally true in the code, but indistinguishable
  // from it to the player. Now gives immediate, honest feedback: disabled
  // + "Retrying…" the instant it's tapped, restored to normal by
  // renderSummary() once a real result (success or a fresh failure)
  // comes back.
  function retrySubmitAttempt() {
    if (!a || a.submitting) return;
    const retryBtn = el('summary-retry-btn');
    if (retryBtn) {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
    }
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
    // 2026-09-23: whenever the freebie was used this level, pushLevelRecord()
    // clamps elapsedMsAtEnd down to this level's honest (non-freebie)
    // budget — and since the freebie is only ever offered once that same
    // honest budget is already exhausted, elapsedMsAtEnd only ever clamps
    // TO that ceiling, never below it, so score-replay's own
    // leftoverMs = budgetMs - elapsedMsAtEnd always comes out to exactly 0
    // for that level, no exceptions. Mirrored here so the number shown on
    // the level-complete screen matches what the server will actually
    // confirm, instead of showing a real leftover-time bonus that then
    // silently disappears once the attempt is submitted.
    const leftoverMs = a.freebieUsedThisLevel ? 0 : msRemaining();
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
    if (a.isFreebieBonus) {
      // Practice round — never recorded, never added to the score/levels
      // count that reach score-replay. a.levelScore (the live "bonus
      // points" the player just watched tick up) is deliberately left
      // uncommitted here; see acceptFreebieBonus()'s header comment.
      const next = a.slotIndex >= SLOT_LETTERS.length ? finishAttempt : () => prepareLevel({ bonus: false });
      showLevelCompleteScreen({
        eyebrow: 'Practice round over',
        title: 'Nice practice round! 🎁',
        points: a.levelScore,
        timeBonusThisLevel: 0,
        continueLabel: a.slotIndex >= SLOT_LETTERS.length ? 'See results' : 'Continue',
        next,
        practiceOnly: true, // renderLevelCompleteScreen() adds a "didn't count" note instead of adding to lc-total-score
      });
      return;
    }
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
    clearPersistedAttempt(); // attempt is over either way — nothing left to resume
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
    const note = el('level-complete-note');
    if (data.practiceOnly) {
      note.textContent = "Practice round — these points weren't added to your score.";
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
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
      // Reset any leftover "ad failed" state from a previous bonus offer —
      // this is a fresh prompt, so the button starts back in 'ad' mode
      // until THIS ad attempt actually fails (see acceptBonus() below).
      btn.dataset.mode = 'ad';
    }
    const errLine = el('bonus-error-line');
    if (errLine) errLine.classList.add('hidden');
    window.showScreen('screen-bonus-prompt');
  }

  async function acceptBonus() {
    const btn = el('bonus-play-btn');
    if (btn && btn.dataset.mode === 'freebie') {
      // The button already flipped to freebie mode after a prior failure
      // this prompt (see the catch branch below) — this tap grants it
      // directly rather than trying the ad again.
      acceptFreebieBonus();
      return;
    }
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
      const errLine = el('bonus-error-line');
      if (errLine) {
        errLine.textContent = describeAdError(err, 'bonus');
        errLine.classList.remove('hidden');
      }
      // No automatic retry — the SAME button now grants the honestly-
      // labeled practice round on its next tap instead of trying the ad
      // again (2026-09-23, matching offerAdLife()'s equivalent change).
      // Skip (unchanged, its own button) is still there too.
      if (btn) {
        btn.disabled = false;
        btn.textContent = `Play a practice round instead (won't count)`;
        btn.dataset.mode = 'freebie';
      }
    }
  }

  function skipBonus() {
    prepareLevel({ bonus: false });
  }

  // A bonus round played purely for its own sake after a real ad failed to
  // load — never reported to score-replay at all (see pushLevelRecord()'s
  // isBonus branch below and finishBonusLevel()): score-replay hard-rejects
  // ANY level claiming isBonus:true without a matching verified ad
  // completion, and unlike the life-extension freebie's elapsed-time clamp,
  // there's no equivalent "honest ceiling" to clamp a bonus round's score
  // down to — a bonus board's points either come from a real, SSV-verified
  // entry or they don't count at all. Bonus rounds don't advance a.slotIndex
  // either way (see beginLevel()'s comment), so simply never pushing a
  // payload record for this round is completely safe: score-replay never
  // even sees it, and the next regular level's slot sequence is unaffected,
  // exactly as if the player had used the existing Skip button instead.
  function acceptFreebieBonus() {
    const errLine = el('bonus-error-line');
    if (errLine) errLine.classList.add('hidden');
    prepareLevel({ bonus: true, freebie: true });
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

  // Timing for cascade rounds beyond the first (see playCascadeRounds()).
  // Deliberately much cheaper than the first round's 90ms blast / 420ms
  // settle beat — the countdown timer is real wall-clock time and does NOT
  // pause during this animation (see startTimer()/tick()), and the
  // server's own MIN_MS_PER_MOVE floor already assumes each move costs
  // roughly the first round's 420ms; giving every extra chain-reaction
  // round that same full weight would eat real time out of the level's
  // budget on every cascade, on top of what level difficulty was already
  // tuned around. This is a fast highlight-then-settle instead: enough to
  // see that another round happened and why the score moved, not a full
  // repeat of the swap's own animation. Chosen directly over the
  // alternatives (full-weight animation, or full-weight with the timer
  // paused to make it free) — see docs/DECISIONS.md's 2026-09-22 entry.
  const EXTRA_CASCADE_BLAST_MS = 30;
  const EXTRA_CASCADE_SETTLE_MS = 150;

  // Runs the swap through the engine, then plays swap → blast → settle for
  // the swap's own immediate match (unchanged timing from before), followed
  // by a fast highlight-then-settle beat for each further cascade round the
  // swap triggered (see playCascadeRounds()), before checking level
  // completion.
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

    playCascadeRounds(result.rounds, 0);
  }

  // Plays one cascade round's blast-then-settle beat, commits that round's
  // own score+HUD update in sync with it becoming visible, then recurses
  // into the next round if the chain reaction continues. Round 0 (the
  // swap's own direct match) uses the original 90ms/420ms timing; any
  // further round uses the cheaper EXTRA_CASCADE_* timing above. Once the
  // last round settles, runs the same level-completion checks that used to
  // live directly in attemptSwapAt's single setTimeout.
  function playCascadeRounds(rounds, idx) {
    const round = rounds[idx];
    const isFirst = idx === 0;
    const blastMs = isFirst ? 90 : EXTRA_CASCADE_BLAST_MS;
    const settleMs = isFirst ? 420 : EXTRA_CASCADE_SETTLE_MS;

    setTimeout(() => {
      round.clearedCells.forEach((key) => {
        const [r, c] = key.split(',').map(Number);
        const node = cellEl(r, c);
        if (node) node.classList.add('blasting');
      });
    }, blastMs);

    setTimeout(() => {
      a.board = round.board;
      a.levelScore += round.score;
      renderBoard();
      renderHud();

      if (idx + 1 < rounds.length) {
        playCascadeRounds(rounds, idx + 1);
        return;
      }

      a.locked = false;
      a.animating = false;
      clearHints();
      scheduleHintTimer();

      // SECURITY/CORRECTNESS FIX (2026-09-19, §5.11): a move that lands
      // right at expiry is judged on its own result FIRST — if it actually
      // completed the level, that's what happened, full stop, regardless
      // of whether the clock also hit zero during its resolution. Only if
      // it did NOT complete the level does a deferred timeout (or one that
      // expires exactly now) actually get acted on.
      if (!a.isBonusLevel && a.movesMade >= a.levelMovesTarget) {
        finishRegularLevel();
      } else if (a.pendingTimeout || msRemaining() <= 0) {
        a.pendingTimeout = false;
        handleTimeout();
      }
    }, settleMs);
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
    el('reveal-eyebrow').textContent = a.isFreebieBonus ? 'Practice bonus (not counted)' : a.isBonusLevel ? 'Optional Bonus' : 'Theme Reveal';
    el('reveal-title').textContent = a.isBonusLevel
      ? a.isFreebieBonus
        ? 'Practice round'
        : 'Bonus round'
      : `Level ${SLOT_LETTERS[a.slotIndex]} — ${a.levelThemeName}`;
    const emojiGrid = el('reveal-emojis');
    emojiGrid.innerHTML = '';
    a.levelEmojis.forEach((emoji) => {
      const span = document.createElement('span');
      span.textContent = emoji;
      emojiGrid.appendChild(span);
    });
    el('reveal-theme-name').textContent = a.levelThemeName;
    el('reveal-sub').textContent = a.isFreebieBonus
      ? `${BONUS_SECONDS} seconds · no lives · for fun only — points here won't count toward your score`
      : a.isBonusLevel
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
    el('theme-banner-level').textContent = a.isFreebieBonus ? 'Practice round' : a.isBonusLevel ? 'Bonus round' : `Level ${SLOT_LETTERS[a.slotIndex]}`;
    el('theme-banner-name').textContent = a.levelThemeName;
  }

  function renderHud() {
    renderThemeBanner();
    el('game-moves').textContent = a.isBonusLevel ? '—' : `${a.movesMade}/${a.levelMovesTarget}`;
    // Hearts themselves are drawn by renderHearts() (driven every tick by
    // renderTimer(), and also called once more right here so a discrete
    // event like a level start isn't left showing stale state for the
    // ~50ms until the next tick fires).
    renderHearts(msRemaining());

    const scoreEl = el('game-score');
    const newScoreText = Math.round(a.totalScore + a.levelScore).toLocaleString();
    if (scoreEl.textContent !== newScoreText) {
      scoreEl.textContent = newScoreText;
      scoreEl.classList.remove('score-pop');
      void scoreEl.offsetWidth; // restart the pop animation on every change
      scoreEl.classList.add('score-pop');
    }
    el('game-timebonus').textContent = formatTimeBonus(a.timeBonusMicros);
    // Runs after every meaningful state change this function is already
    // called from (level start, a move settling, a life/ad-life used) —
    // see persistAttempt()'s own header comment for why here specifically.
    persistAttempt();
  }

  function formatCountdown(remainingMs) {
    const wholeMs = Math.max(0, Math.floor(remainingMs));
    const fractionalUs = Math.round((remainingMs - Math.floor(remainingMs)) * 1000);
    const s = Math.floor(wholeMs / 1000);
    const ms = wholeMs % 1000;
    const pad = (n, l) => String(n).padStart(l, '0');
    return { sec: pad(s, 2), sub: `${pad(ms, 3)}:${pad(Math.max(0, fractionalUs), 3)}` };
  }

  // ---- Hearts (lives) drain visual ----
  // Exactly 3 hearts — no separate slot for an ad/freebie extension.
  // Heart 0 drains during the level's initial LEVEL_SECONDS, heart 1 during
  // the LIFE_EXTENSION_SECONDS the 1st life's use grants, heart 2 during
  // the LIFE_EXTENSION_SECONDS the 2nd life's use grants. Spending the 3rd
  // (last) life no longer grants a segment of its own (see handleTimeout())
  // — instead, if a real ad or the honestly-labeled freebie grants one,
  // heart 2 refills back to full red and drains again for that segment,
  // exactly the same animation as its first drain. 2026-09-23: this
  // replaced an earlier design with a distinct 4th "ad heart" — simpler,
  // and matches the request that any extra time should read as "the same
  // heart, again" rather than a different, ad-specific indicator.
  // Whichever heart corresponds to the segment currently running also gets
  // a pulsing red outline once that segment's own remaining time drops to
  // <=10s, matching the countdown digits' own .timer-warn threshold.
  //
  // Each heart is one <path>, filled by a linearGradient with 2 pairs of
  // hard-stopped stops (see index.html) rather than 2 separately-colored
  // shapes layered on top of each other — guarantees the drained and
  // undrained portions are pixel-identical in shape, with no risk of two
  // different glyphs/paths drifting out of alignment.
  const HEART_PULSE_THRESHOLD_MS = 10000;

  function setHeartDrain(idKey, fraction) {
    const pct = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    const stopA = document.getElementById(`heart-${idKey}-mid-a`);
    const stopB = document.getElementById(`heart-${idKey}-mid-b`);
    if (stopA) stopA.setAttribute('offset', pct);
    if (stopB) stopB.setAttribute('offset', pct);
  }

  function renderHearts(remainingMs) {
    if (!a) return;
    const showHearts = !a.isBonusLevel;
    el('hearts-row').classList.toggle('hidden', !showHearts);
    el('hearts-dash').classList.toggle('hidden', showHearts);
    if (!showHearts) return;

    // Defensive against a not-yet-finite remainingMs (e.g. called in some
    // future edge case before a.tickTarget exists) — never let a NaN
    // reach setAttribute(), which would silently no-op or throw.
    const safeRemaining = Number.isFinite(remainingMs) ? remainingMs : 0;
    const segmentFraction =
      a.currentSegmentMs > 0 ? Math.max(0, Math.min(1, 1 - safeRemaining / a.currentSegmentMs)) : 0;
    const segmentIsUrgent = safeRemaining <= HEART_PULSE_THRESHOLD_MS;

    // Which heart corresponds to the segment currently running, if any.
    // -1 covers the brief window after all 3 lives are spent but before an
    // ad/freebie has actually been granted (the offer prompt is blocking
    // play) — nothing is draining yet, so nothing should be mid-fill.
    let activeIndex;
    if (a.livesUsedInRun < STARTING_LIVES) {
      activeIndex = a.livesUsedInRun;
    } else if (a.adLifeUsedThisLevel || a.freebieUsedThisLevel) {
      activeIndex = STARTING_LIVES - 1; // reuse + refill the last heart rather than a separate slot
    } else {
      activeIndex = -1;
    }

    for (let i = 0; i < STARTING_LIVES; i++) {
      let frac;
      if (i === activeIndex) {
        // Currently draining — when this is the reused last heart, its own
        // segmentFraction naturally starts back at 0 (full red) the moment
        // the new segment begins, so "refill then drain again" falls out
        // of the exact same math as a first drain, with nothing special
        // to reset by hand.
        frac = segmentFraction;
      } else if (i < a.livesUsedInRun) {
        frac = 1; // already spent this run, not currently the active one
      } else {
        frac = 0; // not reached yet
      }
      setHeartDrain(String(i), frac);
      el(`heart-${i}`).classList.toggle('heart-pulse', segmentIsUrgent && i === activeIndex);
    }
  }

  function renderTimer(remainingMs) {
    const { sec, sub } = formatCountdown(remainingMs);
    el('game-timer-sec').textContent = sec;
    el('game-timer-sub').textContent = sub;
    el('game-timer-sec').closest('.hud-chip-timer').classList.toggle('timer-warn', remainingMs <= 10000);
    renderHearts(remainingMs);
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
      // No Retry button while an automatic retry is already scheduled,
      // once the server's confirmed the row is already saved (retrying
      // that case would only ever hit the same 409 again), or when the
      // rejection is definitive — a forged/invalid payload fails the same
      // way every time, so a Retry button can't offer anything real.
      if (retryBtn) {
        // BUG FIX (2026-09-21, device report): retrySubmitAttempt() puts the
        // button into a disabled "Retrying…" state (see below) for the
        // duration of the request, but nothing ever reset it back — so once
        // a manual retry resolved back into this same "still failing"
        // result, the button looked and behaved exactly like the previous
        // in-flight state (disabled, "Retrying…"), i.e. permanently stuck
        // looking disabled even though a fresh tap would have worked fine.
        // Every render of a definitive/showable result now explicitly
        // restores the button's clickable resting state first, regardless
        // of whether this render is about to hide it again.
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry saving score';
        retryBtn.classList.toggle('hidden', !!r.retrying || !!r.alreadySaved || !!r.noRetry);
      }
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
    tryResume,
    clearPersisted: clearPersistedAttempt,
  };
})();

window.Attempt = Attempt;
