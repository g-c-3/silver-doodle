// Match Emojis Daily — leaderboard screen (Phase 7)
//
// Calls the `leaderboard` Edge Function (server/functions/leaderboard/index.ts)
// for the 7-tier cascade ranking (docs/ARCHITECTURE.md Section 7) plus the
// caller's own rank and which tier decided it. window.db.functions.invoke()
// attaches the current session's Authorization header automatically — same
// pattern already used by Attempt's start-attempt/score-replay calls in
// attempt.js, so no manual token handling is needed here.
//
// Follows the app's established convention: this module owns fetching +
// rendering only. Static DOM wiring (tab clicks, the Back button, the Home
// screen's entry button) lives in app.js, same as every other screen.
//
// REWRITTEN 2026-09-27, twice the same session:
//
// 1. The server started reading a cached snapshot refreshed on a fixed
//    schedule instead of ranking live on every request. This file added
//    the matching client half: cache each scope's response in localStorage
//    until its own nextRefreshAt passes, a live countdown to the next
//    refresh, and distinct gold/silver/bronze styling for the top 3 rows.
//
// 2. Account holder requested (verbatim): "Make the Daily as Today & Week
//    as Yesterday and remove the cap on refresh for Today in leaderboard,
//    no more 12, 3, 6, 9, ist. Will refresh fresh." — see
//    server/functions/leaderboard/index.ts's own header for the full
//    rename. Scopes here become 'today' (never cached — the server now
//    omits nextRefreshAt on every 'today' response, so the existing
//    writeCache()/readCache() logic below already does the right thing
//    with zero changes: no nextRefreshAt means never cached, which is
//    exactly "will refresh fresh") and 'yesterday' (a single frozen day,
//    cached indefinitely — no countdown needed since it never changes
//    again). The countdown apparatus this file previously had for 'daily'
//    is removed outright: no remaining scope needs one ('today' is live,
//    'yesterday' is permanently final, 'all-time' still just shows static
//    "refreshes once a day" text, same as before).

const Leaderboard = (function () {
  let currentScope = 'today';
  let loadToken = 0; // bumped on every loadScope() call; guards a slow request from
                      // overwriting a faster later tab switch's result

  function el(id) {
    return document.getElementById(id);
  }

  function formatScore(n) {
    return Math.round(n).toLocaleString();
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function setError(message) {
    const errEl = el('lb-error');
    errEl.textContent = message || '';
    errEl.classList.toggle('hidden', !message);
  }

  function periodLabelText(scope, periodLabel, totalPlayers) {
    const count = totalPlayers === 1 ? '1 player' : `${totalPlayers} players`;
    if (scope === 'today') return `Today — ${count}`;
    if (scope === 'yesterday') return `Yesterday — ${count}`;
    return `All-time — ${count}`;
  }

  function renderTabs() {
    document.querySelectorAll('.lb-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === currentScope);
    });
  }

  // ---- Cache (localStorage, keyed per scope) ----
  // Only ever holds ONE entry per scope — the most recent response — since
  // every scope naturally rolls to a new period at each real-world refresh
  // anyway, so there's nothing worth keeping from the period before. A
  // response with no nextRefreshAt is deliberately never cached: 'today'
  // always omits it (never meant to be cached — "will refresh fresh"), and
  // for any other scope it means the server's liveFallback() path was hit
  // (no snapshot existed yet for that period), which has no fixed schedule
  // behind it to safely trust until.
  function cacheKey(scope) {
    return `lb_cache_${scope}`;
  }

  function readCache(scope) {
    try {
      const raw = localStorage.getItem(cacheKey(scope));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || !parsed.data.nextRefreshAt) return null;
      if (Date.parse(parsed.data.nextRefreshAt) <= Date.now()) return null; // stale — this window has already passed
      return parsed.data;
    } catch {
      return null; // corrupt/unavailable storage — just refetch, no harm done
    }
  }

  function writeCache(scope, data) {
    if (!data || !data.nextRefreshAt) return; // see readCache()'s comment
    try {
      localStorage.setItem(cacheKey(scope), JSON.stringify({ data }));
    } catch {
      // Storage full/unavailable (e.g. private browsing) — the leaderboard
      // still works, it just re-fetches next time instead of using a cache.
    }
  }

  // ---- Refresh-cadence display: static text per scope ----
  // No countdown anymore for any scope (removed 2026-09-27 along with the
  // 'daily' cap it existed for): 'today' is live on every request, so
  // there's nothing to count down to; 'yesterday' is permanently final;
  // 'all-time' only ever needed the static "once a day" text in the first
  // place.
  function renderRefreshInfo(scope) {
    const infoEl = el('lb-refresh-info');
    infoEl.classList.remove('hidden');
    if (scope === 'today') {
      infoEl.textContent = 'Live — always up to date.';
    } else if (scope === 'yesterday') {
      infoEl.textContent = "Final — yesterday's standings are locked in.";
    } else {
      infoEl.textContent = 'Refreshes once everyday at 12 am.';
    }
  }

  function renderYouCard(you) {
    const card = el('lb-you-card');
    if (!you) {
      card.classList.add('hidden');
      card.innerHTML = '';
      return;
    }
    const tierText = you.decidingTierName
      ? `Decided by: ${escapeHtml(you.decidingTierName)}`
      : you.rank === 1
        ? "You're in the lead."
        : '';
    card.innerHTML = `
      <div class="lb-you-rank">#${you.rank} · ${escapeHtml(you.displayName)}</div>
      <div class="lb-you-detail">Score ${formatScore(you.score)}${tierText ? ' — ' + tierText : ''}</div>
    `;
    card.classList.remove('hidden');
  }

  // 2026-09-27: rank 1/2/3 each get their own gold/silver/bronze class
  // (styles.css) instead of the old single lb-row-top treating all three
  // identically.
  function medalClass(rank) {
    if (rank === 1) return ' lb-row-rank-1';
    if (rank === 2) return ' lb-row-rank-2';
    if (rank === 3) return ' lb-row-rank-3';
    return '';
  }

  function renderList(top, you) {
    const list = el('lb-list');
    list.innerHTML = '';
    top.forEach((row) => {
      const rowEl = document.createElement('div');
      let className = 'lb-row' + medalClass(row.rank);
      if (you && you.userId === row.userId) className += ' lb-row-self';
      rowEl.className = className;
      rowEl.innerHTML = `
        <span class="lb-row-rank">#${row.rank}</span>
        <span class="lb-row-name">${escapeHtml(row.displayName)}</span>
        <span class="lb-row-score">${formatScore(row.score)}</span>
      `;
      list.appendChild(rowEl);
    });
  }

  function renderData(scope, data) {
    el('lb-period-label').textContent = periodLabelText(scope, data.periodLabel, data.totalPlayers);
    renderRefreshInfo(scope);

    if (data.top.length === 0) {
      el('lb-empty').classList.remove('hidden');
      return;
    }
    renderList(data.top, data.you);
    renderYouCard(data.you);
  }

  async function loadScope(scope, { force = false } = {}) {
    currentScope = scope;
    renderTabs();
    const myToken = ++loadToken;

    setError('');
    el('lb-list').innerHTML = '';
    el('lb-you-card').classList.add('hidden');
    el('lb-empty').classList.add('hidden');
    el('lb-refresh-info').classList.add('hidden');

    if (!force) {
      const cached = readCache(scope);
      if (cached) {
        el('lb-period-label').textContent = '';
        renderData(scope, cached);
        return; // served entirely from cache — no network call this open
      }
    }

    el('lb-period-label').textContent = 'Loading…';

    const { data, error } = await window.db.functions.invoke('leaderboard', { body: { scope } });
    if (myToken !== loadToken) return; // a newer tab switch already superseded this response

    if (error || !data || data.error) {
      el('lb-period-label').textContent = '';
      setError((data && data.error) || (error && error.message) || 'Could not load the leaderboard.');
      return;
    }

    writeCache(scope, data);
    renderData(scope, data);
  }

  function open() {
    window.showScreen('screen-leaderboard');
    loadScope(currentScope);
  }

  function close() {
    // No-op now — kept as a stable exported surface for app.js (not
    // currently called anywhere; leaving via the Back button just shows a
    // different screen, same as every other screen in this app). Used to
    // stop a running countdown interval, but no scope has one anymore
    // (2026-09-27 — see this file's header).
  }

  return {
    open,
    close,
    loadScope,
  };
})();

window.Leaderboard = Leaderboard;
