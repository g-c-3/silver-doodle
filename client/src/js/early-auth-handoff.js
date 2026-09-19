// Match Emojis Daily — earliest-possible magic-link deep-link handoff.
//
// SECURITY FIX (2026-09-19, §5.12): this used to be an inline <script> at
// the very top of index.html's <head> — deliberately the very first thing
// on the page, before even the stylesheet, so a bare-browser landing on
// the auth callback hands off to the app as fast as possible. Moved to its
// own file so the new Content-Security-Policy (see index.html's <meta>
// tag) can use a plain `script-src 'self'` with no inline-script hash to
// keep in sync by hand every time this logic changes — a hash that's
// forgotten after an edit fails SILENTLY (the browser just drops the
// script under CSP), which is a worse failure mode than a slightly less
// minimal CSP. Loaded as the very first <script src="...">, before the
// stylesheet, to preserve the original load-order guarantee: an external
// synchronous <script> still blocks HTML parsing exactly like an inline
// one does.
//
// See client/src/js/deep-link.js for the full reasoning this handoff
// exists at all (short version: signInWithOtp()'s PKCE code_verifier lives
// in whichever origin started the sign-in, and the emailed link always
// opens in the system browser regardless of where that was — so if
// sign-in was started inside the app, this handoff isn't just a UX
// nicety, it's required for the exchange to be able to succeed at all).
// window.Capacitor is injected natively before any page script runs when
// actually inside the app, so this check is safe to run here.
(function () {
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    return; // Already inside the app — nothing to hand off.
  }
  var hasCode = /[?&]code=/.test(location.search);
  var hasToken = /access_token=/.test(location.hash);
  if (!hasCode && !hasToken) return; // Not an auth callback landing — ordinary page load.
  location.replace('matchemojisdaily://auth-callback' + location.search + location.hash);
})();
