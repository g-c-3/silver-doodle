// Match Emojis Daily — app shell / screen router
//
// Phase 3 scope only: auth (email OTP) + profile (display name, email change).
// #screen-home is a placeholder — Phase 4 replaces its contents with the
// actual match-3 game. Everything here is plain DOM wiring, no framework,
// consistent with the Capacitor/plain-JS stack decision in docs/DECISIONS.md.

const screens = [
  'screen-loading',
  'screen-email',
  'screen-otp',
  'screen-name-setup',
  'screen-home',
  'screen-profile',
  'screen-email-change',
  'screen-email-change-otp',
];

/** @type {{email: string, session: object|null, profile: object|null, pendingNewEmail: string|null}} */
const state = {
  email: '',
  session: null,
  profile: null,
  pendingNewEmail: null,
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

async function loadProfileAndGoHome() {
  const session = await Auth.getSession();
  state.session = session;
  if (!session) {
    showScreen('screen-email');
    return;
  }
  const { data: profile, error } = await Profile.fetch(session.user.id);
  if (error) {
    setError('email-error', 'Could not load your profile. Try signing in again.');
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

function renderHome() {
  document.getElementById('home-greeting').textContent = `Hi, ${state.profile.display_name}`;
}

function renderProfileScreen() {
  document.getElementById('profile-name-input').value = state.profile.display_name;
  document.getElementById('profile-email-display').textContent = state.profile.email;
  setError('profile-name-error', '');
  setError('profile-email-error', '');
}

// ---- Email + code (login/signup) ----

document.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email-input').value.trim();
  const btn = document.getElementById('email-submit-btn');
  setError('email-error', '');
  setBusy(btn, true, 'Sending code…');
  const { error } = await Auth.sendLoginCode(email);
  setBusy(btn, false);
  if (error) {
    setError('email-error', error.message);
    return;
  }
  state.email = email;
  document.getElementById('otp-email-label').textContent = email;
  showScreen('screen-otp');
});

document.getElementById('otp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('otp-input').value.trim();
  const btn = document.getElementById('otp-submit-btn');
  setError('otp-error', '');
  setBusy(btn, true, 'Verifying…');
  const { error } = await Auth.verifyLoginCode(state.email, token);
  setBusy(btn, false);
  if (error) {
    setError('otp-error', error.message);
    return;
  }
  await loadProfileAndGoHome();
});

document.getElementById('otp-back-btn').addEventListener('click', () => {
  showScreen('screen-email');
});

document.getElementById('otp-resend-btn').addEventListener('click', async () => {
  setError('otp-error', '');
  const { error } = await Auth.sendLoginCode(state.email);
  setError('otp-error', error ? error.message : 'Code resent.');
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

document.getElementById('profile-sign-out-btn').addEventListener('click', async () => {
  await Auth.signOut();
  state.session = null;
  state.profile = null;
  document.getElementById('email-input').value = '';
  showScreen('screen-email');
});

// ---- Email change ----

document.getElementById('email-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newEmail = document.getElementById('new-email-input').value.trim();
  const btn = document.getElementById('email-change-submit-btn');
  setError('email-change-error', '');
  setBusy(btn, true, 'Sending code…');
  const { error } = await Auth.requestEmailChange(newEmail);
  setBusy(btn, false);
  if (error) {
    setError('email-change-error', error.message);
    return;
  }
  state.pendingNewEmail = newEmail;
  document.getElementById('email-change-otp-label').textContent = newEmail;
  showScreen('screen-email-change-otp');
});

document.getElementById('email-change-back-btn').addEventListener('click', () => {
  showScreen('screen-profile');
});

document.getElementById('email-change-otp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('email-change-otp-input').value.trim();
  const btn = document.getElementById('email-change-otp-submit-btn');
  setError('email-change-otp-error', '');
  setBusy(btn, true, 'Verifying…');
  const { error } = await Auth.confirmEmailChange(state.pendingNewEmail, token);
  setBusy(btn, false);
  if (error) {
    setError('email-change-otp-error', error.message);
    return;
  }
  state.profile.email = state.pendingNewEmail;
  state.pendingNewEmail = null;
  renderProfileScreen();
  showScreen('screen-profile');
});

document.getElementById('email-change-otp-back-btn').addEventListener('click', () => {
  showScreen('screen-email-change');
});

// ---- Boot ----

Auth.onAuthStateChange((_event, session) => {
  state.session = session;
});

showScreen('screen-loading');
loadProfileAndGoHome();
