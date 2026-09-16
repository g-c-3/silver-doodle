// Match Emojis Daily — all-time stats & calendar screen (Phase 9)
//
// Two pieces on one screen, both read-only, both plain client reads of the
// player's own data via existing RLS policies (docs/ARCHITECTURE.md Section 9)
// — no new Edge Function needed, same reasoning as attempt-history.js (Phase 8):
// every field this screen needs is already a plain column on tables the
// player can already read.
//
// 1. Stat tiles: days played, total attempts, best day, least day.
//    - "Total attempts" comes straight from all_time_stats.attempts_started
//      (every attempt opened, regardless of outcome — same accounting the
//      leaderboard's tier-6 cascade already uses, ARCHITECTURE.md Section 7/8).
//    - "Days played", "best day", and "least day" are derived from the
//      player's own daily_stats rows filtered to attempts_completed > 0 — a
//      day with zero completed attempts has no real single-attempt score to
//      rank by. Best/least day use max_score, the same metric as leaderboard
//      tier 1, deliberately — see DECISIONS.md's "one consistent definition
//      of performance" note (Section 9).
//
// 2. Month calendar: dot-marks days with any recorded activity, reading
//    user_year_activity (Section 9's lightweight per-day index, built
//    specifically to avoid a full-month scan of `attempts` on every render).
//    Tapping a marked day drills into that day's own attempts, queried
//    directly from `attempts` the same way attempt-history.js does.
//
// Follows the app's established convention: this module owns fetching +
// rendering only. Static DOM wiring (Back button, calendar nav taps, the
// day-panel Close button) lives in app.js, same as every other screen.

const Stats = (function () {
  const IST_TIME_ZONE = 'Asia/Kolkata';

  let userId = null;
  let dailyRows = [];              // this user's daily_stats rows with attempts_completed > 0, all-time
  let yearActivity = new Map();    // 'YYYY-MM-DD' -> attempts_count, for the currently-fetched year only
  let fetchedYear = null;
  let viewYear, viewMonth;         // 0-indexed month; the calendar's currently displayed page
  let selectedDate = null;         // 'YYYY-MM-DD' currently drilled into, or null

  function el(id) {
    return document.getElementById(id);
  }

  // Same 'YYYY-MM-DD'-in-IST convention duplicated across every module that
  // needs it (app.js, attempt-history.js) — a purely-display concern kept
  // local per module rather than factored into a shared util, matching how
  // the rest of the codebase already does this.
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

  // IST is a fixed UTC+5:30 offset with no DST — safe as a plain
  // string-built Date, same technique as app.js's istDayBoundsUtc().
  function istDayBoundsUtc(istDateStr) {
    const start = new Date(`${istDateStr}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { startUtc: start.toISOString(), endUtc: end.toISOString() };
  }

  function formatScore(n) {
    return Math.round(n).toLocaleString();
  }

  // 'YYYY-MM-DD' -> 'Sep 14, 2026'. Parsed as a plain UTC date with no time
  // component, so there's no timezone-conversion risk turning it into the
  // wrong calendar day.
  function formatDayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
    }) + ' IST';
  }

  function statusLabel(status) {
    if (status === 'completed') return 'Completed';
    if (status === 'forfeited') return 'Forfeited';
    return 'In progress';
  }

  // ---- Stat tiles ----

  function renderTiles() {
    el('stats-days-played').textContent = dailyRows.length.toLocaleString();

    if (dailyRows.length === 0) {
      el('stats-best-day').textContent = '—';
      el('stats-best-day-date').textContent = '';
      el('stats-least-day').textContent = '—';
      el('stats-least-day-date').textContent = '';
      return;
    }

    let best = dailyRows[0];
    let least = dailyRows[0];
    for (const row of dailyRows) {
      if (row.max_score > best.max_score) best = row;
      if (row.max_score < least.max_score) least = row;
    }
    el('stats-best-day').textContent = formatScore(best.max_score);
    el('stats-best-day-date').textContent = formatDayLabel(best.stat_date);
    el('stats-least-day').textContent = formatScore(least.max_score);
    el('stats-least-day-date').textContent = formatDayLabel(least.stat_date);
  }

  async function loadTotalAttempts() {
    const { data, error } = await window.db
      .from('all_time_stats')
      .select('attempts_started')
      .eq('user_id', userId)
      .maybeSingle();
    el('stats-total-attempts').textContent = (!error && data) ? data.attempts_started.toLocaleString() : '0';
  }

  async function loadDailyRows() {
    const { data, error } = await window.db
      .from('daily_stats')
      .select('stat_date, max_score')
      .eq('user_id', userId)
      .gt('attempts_completed', 0)
      .order('stat_date', { ascending: true });
    if (error) {
      dailyRows = [];
      el('stats-tiles-error').textContent = 'Could not load your stats.';
      el('stats-tiles-error').classList.remove('hidden');
      return;
    }
    dailyRows = data || [];
    el('stats-tiles-error').classList.add('hidden');
    renderTiles();
  }

  // ---- Calendar ----

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  async function ensureYearActivity(year) {
    if (fetchedYear === year) return;
    const { data, error } = await window.db
      .from('user_year_activity')
      .select('activity_date, attempts_count')
      .eq('user_id', userId)
      .gte('activity_date', `${year}-01-01`)
      .lte('activity_date', `${year}-12-31`);
    yearActivity = new Map();
    if (!error) {
      (data || []).forEach((row) => yearActivity.set(row.activity_date, row.attempts_count));
    }
    fetchedYear = year;
  }

  function renderCalendarGrid() {
    el('stats-cal-label').textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
    const grid = el('stats-cal-grid');
    grid.innerHTML = '';

    const firstOfMonth = new Date(Date.UTC(viewYear, viewMonth, 1));
    const startWeekday = firstOfMonth.getUTCDay(); // 0 = Sunday
    const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
    const today = todayIst();

    for (let i = 0; i < startWeekday; i++) {
      const pad = document.createElement('div');
      pad.className = 'cal-cell cal-cell-pad';
      grid.appendChild(pad);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const played = yearActivity.has(dateStr);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell';
      if (played) cell.classList.add('cal-cell-played');
      if (dateStr === today) cell.classList.add('cal-cell-today');
      if (dateStr === selectedDate) cell.classList.add('cal-cell-selected');
      cell.innerHTML = `<span>${day}</span>${played ? '<span class="cal-dot"></span>' : ''}`;
      if (played) {
        cell.addEventListener('click', () => openDay(dateStr));
      } else {
        cell.disabled = true;
      }
      grid.appendChild(cell);
    }
  }

  async function changeMonth(delta) {
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    await ensureYearActivity(viewYear);
    renderCalendarGrid();
  }

  // ---- Day drill-down ----

  async function openDay(dateStr) {
    selectedDate = dateStr;
    renderCalendarGrid(); // re-render so the tapped cell shows as selected
    const panel = el('stats-day-panel');
    const list = el('stats-day-list');
    panel.classList.remove('hidden');
    el('stats-day-label').textContent = formatDayLabel(dateStr);
    list.innerHTML = '<p class="muted">Loading…</p>';

    // Same start-of-day-in-IST window attempt-history/app.js already use for
    // "today"'s attempts — here applied to an arbitrary calendar day instead.
    // Matches record_attempt_start's own p_start_date scoping (Section 8), so
    // this lines up with exactly which attempts made this day light up on
    // the calendar in the first place.
    const { startUtc, endUtc } = istDayBoundsUtc(dateStr);
    const { data, error } = await window.db
      .from('attempts')
      .select('id, started_at, status, score, levels_reached')
      .eq('user_id', userId)
      .gte('started_at', startUtc)
      .lte('started_at', endUtc)
      .order('started_at', { ascending: true });

    if (error) {
      list.innerHTML = '<p class="error">Could not load that day.</p>';
      return;
    }
    if (!data || data.length === 0) {
      list.innerHTML = '<p class="muted">No attempts found for this day.</p>';
      return;
    }
    list.innerHTML = '';
    data.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'history-row';
      const scoreText = row.status === 'in_progress' ? '—' : formatScore(row.score);
      const metaText = row.levels_reached ? `${row.levels_reached} level${row.levels_reached === 1 ? '' : 's'}` : '';
      div.innerHTML = `
        <div class="history-row-top">
          <span class="history-row-date">Attempt ${i + 1} · ${formatTime(row.started_at)}</span>
          <span class="history-row-status status-${row.status}">${statusLabel(row.status)}</span>
        </div>
        <div class="history-row-bottom">
          <span class="history-row-score">${scoreText}</span>
          <span class="history-row-meta">${metaText}</span>
        </div>
      `;
      list.appendChild(div);
    });
  }

  function closeDay() {
    selectedDate = null;
    el('stats-day-panel').classList.add('hidden');
    renderCalendarGrid();
  }

  // ---- Entry point ----

  async function open(uid) {
    userId = uid;
    window.showScreen('screen-stats');
    selectedDate = null;
    el('stats-day-panel').classList.add('hidden');
    el('stats-tiles-error').classList.add('hidden');
    el('stats-days-played').textContent = '…';
    el('stats-total-attempts').textContent = '…';
    el('stats-best-day').textContent = '…';
    el('stats-least-day').textContent = '…';
    el('stats-best-day-date').textContent = '';
    el('stats-least-day-date').textContent = '';

    const nowParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: IST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const getPart = (type) => nowParts.find((p) => p.type === type).value;
    viewYear = Number(getPart('year'));
    viewMonth = Number(getPart('month')) - 1;

    await Promise.all([
      loadTotalAttempts(),
      loadDailyRows(),
      ensureYearActivity(viewYear),
    ]);
    renderCalendarGrid();
  }

  return { open, changeMonth, closeDay };
})();

window.Stats = Stats;
