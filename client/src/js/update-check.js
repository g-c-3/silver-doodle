// update-check.js
//
// Manual "Check for update" for sideloaded builds. Runs ONLY when the player
// taps the button on the Profile screen -- there is no automatic check on
// app open or on resume (changed 2026-09-29 on request; the earlier version
// checked on every launch).
//
// How the two numbers line up (no extra CI step needed):
//   - Installed build: build-apk.yml -> patch_build_gradle.py sets Android
//     versionCode = github.run_number, and @capacitor/app's getInfo().build
//     returns exactly that versionCode.
//   - Latest build: build-apk.yml publishes each APK as release tag
//     "build-<run_number>" and marks it Latest (not pre-release), so
//     GET /repos/<repo>/releases/latest always returns the newest build.
//
// Behaviour:
//   - Newer build exists  -> themed Update / Later dialog (never forced).
//   - Already newest      -> inline "App is up to date (build N)." message.
//   - Any failure         -> inline "Could not check for updates" message.
//   - Outside the native app (e.g. the GitHub Pages copy) there is no
//     installed APK to compare against, so an explanatory message is shown.
//   - Score integrity is unaffected: this only ever opens a download link;
//     the client never reports anything about itself to the server.
//   - Google Play constraint: an app may not update itself outside Play, so
//     this file and its Profile button must be removed from any Play build.
(function () {
  'use strict';

  const REPO = 'g-c-3/silver-doodle';
  const LATEST_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  const DOWNLOAD_PREFIX = 'https://github.com/' + REPO + '/';
  const FETCH_TIMEOUT_MS = 6000;

  let busy = false;       // a check (or its dialog) is in progress
  let promptOpen = false;

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform());
  }

  function appPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  }

  /** @returns {Promise<number>} installed versionCode, or NaN if unknown */
  async function getInstalledBuild() {
    try {
      const App = appPlugin();
      if (!App || !App.getInfo) return NaN;
      const info = await App.getInfo();
      return parseInt(info && info.build, 10);
    } catch (e) {
      return NaN;
    }
  }

  /** @returns {Promise<{build:number, url:string}|null>} null on any failure */
  async function fetchLatest() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
      });
      if (!res.ok) return null; // 404 (no non-prerelease yet), 403 (rate limit), ...
      const data = await res.json();
      const m = /^build-(\d+)$/.exec(data.tag_name || '');
      if (!m) return null;
      const apk = (data.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
      // Prefer the APK itself; fall back to the release page.
      const url = (apk && apk.browser_download_url) || data.html_url;
      // Only ever open links that point back into this repo.
      if (typeof url !== 'string' || url.indexOf(DOWNLOAD_PREFIX) !== 0) return null;
      return { build: parseInt(m[1], 10), url: url };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** Builds the themed dialog from the app's existing modal classes. */
  function showPrompt(latest, installed, onClosed) {
    promptOpen = true;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card';

    const icon = document.createElement('div');
    icon.className = 'alert-icon-badge';
    icon.textContent = '⬆️';

    const msg = document.createElement('p');
    msg.className = 'modal-message';
    msg.textContent = 'A new version is available (build ' + latest.build +
      '; you have build ' + installed + '). Download it now?';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'secondary';
    later.textContent = 'Later';
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'primary';
    update.textContent = 'Update';
    actions.appendChild(later);
    actions.appendChild(update);

    card.appendChild(icon);
    card.appendChild(msg);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      promptOpen = false;
      onClosed();
    }
    later.addEventListener('click', close);
    update.addEventListener('click', () => {
      close();
      // Capacitor's WebView hands non-app URLs to the system browser, which
      // downloads the APK; the player then taps it to install over the
      // existing app (same signing key, higher versionCode).
      window.location.assign(latest.url);
    });
  }

  /**
   * One manual check. Resolves to a status object; never throws.
   * @returns {Promise<{status:'unsupported'|'error'|'up-to-date'|'available', installed?:number, latest?:{build:number,url:string}}>}
   */
  async function runCheck() {
    if (!isNative()) return { status: 'unsupported' };
    const installed = await getInstalledBuild();
    if (!(installed > 0)) return { status: 'error' };
    const latest = await fetchLatest();
    if (!latest) return { status: 'error', installed: installed };
    if (latest.build > installed) return { status: 'available', installed: installed, latest: latest };
    return { status: 'up-to-date', installed: installed };
  }

  // ---- Profile screen wiring -------------------------------------------
  const btn = document.getElementById('profile-check-update-btn');
  const statusEl = document.getElementById('profile-update-status');
  if (!btn || !statusEl) return;

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.classList.toggle('hidden', !text);
  }

  btn.addEventListener('click', async () => {
    if (busy || promptOpen) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Checking...';
    setStatus('');

    const r = await runCheck();

    function finish() {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Check for update';
    }

    if (r.status === 'available') {
      setStatus('Build ' + r.latest.build + ' is available (you have build ' + r.installed + ').');
      finish();
      showPrompt(r.latest, r.installed, function () {});
      return;
    }
    if (r.status === 'up-to-date') {
      setStatus('App is up to date (build ' + r.installed + ').');
    } else if (r.status === 'unsupported') {
      setStatus('Update checks only work in the installed app.');
    } else {
      setStatus('Could not check for updates. Check your connection and try again.');
    }
    finish();
  });

  // Clear a stale result whenever the Profile screen is re-shown, so an old
  // "up to date" line never lingers after a new build has been published.
  const profileScreen = document.getElementById('screen-profile');
  if (profileScreen && window.MutationObserver) {
    new MutationObserver(function () {
      if (!profileScreen.classList.contains('hidden') && !busy) setStatus('');
    }).observe(profileScreen, { attributes: true, attributeFilter: ['class'] });
  }
})();
