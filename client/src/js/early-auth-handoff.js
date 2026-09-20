// Match Emojis Daily — earliest-possible magic-link deep-link handoff.
//
// FIXED 2026-09-20: this had regressed to an automatic location.replace()
// redirect at some point between the tappable-button version confirmed
// working on a real device on 2026-09-17 (see docs/DECISIONS.md's Phase 11
// entry — an automatic redirect was tried FIRST, got stuck on a blank
// page in that same real-device test, and was deliberately replaced) and
// today, when this file was extracted from the live repo for the §5.12 CSP
// work and turned out to already be the simpler, previously-broken
// version. Found by cross-referencing this file against
// docs/ARCHITECTURE.md's own description while writing today's docs
// update — not from either security report. Restored to the
// confirmed-working tappable-button design, rebuilt against the
// Content-Security-Policy added today (script-src 'self', no inline
// styles) that didn't exist when the original version was built: the
// overlay is constructed entirely via document.createElement +
// direct .style.property assignment, never innerHTML with a style
// attribute or a <style> block, so nothing here needs a CSP exception.
//
// SECURITY FIX (2026-09-19, §5.12): also the reason this moved out of an
// inline <script> into this external file in the first place — see
// index.html's CSP <meta> tag comment for that reasoning.
//
// See client/src/js/deep-link.js for the full reasoning this handoff
// exists at all (short version: signInWithOtp() uses PKCE, whose
// code_verifier lives in whichever origin started the sign-in, and the
// emailed link always opens in the system browser regardless of where
// that was — so if sign-in was started inside the app, this handoff isn't
// just a UX nicety, it's required for the exchange to be able to succeed
// at all). window.Capacitor is injected natively before any page script
// runs when actually inside the app, so this check is safe to run here.
//
// Deliberately a real tap, not an automatic redirect: browsers require a
// genuine user gesture to hand off to a custom URL scheme — an
// automatic-redirect version of exactly this got stuck on a blank page in
// real on-device testing (see above), which is exactly the bug this
// rebuild exists to not reintroduce.
window.__authHandoffPending = false;

(function () {
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    return; // Already inside the app — nothing to hand off.
  }
  var hasCode = /[?&]code=/.test(location.search);
  var hasToken = /access_token=/.test(location.hash);
  if (!hasCode && !hasToken) return; // Not an auth callback landing — ordinary page load.

  window.__authHandoffPending = true; // app.js checks this and skips its own routing entirely

  var targetUrl = 'matchemojisdaily://auth-callback' + location.search + location.hash;

  var overlay = document.createElement('div');
  overlay.id = 'auth-handoff-overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.gap = '20px';
  overlay.style.padding = '24px';
  overlay.style.textAlign = 'center';
  overlay.style.background = '#0159C5'; // matches the app icon's blue (Section 2/Phase 12 icon note)
  overlay.style.color = '#ffffff';
  overlay.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  var message = document.createElement('p');
  message.textContent = "You're signed in — tap below to return to Match Emojis Daily.";
  message.style.fontSize = '17px';
  message.style.maxWidth = '320px';
  message.style.margin = '0';

  var link = document.createElement('a');
  link.href = targetUrl;
  link.textContent = 'Open Match Emojis Daily';
  link.style.display = 'inline-block';
  link.style.padding = '14px 28px';
  link.style.borderRadius = '999px';
  link.style.background = '#ffffff';
  link.style.color = '#0159C5';
  link.style.fontWeight = '700';
  link.style.fontSize = '16px';
  link.style.textDecoration = 'none';

  overlay.appendChild(message);
  overlay.appendChild(link);
  // document.documentElement (<html>) already exists at this point even
  // though <body> doesn't yet — this script is deliberately the very
  // first <script> in <head>, before the stylesheet, so the overlay is in
  // the tree as early as physically possible rather than waiting for body
  // parsing or DOMContentLoaded.
  document.documentElement.appendChild(overlay);
})();
