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
// Follows the app's established convention: this module owns fetching +
// rendering only. Static DOM wiring (the Back button, Home's entry button)
// lives in app.js, same as Leaderboard/Profile.

const AttemptHistory = (function () {
  function el(id) {
    return document.getElementById(id);
  }

  function formatDateTime(iso) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatScore(n) {
    return Math.round(n).toLocaleString();
  }

  function statusLabel(status) {
    if (status === 'completed') return 'Completed';
    if (status === 'forfeited') return 'Forfeited';
    return 'In progress';
  }

  function renderRow(row) {
    const div = document.createElement('div');
    div.className = 'history-row';
    const scoreText = row.status === 'in_progress' ? '—' : formatScore(row.score);
    const metaParts = [];
    if (row.score_day) metaParts.push(`Scored ${row.score_day}`);
    if (row.levels_reached) metaParts.push(`${row.levels_reached} level${row.levels_reached === 1 ? '' : 's'}`);
    div.innerHTML = `
      <div class="history-row-top">
        <span class="history-row-date">${formatDateTime(row.started_at)}</span>
        <span class="history-row-status status-${row.status}">${statusLabel(row.status)}</span>
      </div>
      <div class="history-row-bottom">
        <span class="history-row-score">${scoreText}</span>
        <span class="history-row-meta">${metaParts.join(' · ')}</span>
      </div>
    `;
    return div;
  }

  async function open(userId) {
    window.showScreen('screen-attempt-history');
    const list = el('history-list');
    const empty = el('history-empty');
    const errEl = el('history-error');
    list.innerHTML = '';
    empty.classList.add('hidden');
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
    if (!data || data.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    data.forEach((row) => list.appendChild(renderRow(row)));
  }

  return { open };
})();

window.AttemptHistory = AttemptHistory;
