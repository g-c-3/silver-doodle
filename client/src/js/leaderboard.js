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
// REWRITTEN 2026-09-27: the server (leaderboard/index.ts) now reads a
// cached snapshot refreshed on a fixed schedule (daily: every 3h at
// 12/3/6/9 IST am+pm; weekly/all-time: once a day at 12am IST) instead of
// ranking live on every request — see that file and docs/DECISIONS.md's
// 2026-09-27 entry. This file adds the matching client half: cache each
// scope's response in localStorage until its own nextRefreshAt passes, so
// repeat opens within the same window never call the Edge Function at all;
// a live countdown to the next refresh for 'daily'; and distinct
// gold/silver/bronze styling for the top 3 rows.

const Leaderboard = (function () {
  let currentScope = 'daily';
  let loadToken = 0; // bumped on every loadScope() call; guards a slow request from
                      // overwriting a faster later tab switch's result
  let countdownHandle = null;

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
    if (scope === 'daily') return `${periodLabel} — ${count}`;
    if (scope === 'weekly') return `Week of ${periodLabel} — ${count}`;
    return `All-time — ${count}`;
  }

  function renderTabs() {
    document.querySelectorAll('.lb-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === currentScope);
    });
  }

  // ---- Cache (localStorage, keyed per scope) ----
  // Only ever holds ONE entry per scope — the most recent response — since
  // 'daily'/'weekly' naturally roll to a new period at each real-world
  // refresh anyway, so there's nothing worth keeping from the period
  // before. A response with no nextRefreshAt (the server's liveFallback()
  // path — no snapshot existed yet for that period) is deliberately never
  // cached: there's no fixed schedule behind it to safely trust until.
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

  // ---- Refresh-cadence display: live countdown for 'daily', static text
  // for 'weekly'/'all-time' ----
  function stopCountdown() {
    clearInterval(countdownHandle);
    countdownHandle = null;
  }

  function renderRefreshInfo(scope, nextRefreshAt) {
    stopCountdown();
    const infoEl = el('lb-refresh-info');
    if (scope !== 'daily') {
      infoEl.textContent = 'Refreshes once everyday at 12 am.';
      infoEl.classList.remove('hidden', 'lb-refresh-countdown');
      return;
    }
    if (!nextRefreshAt) {
      infoEl.classList.add('hidden'); // liveFallback() response — no fixed schedule to count down to
      return;
    }
    infoEl.classList.add('lb-refresh-countdown');
    infoEl.classList.remove('hidden');
    const target = Date.parse(nextRefreshAt);
    const tick = () => {
      const remainingMs = target - Date.now();
      if (remainingMs <= 0) {
        // The scheduled refresh has passed — the cached data (if any) is
        // stale now too, so just re-load rather than keep counting into
        // negative numbers.
        stopCountdown();
        if (scope === currentScope) loadScope(scope, { force: true });
        return;
      }
      const totalSeconds = Math.floor(remainingMs / 1000);
      const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const s = String(totalSeconds % 60).padStart(2, '0');
      infoEl.textContent = `Next update in ${h}:${m}:${s}`;
    };
    tick();
    countdownHandle = setInterval(tick, 1000);
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
    renderRefreshInfo(scope, data.nextRefreshAt);

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
    stopCountdown();
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
    // Not currently called anywhere (leaving via the Back button just
    // shows a different screen, same as every other screen in this app),
    // but a running countdown interval should never survive past its own
    // screen being closed — exposed for app.js to wire up if that ever
    // changes, and cheap insurance either way.
    stopCountdown();
  }

  return {
    open,
    close,
    loadScope,
  };
})();

window.Leaderboard = Leaderboard;
