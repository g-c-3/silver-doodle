// Match Emojis Daily — app shell / screen router
//
// Phase 3 scope only: auth (email confirmation link) + profile (display name,
// email change). #screen-home is a placeholder — Phase 4 replaces its contents
// with the actual match-3 game. Everything here is plain DOM wiring, no
// framework, consistent with the Capacitor/plain-JS stack decision in
// docs/DECISIONS.md.

const screens = [
  'screen-loading',
  'screen-email',
  'screen-check-email',
  'screen-name-setup',
  'screen-home',
  'screen-level-reveal',
  'screen-game',
  'screen-level-complete',
  'screen-bonus-prompt',
  'screen-attempt-summary',
  'screen-leaderboard',
  'screen-attempt-history',
  'screen-info',
  'screen-profile',
  'screen-email-change',
  'screen-check-email-change',
];

/** @type {{email: string, session: object|null, profile: object|null}} */
const state = {
  email: '',
  session: null,
  profile: null,
};

function showScreen(id) {
  screens.forEach((s) => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

function setError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setBusy(buttonEl, busy, busyLabel) {
  buttonEl.disabled = busy;
  buttonEl.dataset.label = buttonEl.dataset.label || buttonEl.textContent;
  buttonEl.textContent = busy ? (busyLabel || 'Working…') : buttonEl.dataset.label;
}

/** Strips auth tokens out of the address bar once the SDK has consumed them. */
function scrubAuthParamsFromUrl() {
  if (window.location.hash || window.location.search) {
    history.replaceState(null, '', window.location.pathname);
  }
}

const GAME_COUNT_PER_DAY = 12;

// 'YYYY-MM-DD' in IST — same convention as the server's istDateString()
// helpers (start-attempt, score-replay, etc.), reimplemented client-side
// since this is purely a display concern.
function todayIstDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// IST is a fixed UTC+5:30 offset with no DST, so this is safe as a plain
// string-built Date rather than needing a timezone library.
function istDayBoundsUtc(istDateStr) {
  const start = new Date(`${istDateStr}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

/**
 * Shown openly on Home, not tucked away — re-derives the same day-window
 * start-attempt/start_attempt_slot uses server-side for the 12/day cap
 * (docs/ARCHITECTURE.md Section 8), purely for display. The cap itself is
 * still enforced server-side regardless of what this shows.
 */
async function refreshAttemptsLeftToday() {
  const badge = document.getElementById('home-attempts-left');
  if (!badge || !state.session) return;
  const { startUtc, endUtc } = istDayBoundsUtc(todayIstDateString());
  const { count, error } = await window.db
    .from('attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', state.session.user.id)
    .gte('started_at', startUtc)
    .lte('started_at', endUtc);
  if (error) {
    badge.querySelector('span').textContent = '';
    return;
  }
  const used = count ?? 0;
  const remaining = Math.max(0, GAME_COUNT_PER_DAY - used);
  badge.className = 'attempts-left-badge';
  const textEl = badge.querySelector('span');
  if (remaining === 0) {
    textEl.textContent = 'All 12 attempts used today — come back tomorrow!';
    badge.classList.add('attempts-none');
  } else {
    textEl.textContent = `${remaining} of ${GAME_COUNT_PER_DAY} attempts left today`;
    if (remaining <= 3) badge.classList.add('attempts-low');
  }
}

function renderHome() {
  document.getElementById('home-greeting').textContent = `Hi, ${state.profile.display_name}`;
  refreshAttemptsLeftToday();
}

function renderProfileScreen() {
  document.getElementById('profile-name-input').value = state.profile.display_name;
  document.getElementById('profile-email-display').textContent = state.profile.email;
  setError('profile-name-error', '');
  setError('profile-email-error', '');
}

async function routeAfterAuth(session) {
  state.session = session;
  scrubAuthParamsFromUrl();
  const { data: profile, error } = await Profile.fetch(session.user.id);
  if (error) {
    setError('email-error', 'Could not load your profile. Try again.');
    showScreen('screen-email');
    return;
  }
  state.profile = profile;
  if (Profile.looksLikeDefaultName(profile)) {
    document.getElementById('name-setup-input').value = '';
    showScreen('screen-name-setup');
  } else {
    renderHome();
    showScreen('screen-home');
  }
}

// ---- Email entry (signup + login unified) ----

document.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email-input').value.trim();
  const btn = document.getElementById('email-submit-btn');
  setError('email-error', '');
  setBusy(btn, true, 'Sending link…');
  const { error } = await Auth.sendLoginLink(email);
  setBusy(btn, false);
  if (error) {
    setError('email-error', error.message);
    return;
  }
  state.email = email;
  document.getElementById('check-email-label').textContent = email;
  showScreen('screen-check-email');
});

document.getElementById('check-email-back-btn').addEventListener('click', () => {
  showScreen('screen-email');
});

document.getElementById('check-email-resend-btn').addEventListener('click', async () => {
  setError('check-email-error', '');
  const { error } = await Auth.sendLoginLink(state.email);
  setError('check-email-error', error ? error.message : 'Link resent — check your inbox.');
});

// ---- First-login name setup (optional nudge) ----

document.getElementById('name-setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('name-setup-input').value;
  const btn = document.getElementById('name-setup-submit-btn');
  setError('name-setup-error', '');
  setBusy(btn, true, 'Saving…');
  const { error } = await Profile.updateDisplayName(state.session.user.id, name);
  setBusy(btn, false);
  if (error) {
    setError('name-setup-error', error.message);
    return;
  }
  state.profile.display_name = name.trim();
  renderHome();
  showScreen('screen-home');
});

document.getElementById('name-setup-skip-btn').addEventListener('click', () => {
  renderHome();
  showScreen('screen-home');
});

// ---- Home ----

document.getElementById('home-profile-btn').addEventListener('click', () => {
  renderProfileScreen();
  showScreen('screen-profile');
});

document.getElementById('home-play-btn').addEventListener('click', () => {
  Attempt.startAttempt();
});

document.getElementById('home-leaderboard-btn').addEventListener('click', () => {
  Leaderboard.open();
});

document.getElementById('home-history-btn').addEventListener('click', () => {
  AttemptHistory.open(state.session.user.id, 'all');
});

document.getElementById('home-info-btn').addEventListener('click', () => {
  showScreen('screen-info');
});

document.getElementById('info-back-btn').addEventListener('click', () => {
  showScreen('screen-home');
});

document.getElementById('home-attempts-left').addEventListener('click', () => {
  AttemptHistory.open(state.session.user.id, 'today');
});

document.getElementById('history-back-btn').addEventListener('click', () => {
  showScreen('screen-home');
});

document.querySelectorAll('.history-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    AttemptHistory.switchTab(btn.dataset.tab);
  });
});

// ---- Leaderboard ----

document.querySelectorAll('.lb-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    Leaderboard.loadScope(btn.dataset.scope);
  });
});

document.getElementById('lb-back-btn').addEventListener('click', () => {
  showScreen('screen-home');
});

// ---- Game / bonus / summary ----

document.getElementById('reveal-start-btn').addEventListener('click', () => {
  Attempt.confirmReveal();
});

document.getElementById('reveal-skip-btn').addEventListener('click', () => {
  Attempt.skipBonusFromReveal();
});

document.getElementById('bonus-play-btn').addEventListener('click', () => {
  Attempt.acceptBonus();
});

document.getElementById('level-complete-continue-btn').addEventListener('click', () => {
  Attempt.continueAfterLevelComplete();
});

document.getElementById('bonus-skip-btn').addEventListener('click', () => {
  Attempt.skipBonus();
});

document.getElementById('summary-home-btn').addEventListener('click', () => {
  showScreen('screen-home');
});

// ---- Profile ----

document.getElementById('profile-back-btn').addEventListener('click', () => {
  showScreen('screen-home');
});

document.getElementById('profile-name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('profile-name-input').value;
  const btn = document.getElementById('profile-name-submit-btn');
  setError('profile-name-error', '');
  setBusy(btn, true, 'Saving…');
  const { error } = await Profile.updateDisplayName(state.session.user.id, name);
  setBusy(btn, false);
  if (error) {
    setError('profile-name-error', error.message);
    return;
  }
  state.profile.display_name = name.trim();
  renderHome();
  setError('profile-name-error', 'Saved.');
});

document.getElementById('profile-change-email-btn').addEventListener('click', () => {
  document.getElementById('new-email-input').value = '';
  setError('email-change-error', '');
  showScreen('screen-email-change');
});

const ALERT_ICONS = { info: 'ℹ️', warning: '⏱️', error: '❌', success: '✅' };

/**
 * Themed replacement for the native browser alert() dialog, which doesn't
 * match the app's dark UI. `type` picks a colorful icon badge (info/warning/
 * error/success) rather than a plain system popup. Exposed on window since
 * attempt.js (a separate script/closure) needs to call this too.
 * @param {string} message
 * @param {'info'|'warning'|'error'|'success'} [type='info']
 * @returns {Promise<void>}
 */
function showAlert(message, type = 'info') {
  return new Promise((resolve) => {
    const modal = document.getElementById('alert-modal');
    const okBtn = document.getElementById('alert-modal-ok-btn');
    const icon = document.getElementById('alert-modal-icon');
    document.getElementById('alert-modal-message').textContent = message;
    icon.textContent = ALERT_ICONS[type] || ALERT_ICONS.info;
    icon.className = `alert-icon-badge ${type}`;
    modal.classList.remove('hidden');

    function onOk() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      resolve();
    }
    okBtn.addEventListener('click', onOk);
  });
}
window.showAlert = showAlert;

/**
 * Themed replacement for the native browser confirm() dialog, which doesn't
 * match the app's dark UI (shows as a generic system "Message from
 * g-c-3.github.io" popup). Resolves true/false, same calling shape as
 * window.confirm() so call sites read the same way.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function showConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const okBtn = document.getElementById('confirm-modal-ok-btn');
    const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
    document.getElementById('confirm-modal-message').textContent = message;
    document.getElementById('confirm-modal-icon').textContent = '🚪';
    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function signOutToEmailScreen() {
  await Auth.signOut();
  state.session = null;
  state.profile = null;
  document.getElementById('email-input').value = '';
  showScreen('screen-email');
}

document.getElementById('profile-sign-out-btn').addEventListener('click', signOutToEmailScreen);
document.getElementById('home-logout-btn').addEventListener('click', async () => {
  const confirmed = await showConfirm('Sign out?');
  if (confirmed) {
    signOutToEmailScreen();
  }
});

// ---- Email change ----

document.getElementById('email-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newEmail = document.getElementById('new-email-input').value.trim();
  const btn = document.getElementById('email-change-submit-btn');
  setError('email-change-error', '');
  setBusy(btn, true, 'Sending link…');
  const { error } = await Auth.requestEmailChange(newEmail);
  setBusy(btn, false);
  if (error) {
    setError('email-change-error', error.message);
    return;
  }
  document.getElementById('check-email-change-label').textContent = newEmail;
  showScreen('screen-check-email-change');
});

document.getElementById('email-change-back-btn').addEventListener('click', () => {
  showScreen('screen-profile');
});

document.getElementById('check-email-change-back-btn').addEventListener('click', () => {
  showScreen('screen-profile');
});

// ---- Boot ----
// INITIAL_SESSION fires once on load whether or not the URL contained a
// confirmation-link session, so this single listener covers both "returning
// with an existing session" and "just tapped a confirmation link" cases —
// no separate URL parsing needed.
//
// FIXED 2026-09-15: supabase-js re-fires SIGNED_IN (with the same session,
// not a new login) whenever the browser tab regains focus/visibility — a
// documented supabase-js behavior, not something this app triggers. This
// listener used to call routeAfterAuth() — which unconditionally navigates
// to screen-home — on every SIGNED_IN, silently abandoning an in-progress
// game every time the player switched browser tabs and came back: the
// attempt's heartbeat/tick timers were never stopped (that only happens via
// failAttempt()/finishAttempt(), neither of which this path went through),
// so they kept running in the background against whatever the module-level
// `a` got reassigned to next. hasRoutedOnce restricts the actual navigation
// to the first SIGNED_IN/INITIAL_SESSION of this page load; later re-fires
// still refresh state.session (needed so API calls keep using a current
// token) but no longer yank the player away from wherever they are.

let hasRoutedOnce = false;

Auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    if (session) {
      if (!hasRoutedOnce) {
        hasRoutedOnce = true;
        routeAfterAuth(session);
      } else {
        state.session = session; // keep the token fresh without navigating away
      }
    } else {
      showScreen('screen-email');
    }
    return;
  }
  if (event === 'USER_UPDATED' && session) {
    state.session = session;
    scrubAuthParamsFromUrl();
    Profile.fetch(session.user.id).then(({ data }) => {
      if (data) {
        state.profile = data;
        if (!document.getElementById('screen-profile').classList.contains('hidden')) {
          renderProfileScreen();
        }
      }
    });
  }
});

showScreen('screen-loading');
