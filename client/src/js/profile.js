// Match Emojis Daily — profile
//
// display_name lives in public.users and is the only column the client is
// allowed to write there (RLS enforces this — see the Phase 2 migration's
// users_update_own policy and the protect_users_identity_columns trigger,
// which silently reverts any attempt to change id/email from a non-service-role
// connection). Email changes must go through Auth.requestEmailChange /
// confirmEmailChange instead, never a direct table update.

const Profile = {
  /**
   * @param {string} userId
   * @returns {Promise<{data: {id: string, email: string, display_name: string}|null, error: Error|null}>}
   */
  async fetch(userId) {
    const { data, error } = await window.db
      .from('users')
      .select('id, email, display_name')
      .eq('id', userId)
      .single();
    return { data, error };
  },

  /**
   * @param {string} userId
   * @param {string} displayName
   * @returns {Promise<{error: Error|null}>}
   */
  async updateDisplayName(userId, displayName) {
    const trimmed = displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 24) {
      return { error: new Error('Name must be between 1 and 24 characters.') };
    }
    const { error } = await window.db
      .from('users')
      .update({ display_name: trimmed })
      .eq('id', userId);
    return { error };
  },

  /**
   * Heuristic for "has this player ever set a real name" — the Phase 2
   * on_auth_user_created trigger defaults display_name to the email's local
   * part on first signup. Used only to decide whether to show the optional
   * "set your name" nudge after first login, never for anything security-relevant.
   * @param {{email: string, display_name: string}} profile
   * @returns {boolean}
   */
  looksLikeDefaultName(profile) {
    const emailLocalPart = profile.email.split('@')[0];
    return profile.display_name === emailLocalPart;
  },
};
