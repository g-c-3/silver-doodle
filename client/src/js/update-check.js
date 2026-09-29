// update-check.js
//
// In-app update prompt for sideloaded builds. On every app open (and when
// returning from the background, throttled) this asks GitHub for the repo's
// "Latest" release, compares its build number to the installed one, and
// offers to download the new APK if it is newer.
//
// How the two numbers line up (no extra CI step needed):
//   - Installed build: build-apk.yml -> patch_build_gradle.py sets Android
//     versionCode = github.run_number, and @capacitor/app's getInfo().build
//     returns exactly that versionCode.
//   - Latest build: build-apk.yml publishes each APK as release tag
//     "build-<run_number>" and marks it Latest (not pre-release), so
//     GET /repos/<repo>/releases/latest always returns the newest build.
//
// Design rules:
//   - Never a forced update: "Later" always works, and asks again next open.
//   - Never interrupts a running attempt: if the game screen is showing, the
//     prompt waits (cheap DOM poll, no network) until the player is out of it.
//   - Every failure (offline, rate-limited, no release yet, odd payload) is
//     silent -- an update check must never get in the way of playing.
//   - No-ops outside the native app (e.g. the GitHub Pages copy), where
//     there is no installed APK to compare against.
//   - Score integrity is unaffected: this only ever opens a download link;
//     the client still never reports anything about itself to the server.
(function () {
  'use strict';

  const REPO = 'g-c-3/silver-doodle';
  const LATEST_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  const DOWNLOAD_PREFIX = 'https://github.com/' + REPO + '/';
  const LAUNCH_DELAY_MS = 1500;          // let boot routing settle first
  const FETCH_TIMEOUT_MS = 6000;
  const RESUME_THROTTLE_MS = 10 * 60 * 1000; // unauthenticated API = 60 req/h/IP
  const DEFER_POLL_MS = 15000;

  let lastCheckAt = 0;
  let dismissedBuild = 0;   // "Later" applies to this app process only
  let promptOpen = false;
  let deferTimer = null;

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

  /** @returns {Promise<{build:number, url:string}|null>} */
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

  function inGame() {
    const g = document.getElementById('screen-game');
    return !!(g && !g.classList.contains('hidden'));
  }

  /** Builds the themed dialog from the app's existing modal classes. */
  function showPrompt(latest, installed) {
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
    }
    later.addEventListener('click', () => {
      dismissedBuild = latest.build;
      close();
    });
    update.addEventListener('click', () => {
      close();
      // Capacitor's WebView hands non-app URLs to the system browser, which
      // downloads the APK; the player then taps it to install over the
      // existing app (same signing key, higher versionCode).
      window.location.assign(latest.url);
    });
  }

  /** Shows the prompt now, or waits until the player is out of a game. */
  function promptWhenIdle(latest, installed) {
    if (deferTimer) { clearInterval(deferTimer); deferTimer = null; }
    if (promptOpen) return;
    if (!inGame()) { showPrompt(latest, installed); return; }
    deferTimer = setInterval(() => {
      if (promptOpen) { clearInterval(deferTimer); deferTimer = null; return; }
      if (inGame()) return;
      clearInterval(deferTimer);
      deferTimer = null;
      showPrompt(latest, installed);
    }, DEFER_POLL_MS);
  }

  async function check() {
    if (!isNative() || promptOpen) return;
    lastCheckAt = Date.now();
    const installed = await getInstalledBuild();
    if (!(installed > 0)) return;
    const latest = await fetchLatest();
    if (!latest || !(latest.build > installed)) return;
    if (latest.build <= dismissedBuild) return; // already said "Later" this run
    promptWhenIdle(latest, installed);
  }

  // Every cold start.
  setTimeout(check, LAUNCH_DELAY_MS);

  // Coming back from the background counts as "opening" the app too, but is
  // throttled so quick app-switching can't burn through the API rate limit.
  const App = appPlugin();
  if (isNative() && App && App.addListener) {
    App.addListener('appStateChange', (state) => {
      if (state && state.isActive && Date.now() - lastCheckAt > RESUME_THROTTLE_MS) {
        check();
      }
    });
  }
})();
