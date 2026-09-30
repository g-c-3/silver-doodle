// Twice-a-day personalised reminder notifications.
//
// Design (see docs/DECISIONS.md, 2026-10-01 entry):
//  - LOCAL notifications only (@capacitor/local-notifications). Nothing is
//    sent to or from any server, so no Firebase/FCM is involved and the
//    player's display name never leaves the device for this feature. The
//    Supabase-auth / Firebase-analytics split is untouched.
//  - Nothing here touches scores, attempts, ads or the leaderboard.
//  - Exactly two reminders per calendar day, each at a RANDOM minute inside
//    its own window (late morning / evening), planned 7 days ahead and
//    re-synced on every app open. Times are kept stable between opens (only
//    missing slots get a fresh random time) so opening the app repeatedly
//    does not keep re-rolling the schedule.
//  - Each reminder greets the player by display name, uses a randomly
//    picked message, and carries a small "screenshot" of an emoji board
//    with one match waiting (art generated in CI by
//    .github/workflows/scripts/gen_notification_art.py as
//    notif_board_1..6). Shown as the notification large icon: the plugin
//    has no Android big-picture style (see the DECISIONS entry).
//  - Runtime permission is requested only after an explicit opt-in (a
//    one-time soft prompt on Home, or the Profile toggle), never on launch.
//  - Sideload AND Play safe: works the same in both; SCHEDULE_EXACT_ALARM is
//    stripped from the manifest (patch_android_manifest.py) because
//    reminders deliberately use inexact alarms.
//
// Exposed as window.Notifs. Every method is a safe no-op outside the native
// app (plain-browser testing) and never throws into the caller.
(function () {
  'use strict';

  const CHANNEL_ID = 'daily-puzzle';
  const ID_BASE = 71000;        // reserved range 71000..71099 for this feature
  const ID_RANGE_END = 71099;
  const TEST_ID = 71099;
  const DAYS_AHEAD = 7;
  const BOARD_ART_COUNT = 6;    // notif_board_1 .. notif_board_6
  const MAX_NAME_LEN = 24;

  // Two windows per local day: [startHour, startMin] -> [endHour, endMin).
  const WINDOWS = [
    { start: [10, 0], end: [13, 30] }, // late morning / lunch
    { start: [17, 30], end: [21, 30] } // evening wind-down
  ];
  const MIN_LEAD_MS = 5 * 60 * 1000; // never schedule closer than 5 min out

  const LS_PLAN = 'med_notif_plan_v1';
  const LS_LAST_COPY = 'med_notif_last_copy_v1';
  const LS_PREF_PREFIX = 'med_notif_pref_v1:'; // + userId -> 'on' | 'off'
  const LS_PROMPTED_PREFIX = 'med_notif_prompted_v1:'; // + userId -> '1'

  // {name} is replaced with the player's display name (or a friendly
  // fallback while they still have the auto-generated PlayerXXXXXX name).
  const COPY = [
    { t: '{name}, your board is waiting 👀', b: 'Three in a row is one swap away. Come crack today\'s puzzle!' },
    { t: 'Psst, {name}! One swap away ✨', b: 'There\'s a match hiding in plain sight. Can you spot it before the timer does?' },
    { t: 'Ready for a combo, {name}? 🔥', b: 'Your emojis are lined up and begging to be matched. Take your shot!' },
    { t: '{name}, today\'s emojis miss you 🥺', b: 'A fresh board is sitting there with a match waiting. Quick round?' },
    { t: 'Hey {name}, climb the leaderboard 🏆', b: 'A few clever swaps could push you up today\'s rankings.' },
    { t: '{name}, feeling lucky? 🍀', b: 'Your next cascade could be a big one. Tap to play.' },
    { t: 'Match time, {name}! 🎯', b: 'Tiny break, big combo energy. Your board is ready.' },
    { t: '{name}, don\'t leave them hanging 🍒🍒🍒', b: 'Two in a row already. Finish the set!' },
    { t: 'Brain snack for {name} 🧠', b: 'Two minutes, one board, endless satisfaction. Come play.' },
    { t: '{name}, the daily puzzle is calling 📣', b: 'New swaps, new scores. Beat your best today!' }
  ];

  function plugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    return (cap.Plugins && cap.Plugins.LocalNotifications) || null;
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable: degrade silently */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // Current player, set by init(). Kept here so callers needn't pass it again.
  let current = { userId: null, name: '', isDefaultName: true };

  function friendlyName() {
    const n = (current.name || '').trim().slice(0, MAX_NAME_LEN);
    return !n || current.isDefaultName ? 'champ' : n;
  }

  function pickCopy() {
    let last = parseInt(lsGet(LS_LAST_COPY), 10);
    if (!Number.isFinite(last)) last = -1;
    let i;
    do { i = Math.floor(Math.random() * COPY.length); } while (COPY.length > 1 && i === last);
    lsSet(LS_LAST_COPY, String(i));
    const name = friendlyName();
    return { title: COPY[i].t.replace('{name}', name), body: COPY[i].b.replace('{name}', name) };
  }

  function atLocal(dayOffset, hm) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hm[0], hm[1], 0, 0).getTime();
  }

  function windowBounds(dayOffset, slot) {
    return { from: atLocal(dayOffset, WINDOWS[slot].start), to: atLocal(dayOffset, WINDOWS[slot].end) };
  }

  /**
   * Builds the 7-day plan: one timestamp per (day, slot) — never more than 2
   * per day. An existing future time already inside a slot's window is
   * re-used; only empty slots get a new random minute.
   * @returns {{id:number, at:number}[]}
   */
  function buildPlan() {
    const now = Date.now();
    let kept = [];
    try {
      const saved = JSON.parse(lsGet(LS_PLAN) || '{}');
      if (saved && saved.userId === current.userId && Array.isArray(saved.times)) kept = saved.times;
    } catch (e) { kept = []; }

    const plan = [];
    for (let d = 0; d < DAYS_AHEAD; d++) {
      for (let s = 0; s < WINDOWS.length; s++) {
        const { from, to } = windowBounds(d, s);
        const existing = kept.find((t) => t >= from && t < to && t > now + MIN_LEAD_MS);
        let at = existing;
        if (!at) {
          const lo = Math.max(from, now + MIN_LEAD_MS);
          if (to - lo < 10 * 60 * 1000) continue; // too little of today's window left
          at = lo + Math.floor(Math.random() * (to - lo));
        }
        plan.push({ id: ID_BASE + d * 2 + s, at });
      }
    }
    return plan;
  }

  async function cancelOurs(LN) {
    try {
      const pending = await LN.getPending();
      const ours = ((pending && pending.notifications) || [])
        .filter((n) => n.id >= ID_BASE && n.id <= ID_RANGE_END)
        .map((n) => ({ id: n.id }));
      if (ours.length) await LN.cancel({ notifications: ours });
    } catch (e) { /* nothing pending / plugin hiccup: scheduling below overwrites by id anyway */ }
  }

  async function hasPermission(LN, askIfNeeded) {
    try {
      let p = await LN.checkPermissions();
      if (p.display === 'granted') return true;
      if (!askIfNeeded) return false;
      if (p.display === 'denied') return false; // OS won't show the dialog again
      p = await LN.requestPermissions();
      return p.display === 'granted';
    } catch (e) { return false; }
  }

  function buildNotification(id, at) {
    const copy = pickCopy();
    const board = 1 + Math.floor(Math.random() * BOARD_ART_COUNT);
    const n = {
      id,
      title: copy.title,
      body: copy.body,
      largeBody: copy.body,
      summaryText: 'Match Emojis Daily',
      channelId: CHANNEL_ID,
      smallIcon: 'ic_stat_match',
      largeIcon: 'notif_board_' + board,
      iconColor: '#ff6f91',
      autoCancel: true,
      // FIXED 2026-10-01 (device report): the plugin defaults this to true,
      // and with exact-alarm permission absent it sends the player to the
      // system "Alarms & reminders" settings page on every schedule() call
      // (including the Profile test and every app-open sync). Reminders are
      // deliberately inexact, so opt out explicitly.
      isExactNotification: false
    };
    if (at) n.schedule = { at: new Date(at), allowWhileIdle: true };
    return n;
  }

  /** (Re)schedules the whole plan. Safe to call any time; idempotent. */
  async function sync() {
    const LN = plugin();
    if (!LN || !current.userId) return;
    if (lsGet(LS_PREF_PREFIX + current.userId) !== 'on') return;
    if (!(await hasPermission(LN, false))) return;
    try {
      await LN.createChannel({
        id: CHANNEL_ID,
        name: 'Daily puzzle reminders',
        description: 'Two friendly nudges a day with a board waiting for you',
        importance: 3,
        visibility: 0
      });
      const plan = buildPlan();
      await cancelOurs(LN);
      if (plan.length) {
        await LN.schedule({ notifications: plan.map((p) => buildNotification(p.id, p.at)) });
      }
      lsSet(LS_PLAN, JSON.stringify({ userId: current.userId, times: plan.map((p) => p.at) }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Notifs.sync() failed:', e);
    }
  }

  async function clear() {
    const LN = plugin();
    lsDel(LS_PLAN);
    if (LN) await cancelOurs(LN);
  }

  window.Notifs = {
    /** True only inside the native app with the plugin present. */
    isSupported() { return !!plugin(); },

    /** Call after the profile is loaded (routeAfterAuth). Re-syncs if opted in. */
    async init(userId, displayName, isDefaultName) {
      current = { userId, name: displayName || '', isDefaultName: !!isDefaultName };
      await sync();
    },

    /** Call after the display name changes so pending reminders greet the new name. */
    async onNameChanged(displayName) {
      current.name = displayName || '';
      current.isDefaultName = false;
      await sync();
    },

    isEnabled() {
      return !!current.userId && lsGet(LS_PREF_PREFIX + current.userId) === 'on';
    },

    /** Opt in: asks the OS for permission if needed. @returns {Promise<'on'|'denied'|'unsupported'>} */
    async enable() {
      const LN = plugin();
      if (!LN || !current.userId) return 'unsupported';
      if (!(await hasPermission(LN, true))) return 'denied';
      lsSet(LS_PREF_PREFIX + current.userId, 'on');
      await sync();
      return 'on';
    },

    async disable() {
      if (current.userId) lsSet(LS_PREF_PREFIX + current.userId, 'off');
      await clear();
    },

    /** One-time soft prompt: true once per player per install, only if supported and never decided. */
    shouldOfferPrompt() {
      if (!plugin() || !current.userId) return false;
      if (lsGet(LS_PROMPTED_PREFIX + current.userId)) return false;
      return lsGet(LS_PREF_PREFIX + current.userId) === null;
    },
    markPromptSeen() {
      if (current.userId) lsSet(LS_PROMPTED_PREFIX + current.userId, '1');
    },

    /** Fires one sample reminder ~5s from now (Profile "Send a test"). */
    async sendTest() {
      const LN = plugin();
      if (!LN) return false;
      if (!(await hasPermission(LN, true))) return false;
      try {
        await LN.createChannel({
          id: CHANNEL_ID,
          name: 'Daily puzzle reminders',
          description: 'Two friendly nudges a day with a board waiting for you',
          importance: 3,
          visibility: 0
        });
        await LN.schedule({ notifications: [buildNotification(TEST_ID, Date.now() + 5000)] });
        return true;
      } catch (e) { return false; }
    },

    /** Sign-out / account deletion: drop every pending reminder and the stored plan. */
    async clearAll() {
      current = { userId: null, name: '', isDefaultName: true };
      await clear();
    }
  };
})();
