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

function renderHome() {
  document.getElementById('home-greeting').textContent = `Hi, ${state.profile.display_name}`;
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

async function signOutToEmailScreen() {
  await Auth.signOut();
  state.session = null;
  state.profile = null;
  document.getElementById('email-input').value = '';
  showScreen('screen-email');
}

document.getElementById('profile-sign-out-btn').addEventListener('click', signOutToEmailScreen);
document.getElementById('home-logout-btn').addEventListener('click', () => {
  if (window.confirm('Sign out?')) {
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

Auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    if (session) {
      routeAfterAuth(session);
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
