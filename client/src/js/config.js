// Match Emojis Daily — client config
//
// These are non-secret identifiers meant to be embedded in shipped client code
// (see docs/DECISIONS.md, "Supabase access token exposure and rotation" entry —
// this is explicitly the category of value that IS safe to commit).
//
// SUPABASE_URL is derived from the project ref in docs/ARCHITECTURE.md Section 12
// (wgkcxixocfzydawurluh, South Asia / Mumbai).
//
// SUPABASE_ANON_KEY below is the real anon/public key for this project
// (Project Settings > API > "anon" / "public" key — NOT the service_role key).
// The anon key is safe to ship in a client app; the service_role key never is.

window.APP_CONFIG = {
  SUPABASE_URL: 'https://wgkcxixocfzydawurluh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indna2N4aXhvY2Z6eWRhd3VybHVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxOTYyNDUsImV4cCI6MjEwNDc3MjI0NX0.-toqqM-9aY8DM0YFn380CcKlDyW6f6BIGsYlKLJTrGw',
  // Must exactly match the Site URL / an entry in Redirect URLs in Supabase
  // Dashboard > Authentication > URL Configuration, or Supabase will refuse
  // to redirect back here after a confirmation/magic-link email is tapped.
  SITE_URL: 'https://g-c-3.github.io/silver-doodle/client/src/index.html',
};
