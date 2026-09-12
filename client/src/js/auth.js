// Match Emojis Daily — auth
//
// Email + link only (docs/ARCHITECTURE.md Section 10 says "email + OTP" — this
// implements that as a tap-the-link OTP rather than a typed 6-digit code; see
// docs/DECISIONS.md Phase 3 block for why the typed-code variant was dropped).
// One form handles both signup and login: Supabase's signInWithOtp creates the
// auth.users row on first use (shouldCreateUser defaults to true), and the
// on_auth_user_created trigger (Phase 2 migration) mirrors it into public.users
// automatically. There is no separate "sign up" button anywhere in this app.
//
// Session pickup after the link is tapped is handled entirely by the Supabase
// SDK's built-in URL detection (default detectSessionInUrl: true) — app.js
// listens for the resulting auth state change rather than parsing the URL itself.

const Auth = {
  /**
   * Sends a sign-in/sign-up confirmation link to the given email. Works for
   * both a brand-new email (creates the account) and a returning user (logs
   * them in). The link redirects back to APP_CONFIG.SITE_URL with a session.
   * @param {string} email
   * @returns {Promise<{error: Error|null}>}
   */
  async sendLoginLink(email) {
    const { error } = await window.db.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.APP_CONFIG.SITE_URL,
      },
    });
    return { error };
  },

  /**
   * Starts an email-change flow for the current session. Supabase emails a
   * confirmation link to the NEW address; tapping it redirects back here and
   * fires a USER_UPDATED auth event once the change is applied server-side
   * (which also re-fires the Phase 2 sync trigger into public.users.email).
   * @param {string} newEmail
   * @returns {Promise<{error: Error|null}>}
   */
  async requestEmailChange(newEmail) {
    const { error } = await window.db.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: window.APP_CONFIG.SITE_URL }
    );
    return { error };
  },

  async signOut() {
    const { error } = await window.db.auth.signOut();
    return { error };
  },

  /**
   * Registers a callback fired on every auth state change, including the
   * initial state on page load (event 'INITIAL_SESSION') — this is what picks
   * up a session encoded in the URL after a confirmation link redirect.
   * @param {(event: string, session: object|null) => void} callback
   */
  onAuthStateChange(callback) {
    window.db.auth.onAuthStateChange((event, session) => callback(event, session));
  },
};
