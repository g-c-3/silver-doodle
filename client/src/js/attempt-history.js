// Match Emojis Daily — attempt history screen (Phase 8)
//
// Read-only list of the player's own past attempts: start time, status,
// score, and which day it was scored against (docs/ARCHITECTURE.md
// Section 9). Queried directly against `attempts` via the existing
// `attempts_select_own` RLS policy (Phase 2) — no Edge Function needed
// here, since this is a plain read of the player's own data and every field
// the screen needs is already a column on that table. Starting/completing
// an attempt remain the only server-authoritative writes (Score Integrity);
// this screen never writes anything.
//
// Two tabs, now on two genuinely separate data paths (2026-09-27 — see
// below): "Today" shows today's (IST) attempts in start order, numbered
// 1-12 against the same 12/day slot cap start-attempt enforces server-side
// (docs/ARCHITECTURE.md Section 8) — this is a client-side re-derivation of
// that same ordering for display, not a new source of truth. "All" is
// everything BEFORE today, newest first.
//
// 2026-09-16: every timestamp is now explicitly formatted in Asia/Kolkata,
// not left to the device's local timezone setting (`toLocaleString(undefined,
// ...)`, the previous behavior). The app's entire day-boundary model —
// score_day, the 12/day slot cap, the generate-daily-games cron — is
// IST-defined; a device set to a different timezone (or a browser
// environment that defaults to UTC) would have shown times that didn't
// match that model, which is exactly the kind of mismatch that's confusing
// to debug from a screenshot alone.
//
// 2026-09-27, requested directly ("All time attempt history will show only
// till previous day, will refresh 12am everyday... cached once per day"):
// "All" no longer includes today at all — today's own progress belongs on
// the "Today" tab (same "not settled until the day ends" reasoning already
// applied to Stats' calendar this session) — and, since everything "All"
// can now show is guaranteed already-final, its whole result set is cached
// in localStorage for the rest of the current IST day rather than
// refetched on every screen open. The cache is keyed to today's IST date,
// not a fixed expiry timer, so it naturally refreshes exactly at midnight
// IST — the next open after the date rolls over just doesn't match the
// cached date and refetches, no timer bookkeeping needed. "Today" stays a
// live, always-fresh, uncached query — it changes throughout the day as
// the player plays.
//
// Follows the app's established convention: this module owns fetching +
// rendering only. Static DOM wiring (the tab buttons, Back button, Home's
// entry button) lives in app.js, same as Leaderboard/Profile.

const AttemptHistory = (function () {
  const IST_TIME_ZONE = 'Asia/Kolkata';
  const HISTORY_ROW_FIELDS = 'id, started_at, completed_at, score_day, status, score, time_bonus_micros, lives_used, levels_reached';

  let todayRows = [];
  let allRows = []; // everything before today, newest first (as queried) — never includes today's own attempts
  let currentTab = 'today';

  function el(id) {
    return document.getElementById(id);
  }

  // 'YYYY-MM-DD' in IST for a given ISO timestamp — same convention as the
  // server's istDateString() helpers (start-attempt, score-replay, etc.),
  // reimplemented client-side since this is purely a display concern.
  function istDateFromIso(iso) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: IST_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function todayIst() {
    return istDateFromIso(new Date().toISOString());
  }

  // Start of today (IST) as a UTC instant — the "All" query's exclusive
  // upper bound. IST is a fixed UTC+5:30 offset (no DST), same technique
  // used server-side throughout this codebase (start-attempt's
  // istDayBoundsUtc(), generate-daily-games' istDayStartUtc()).
  function todayStartUtc() {
    return new Date(`${todayIst()}T00:00:00+05:30`).toISOString();
  }

  // Time only, no 'IST' suffix — a building block for the start–end range
  // below, so 'IST' isn't repeated twice per row.
  function formatTimeShort(iso) {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatTime(iso) {
    return formatTimeShort(iso) + ' IST';
  }

  function formatDateShort(iso) {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST_TIME_ZONE,
      month: 'short',
      day: 'numeric',
    });
  }

  // Start–end range for a finished/forfeited attempt ("3:37–3:41 pm IST").
  // Falls back to just the start time for an attempt still in_progress,
  // which has no completed_at yet.
  function timeRangeLabel(row) {
    if (!row.completed_at) return formatTime(row.started_at);
    return `${formatTimeShort(row.started_at)}–${formatTimeShort(row.completed_at)} IST`;
  }

  function formatScore(n) {
    return Math.round(n).toLocaleString();
  }

  function statusLabel(status) {
    if (status === 'completed') return 'Completed';
    if (status === 'forfeited') return 'Forfeited';
    return 'In progress';
  }

  function renderRow(row, attemptNumber) {
    const div = document.createElement('div');
    div.className = 'history-row';
    const scoreText = row.status === 'in_progress' ? '—' : formatScore(row.score);
    const metaParts = [];
    if (row.score_day) metaParts.push(`Scored ${row.score_day}`);
    if (row.levels_reached) metaParts.push(`${row.levels_reached} level${row.levels_reached === 1 ? '' : 's'}`);
    const leftLabel = attemptNumber
      ? `Attempt ${attemptNumber}/12 · ${timeRangeLabel(row)}`
      : `${formatDateShort(row.started_at)}, ${timeRangeLabel(row)}`;
    div.innerHTML = `
      <div class="history-row-top">
        <span class="history-row-date">${leftLabel}</span>
        <span class="history-row-status status-${row.status}">${statusLabel(row.status)}</span>
      </div>
      <div class="history-row-bottom">
        <span class="history-row-score">${scoreText}</span>
        <span class="history-row-meta">${metaParts.join(' · ')}</span>
      </div>
    `;
    return div;
  }

  function renderTabs() {
    document.querySelectorAll('.history-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === currentTab);
    });
  }

  function renderCurrentTab() {
    const list = el('history-list');
    const empty = el('history-empty');
    list.innerHTML = '';
    empty.classList.add('hidden');

    let rows;
    let numbered = false;
    if (currentTab === 'today') {
      rows = todayRows
        .slice()
        .sort((a, b) => new Date(a.started_at) - new Date(b.started_at)); // oldest first, so numbering matches start order
      numbered = true;
    } else {
      rows = allRows; // already newest-first, already excludes today — see file header
    }

    if (rows.length === 0) {
      empty.textContent = currentTab === 'today' ? 'No attempts yet today — play a level!' : 'No attempts yet before today.';
      empty.classList.remove('hidden');
      return;
    }
    rows.forEach((row, i) => list.appendChild(renderRow(row, numbered ? i + 1 : null)));
  }

  function switchTab(tab) {
    currentTab = tab;
    renderTabs();
    renderCurrentTab();
  }

  // ---- "All" tab cache — see file header for why this is safe to cache
  // for the whole rest of today, and why it must never include today. ----
  function allCacheKey(userId) {
    return `history_all_${userId}`;
  }

  function readAllCache(userId) {
    try {
      const raw = localStorage.getItem(allCacheKey(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.asOfDate !== todayIst()) return null; // midnight IST has passed since this was cached
      return parsed.rows;
    } catch {
      return null; // corrupt/unavailable storage — just refetch, no harm done
    }
  }

  function writeAllCache(userId, rows) {
    try {
      localStorage.setItem(allCacheKey(userId), JSON.stringify({ asOfDate: todayIst(), rows }));
    } catch {
      // Storage full/unavailable (e.g. private browsing) — the screen still
      // rendered fine this time, it'll just re-fetch on the next open.
    }
  }

  async function loadToday(userId) {
    const startUtc = todayStartUtc();
    const endUtc = new Date(new Date(startUtc).getTime() + 86_400_000 - 1).toISOString();
    const { data, error } = await window.db
      .from('attempts')
      .select(HISTORY_ROW_FIELDS)
      .eq('user_id', userId)
      .gte('started_at', startUtc)
      .lte('started_at', endUtc)
      .order('started_at', { ascending: false });
    if (error) throw error;
    todayRows = data || [];
  }

  async function loadAll(userId) {
    const cached = readAllCache(userId);
    if (cached) {
      allRows = cached;
      return; // served entirely from cache — no network read this open
    }
    const { data, error } = await window.db
      .from('attempts')
      .select(HISTORY_ROW_FIELDS)
      .eq('user_id', userId)
      .lt('started_at', todayStartUtc()) // hard-excludes today at the query itself, not just on display
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    allRows = data || [];
    writeAllCache(userId, allRows);
  }

  async function open(userId, initialTab = 'today') {
    window.showScreen('screen-attempt-history');
    currentTab = initialTab;
    renderTabs();
    const errEl = el('history-error');
    el('history-list').innerHTML = '';
    el('history-empty').classList.add('hidden');
    errEl.classList.add('hidden');
    errEl.textContent = '';

    try {
      // Independent failures render independently — a broken "All" fetch
      // shouldn't blank out an otherwise-working "Today" tab, or vice versa.
      const results = await Promise.allSettled([loadToday(userId), loadAll(userId)]);
      const failed = results.some((r) => r.status === 'rejected');
      if (failed) {
        errEl.textContent = 'Could not load your full attempt history — showing what loaded.';
        errEl.classList.remove('hidden');
      }
    } finally {
      renderCurrentTab();
    }
  }

  return { open, switchTab };
})();

window.AttemptHistory = AttemptHistory;
