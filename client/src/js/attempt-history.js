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
// Two tabs: "Today" shows today's (IST) attempts in start order, numbered
// 1-12 against the same 12/day slot cap start-attempt enforces server-side
// (docs/ARCHITECTURE.md Section 8) — this is a client-side re-derivation of
// that same ordering for display, not a new source of truth. "All" is the
// full history, newest first.
//
// FIXED 2026-09-16: every timestamp is now explicitly formatted in
// Asia/Kolkata, not left to the device's local timezone setting
// (`toLocaleString(undefined, ...)`, the previous behavior). The app's
// entire day-boundary model — score_day, the 12/day slot cap, the
// generate-daily-games cron — is IST-defined; a device set to a different
// timezone (or a browser environment that defaults to UTC) would have shown
// times that didn't match that model, which is exactly the kind of mismatch
// that's confusing to debug from a screenshot alone.
//
// Follows the app's established convention: this module owns fetching +
// rendering only. Static DOM wiring (the tab buttons, Back button, Home's
// entry button) lives in app.js, same as Leaderboard/Profile.

const AttemptHistory = (function () {
  const IST_TIME_ZONE = 'Asia/Kolkata';

  let allRows = []; // full fetched history, newest first (as queried)
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
      const today = todayIst();
      rows = allRows
        .filter((r) => istDateFromIso(r.started_at) === today)
        .slice()
        .sort((a, b) => new Date(a.started_at) - new Date(b.started_at)); // oldest first, so numbering matches start order
      numbered = true;
    } else {
      rows = allRows; // already newest-first from the query
    }

    if (rows.length === 0) {
      empty.textContent = currentTab === 'today' ? 'No attempts yet today — play a level!' : 'No attempts yet — play a level!';
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

  async function open(userId, initialTab = 'today') {
    window.showScreen('screen-attempt-history');
    currentTab = initialTab;
    renderTabs();
    const errEl = el('history-error');
    el('history-list').innerHTML = '';
    el('history-empty').classList.add('hidden');
    errEl.classList.add('hidden');
    errEl.textContent = '';

    const { data, error } = await window.db
      .from('attempts')
      .select('id, started_at, completed_at, score_day, status, score, time_bonus_micros, lives_used, levels_reached')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(50);

    if (error) {
      errEl.textContent = 'Could not load your attempt history.';
      errEl.classList.remove('hidden');
      return;
    }
    allRows = data || [];
    renderCurrentTab();
  }

  return { open, switchTab };
})();

window.AttemptHistory = AttemptHistory;
