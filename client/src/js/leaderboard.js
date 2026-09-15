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

const Leaderboard = (function () {
  let currentScope = 'daily';
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
    if (scope === 'daily') return `${periodLabel} — ${count}`;
    if (scope === 'weekly') return `Week of ${periodLabel} — ${count}`;
    return `All-time — ${count}`;
  }

  function renderTabs() {
    document.querySelectorAll('.lb-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === currentScope);
    });
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

  function renderList(top, you) {
    const list = el('lb-list');
    list.innerHTML = '';
    top.forEach((row) => {
      const rowEl = document.createElement('div');
      let className = 'lb-row';
      if (row.rank <= 3) className += ' lb-row-top';
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

  async function loadScope(scope) {
    currentScope = scope;
    renderTabs();
    const myToken = ++loadToken;

    setError('');
    el('lb-list').innerHTML = '';
    el('lb-you-card').classList.add('hidden');
    el('lb-empty').classList.add('hidden');
    el('lb-period-label').textContent = 'Loading…';

    const { data, error } = await window.db.functions.invoke('leaderboard', { body: { scope } });
    if (myToken !== loadToken) return; // a newer tab switch already superseded this response

    if (error || !data || data.error) {
      el('lb-period-label').textContent = '';
      setError((data && data.error) || (error && error.message) || 'Could not load the leaderboard.');
      return;
    }

    el('lb-period-label').textContent = periodLabelText(scope, data.periodLabel, data.totalPlayers);

    if (data.top.length === 0) {
      el('lb-empty').classList.remove('hidden');
      return;
    }
    renderList(data.top, data.you);
    renderYouCard(data.you);
  }

  function open() {
    window.showScreen('screen-leaderboard');
    loadScope(currentScope);
  }

  return {
    open,
    loadScope,
  };
})();

window.Leaderboard = Leaderboard;
