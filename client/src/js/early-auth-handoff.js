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
// BEAUTIFIED 2026-09-21: previously a flat #0159C5 (the app *icon's* blue)
// with no visual relationship to the app's actual in-app theme (dark
// #14121f background, pink/purple gradient accents — see
// client/src/css/styles.css's :root variables). This page runs before that
// stylesheet is even requested (deliberately the very first <script> in
// <head>, see below), so it can't reference those CSS variables directly —
// their hex values are simply copied in here instead, kept in a comment
// next to each use so they're easy to keep in sync if the palette in
// styles.css ever changes.
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
  overlay.style.gap = '18px';
  // env(safe-area-inset-*) is a plain CSS value, so it works fine through
  // direct .style assignment same as any other value — no <style> block or
  // CSP allowance needed for it. This page can land inside a system
  // browser's own chrome (see the Opera screenshot this rebuild was
  // checked against) rather than the app's edge-to-edge WebView, so it
  // matters less here than elsewhere in the app, but costs nothing to
  // handle correctly.
  overlay.style.padding = '24px calc(24px + env(safe-area-inset-right, 0px)) calc(24px + env(safe-area-inset-bottom, 0px)) calc(24px + env(safe-area-inset-left, 0px))';
  overlay.style.paddingTop = 'max(24px, env(safe-area-inset-top, 0px))';
  overlay.style.textAlign = 'center';
  overlay.style.background = 'radial-gradient(circle at 50% 30%, #241f3d 0%, #14121f 70%)'; // --bg: #14121f, lightened toward center for depth
  overlay.style.color = '#f2f0fa'; // --text
  overlay.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  // Soft glow behind the logo — a blurred circle, not a pseudo-element
  // (pseudo-elements need a <style> block, which this file deliberately
  // avoids — see the file header). Purely decorative, positioned behind
  // the logo via z-index rather than DOM order since flex would otherwise
  // stack it visibly above/below instead of behind.
  var glow = document.createElement('div');
  glow.style.position = 'absolute';
  glow.style.top = '50%';
  glow.style.left = '50%';
  glow.style.transform = 'translate(-50%, -50%)';
  glow.style.width = '180px';
  glow.style.height = '180px';
  glow.style.borderRadius = '50%';
  glow.style.background = 'linear-gradient(135deg, #ff6f91, #7c6fff)'; // --accent, --accent-2
  glow.style.filter = 'blur(60px)';
  glow.style.opacity = '0.35';
  glow.style.zIndex = '0';

  var logo = document.createElement('div');
  logo.textContent = '🧩';
  logo.style.fontSize = '56px';
  logo.style.lineHeight = '1';
  logo.style.position = 'relative';
  logo.style.zIndex = '1';
  logo.style.filter = 'drop-shadow(0 4px 16px rgba(0, 0, 0, 0.4))';

  var heading = document.createElement('h1');
  heading.textContent = "You're signed in";
  heading.style.fontSize = '22px';
  heading.style.fontWeight = '700';
  heading.style.margin = '0';
  heading.style.position = 'relative';
  heading.style.zIndex = '1';

  var message = document.createElement('p');
  message.textContent = 'Tap below to return to Match Emojis Daily.';
  message.style.fontSize = '16px';
  message.style.color = '#a39fb8'; // --muted
  message.style.maxWidth = '320px';
  message.style.margin = '0';
  message.style.position = 'relative';
  message.style.zIndex = '1';

  var link = document.createElement('a');
  link.href = targetUrl;
  link.textContent = 'Open Match Emojis Daily';
  link.style.display = 'inline-block';
  link.style.marginTop = '8px';
  link.style.padding = '16px 32px';
  link.style.borderRadius = '999px';
  link.style.background = 'linear-gradient(135deg, #ff6f91, #7c6fff)'; // matches button.primary in styles.css
  link.style.color = '#ffffff';
  link.style.fontWeight = '700';
  link.style.fontSize = '16px';
  link.style.textDecoration = 'none';
  link.style.boxShadow = '0 8px 24px rgba(124, 111, 255, 0.35)';
  link.style.position = 'relative';
  link.style.zIndex = '1';
  link.style.transition = 'transform 0.1s ease';
  // Simple press feedback — pointer events cover both touch and mouse in
  // one listener pair, no separate touchstart/mousedown handling needed.
  link.addEventListener('pointerdown', function () {
    link.style.transform = 'scale(0.96)';
  });
  link.addEventListener('pointerup', function () {
    link.style.transform = 'scale(1)';
  });
  link.addEventListener('pointercancel', function () {
    link.style.transform = 'scale(1)';
  });

  overlay.appendChild(glow);
  overlay.appendChild(logo);
  overlay.appendChild(heading);
  overlay.appendChild(message);
  overlay.appendChild(link);
  // document.documentElement (<html>) already exists at this point even
  // though <body> doesn't yet — this script is deliberately the very
  // first <script> in <head>, before the stylesheet, so the overlay is in
  // the tree as early as physically possible rather than waiting for body
  // parsing or DOMContentLoaded.
  document.documentElement.appendChild(overlay);
})();
