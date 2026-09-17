// Match Emojis Daily — native deep-link handoff for magic-link sign-in
//
// Problem this solves: signInWithOtp() uses Supabase's PKCE flow by default,
// which stores a code_verifier in whichever origin actually called it. The
// emailed magic link always opens in the OS's system browser regardless of
// where sign-in was requested — a completely different origin/localStorage
// than the Capacitor app's own WebView. So if sign-in was started inside the
// app, tapping the email link can never complete the exchange in that
// browser tab; the matching code_verifier simply isn't there.
//
// The fix has two halves:
//   1. index.html's very first inline <script> (in <head>, before anything
//      else loads) detects it's running as a bare browser landing on the
//      auth callback (Supabase's redirect back to SITE_URL) and immediately
//      hands the raw code/tokens off to the app via a custom URL scheme —
//      matchemojisdaily://auth-callback — that the app registers in its
//      manifest (patched in at CI time by
//      .github/workflows/scripts/patch_android_manifest.py, since
//      client/android/ isn't committed — see docs/DECISIONS.md).
//   2. This file, which only does anything when actually running inside the
//      native app (Capacitor.isNativePlatform()). It catches that handoff —
//      whether the app was already running (the `appUrlOpen` event) or had
//      to cold-start for it (`getLaunchUrl()`) — and completes the exchange
//      using the app's own Supabase client: the same origin the request
//      started from, so the stored code_verifier actually matches.
//
// A same-browser-tab sign-in (testing the plain web build, no app
// installed) is entirely unaffected — detectSessionInUrl's default handling
// already covers that case exactly as it always has; this file no-ops
// entirely outside the native app.
//
// Once exchangeCodeForSession()/setSession() succeeds below, Supabase's own
// onAuthStateChange fires SIGNED_IN like any other sign-in — app.js's
// existing routing picks that up with no further wiring needed here.

(function () {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
    return; // Nothing to do outside the native app.
  }
  const AppPlugin = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!AppPlugin) return; // @capacitor/app not registered — shouldn't happen, but don't hard-fail startup over it.

  async function completeFromUrl(urlStr) {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return; // Not a URL we can parse — ignore rather than throw.
    }
    // MainActivity's launchMode is singleTask (Capacitor's default), so a
    // tap on any other link the app happens to register for isn't possible
    // here — but this guard keeps the parsing below honest regardless.
    if (url.protocol !== 'matchemojisdaily:' || url.hostname !== 'auth-callback') return;

    const query = new URLSearchParams(url.search);
    const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''));

    // PKCE flow (Supabase's current default) — what a signInWithOtp() magic
    // link actually produces today.
    const code = query.get('code');
    if (code) {
      const { error } = await window.db.auth.exchangeCodeForSession(code);
      if (error) {
        // eslint-disable-next-line no-console
        console.error('Deep-link PKCE exchange failed:', error);
      }
      return;
    }

    // Implicit flow fallback — not what this project's Supabase client is
    // currently configured for, but handled in case that ever changes, so
    // this file doesn't need editing again if it does.
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    if (accessToken && refreshToken) {
      const { error } = await window.db.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error('Deep-link session set failed:', error);
      }
    }
  }

  // Warm case: app already running, OS delivers the new intent while alive.
  AppPlugin.addListener('appUrlOpen', (event) => {
    if (event && event.url) completeFromUrl(event.url);
  });

  // Cold-start case: the app had to launch fresh just to handle the link.
  AppPlugin.getLaunchUrl()
    .then((result) => {
      if (result && result.url) completeFromUrl(result.url);
    })
    .catch(() => {}); // No launch URL (a normal cold start) — nothing to do.
})();
