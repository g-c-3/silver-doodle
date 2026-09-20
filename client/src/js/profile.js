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
   * Heuristic for "has this player ever set a real name" — used only to
   * decide whether to show the optional "set your name" nudge after first
   * login, never for anything security-relevant.
   *
   * FIXED 2026-09-19 (report-2.3, §5.10): this used to compare against the
   * email's local part, matching the on_auth_user_created trigger's OLD
   * default. That default was itself a privacy bug — see
   * supabase/migrations/20260919010000_phase12_display_name_privacy_fix.sql
   * — and after that migration runs, new accounts default to `Player` +
   * 6 hex characters instead. Left unfixed, this heuristic would have
   * silently stopped working the moment that migration shipped: every new
   * signup's real (new-style) default name would fail the old comparison,
   * so the "set your name" nudge would just never show for anyone again.
   * @param {{email: string, display_name: string}} profile
   * @returns {boolean}
   */
  looksLikeDefaultName(profile) {
    return /^Player[0-9a-f]{6}$/i.test(profile.display_name);
  },

  /**
   * Permanently deletes the caller's own account and every row that
   * references it (attempts, all three stats tiers, player_daily_order,
   * user_year_activity, ad_verifications — verified via `on delete cascade`
   * on every one of them, see delete-account/index.ts's own header comment).
   * Not reversible. Satisfies Google Play's in-app account-deletion
   * requirement (report-2.3 §5.10/§5.14 area; docs/DECISIONS.md's
   * 2026-09-19 (later still) entry).
   * @returns {Promise<{error: Error|null}>}
   */
  async deleteAccount() {
    const { data, error } = await window.db.functions.invoke('delete-account', { method: 'POST' });
    if (error) return { error };
    if (!data || data.ok !== true) return { error: new Error((data && data.error) || 'Account deletion failed.') };
    return { error: null };
  },
};
