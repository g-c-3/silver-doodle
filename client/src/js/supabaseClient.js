// Match Emojis Daily — shared Supabase client
//
// Must load after the Supabase UMD script (window.supabase, the SDK namespace)
// and after config.js (window.APP_CONFIG) in index.html.
//
// Session persistence uses the SDK's default (localStorage), which is correct
// both in a regular mobile browser and inside the Capacitor WebView used for
// the Android build (Phase 4) — this is real shipped app code, not a Claude
// Artifact, so the "no browser storage" sandbox restriction does not apply here.

window.db = supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);
