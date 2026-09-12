// Match Emojis Daily — auth
//
// Email + OTP only (docs/ARCHITECTURE.md Section 10). One form handles both
// signup and login: Supabase's signInWithOtp creates the auth.users row on
// first use (shouldCreateUser defaults to true), and the on_auth_user_created
// trigger (Phase 2 migration) mirrors it into public.users automatically.
// There is no separate "sign up" button anywhere in this app on purpose.

const Auth = {
  /**
   * Sends a 6-digit OTP code to the given email. Works for both a brand-new
   * email (creates the account) and a returning user (logs them in).
   * @param {string} email
   * @returns {Promise<{error: Error|null}>}
   */
  async sendLoginCode(email) {
    const { error } = await window.db.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    return { error };
  },

  /**
   * Verifies the 6-digit code sent by sendLoginCode and establishes a session.
   * @param {string} email
   * @param {string} token - the 6-digit code the player typed in
   * @returns {Promise<{error: Error|null}>}
   */
  async verifyLoginCode(email, token) {
    const { error } = await window.db.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    return { error };
  },

  /**
   * Starts an email-change flow for the current session. Supabase sends a
   * confirmation OTP to the NEW address (secure email change was enabled in
   * Phase 1, so Supabase may also notify the old address — that's a Supabase
   * Auth setting, not something this client controls).
   * @param {string} newEmail
   * @returns {Promise<{error: Error|null}>}
   */
  async requestEmailChange(newEmail) {
    const { error } = await window.db.auth.updateUser({ email: newEmail });
    return { error };
  },

  /**
   * Confirms an email change with the code sent to the new address.
   * @param {string} newEmail
   * @param {string} token
   * @returns {Promise<{error: Error|null}>}
   */
  async confirmEmailChange(newEmail, token) {
    const { error } = await window.db.auth.verifyOtp({
      email: newEmail,
      token,
      type: 'email_change',
    });
    return { error };
  },

  async signOut() {
    const { error } = await window.db.auth.signOut();
    return { error };
  },

  /**
   * @returns {Promise<import('@supabase/supabase-js').Session|null>}
   */
  async getSession() {
    const { data } = await window.db.auth.getSession();
    return data.session;
  },

  /**
   * Registers a callback fired on every auth state change (sign-in, sign-out,
   * token refresh, email-change confirmation).
   * @param {(event: string, session: object|null) => void} callback
   */
  onAuthStateChange(callback) {
    window.db.auth.onAuthStateChange((event, session) => callback(event, session));
  },
};
