// Match Emojis Daily — shared Supabase client
//
// Must load after the Supabase UMD script (window.supabase, the SDK namespace)
// and after config.js (window.APP_CONFIG) in index.html.
//
// Session persistence uses the SDK's default (localStorage), which is correct
// both in a regular mobile browser and inside the Capacitor WebView used for
// the Android build (Phase 4) — this is real shipped app code, not a Claude
// Artifact, so the "no browser storage" sandbox restriction does not apply here.
//
// SECURITY FIX (2026-09-19, §5.18, report-2.3): flowType: 'pkce' is set
// explicitly below. Every comment elsewhere in this codebase (this file's
// own prior history, deep-link.js, DECISIONS.md's 2026-09-14 entry) already
// described PKCE as "Supabase's default" and built the deep-link handoff
// around that assumption — but createClient(url, key) with no options
// actually defaults to flowType: 'implicit' (confirmed directly against
// this project's own vendored @supabase/auth-js 2.116.0 source:
// GoTrueClient.js's own DEFAULT_OPTIONS literally reads `flowType:
// 'implicit'`). So until this line was added, every real sign-in actually
// went through the implicit-flow branch — the app worked, because
// deep-link.js always handled both branches (see its own comment), but the
// live path and the assumed/documented path were backwards from each
// other. That distinction matters beyond documentation accuracy: implicit
// flow puts the full session (access + refresh token) in the emailed
// link's URL fragment, forwarded to a custom URL scheme
// (matchemojisdaily://auth-callback) that Android does not reserve for
// this app alone — another installed app registering the same scheme, or
// any page that fires that URL directly with attacker-controlled tokens,
// could take over a session. PKCE instead puts only a one-time `code` in
// the link, useless without the code_verifier this app's own sign-in
// request stored locally — the exchange can only complete on the device
// that actually asked to sign in.
//
// NOT TESTED END TO END — needs a real device and a real magic-link email
// before this ships. One real PKCE limitation worth testing specifically:
// opening the email link on a DIFFERENT device than the one that requested
// sign-in will fail (no code_verifier there), which the previous
// implicit-flow behavior did not have.
window.db = supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY,
  { auth: { flowType: 'pkce' } }
);
