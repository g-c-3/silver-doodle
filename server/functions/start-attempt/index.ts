// Match Emojis Daily — start-attempt (Phase 6)
//
// User-authenticated Edge Function called by the client at the start of
// every attempt (replaces attempt.js's current dev-stub client-generated
// seed/theme-shuffle — see docs/ROADMAP.md's Phase 6 entry for what's still
// open in attempt.js/score-replay after this session).
//
// On a player's first call of the day: assigns a random permutation of the
// day's 12 game_index values (0-11) to that player, stored in
// player_daily_order, and validated as a true permutation by the existing
// Phase 2 `validate_game_order` trigger. On every call: works out which
// attempt-of-the-day this is (a plain count of the player's attempts rows
// already started today — NOT yet cap-enforced; the 12/day slot cap is
// Phase 8, not this session), maps that count through the player's
// permutation to get a game_index, fetches that game definition's 26 slots,
// inserts a new `attempts` row (status in_progress), and returns everything
// the client needs to play deterministically.
//
// KNOWN GAP: no slot-cap enforcement yet — a 13th call in one day would
// currently throw (array index out of the permutation's 0-11 range) rather
// than being cleanly rejected with a "come back tomorrow" message. Phase 8
// is where that becomes a proper, deliberate limit rather than an
// out-of-bounds error.
//
// KNOWN GAP: the `attempts` row inserted here is never updated again — its
// status stays 'in_progress' and score/time_bonus_micros/etc. stay at their
// defaults forever, even after the client separately calls score-replay and
// gets an authoritative result back. Wiring score-replay's result into an
// UPDATE on this row (plus score_day attribution, Section 8) is Phase 7/8
// territory, not attempted here — this function's only job is handing out
// the next game to play.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GAME_COUNT_PER_DAY = 12;

function istDateString(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Start/end of the IST calendar day, as UTC instants, for filtering
// `attempts.started_at` (stored as timestamptz).
function istDayBoundsUtc(dateStr: string): { startUtc: string; endUtc: string } {
  // IST is a fixed UTC+5:30 offset (no DST), so this is safe as a constant
  // rather than needing real timezone-database math.
  const startUtc = new Date(`${dateStr}T00:00:00+05:30`).toISOString();
  const endUtc = new Date(`${dateStr}T23:59:59.999+05:30`).toISOString();
  return { startUtc, endUtc };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only.' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header.' }), { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  // New sb_secret_.../sb_publishable_... key system — see
  // docs/DECISIONS.md's 2026-09-14 "Edge Function key sourcing" entry.
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const anonKey = publishableKeys['default'];
  const serviceRoleKey = secretKeys['default'];
  if (!anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'SUPABASE_PUBLISHABLE_KEYS/SUPABASE_SECRET_KEYS missing a "default" entry.' }), { status: 500 });
  }

  // Caller-scoped client — used only to resolve who's asking (from their own
  // JWT). All actual reads/writes below use the service-role client, since
  // player_daily_order and attempts have no client-insert RLS policy (by
  // design — see docs/DECISIONS.md's Phase 2 RLS entries).
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'Not authenticated.' }), { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const gameDate = istDateString();

  // 1. Assign this player's serving order for today, if not already done.
  const orderRow = await admin
    .from('player_daily_order')
    .select('game_order')
    .eq('user_id', user.id)
    .eq('game_date', gameDate)
    .maybeSingle();

  let gameOrder: number[];
  if (orderRow.data) {
    gameOrder = orderRow.data.game_order;
  } else {
    // Seeded per (user, date) so a retried/duplicate call can't silently
    // assign two different orders on a race — deterministic, not
    // cryptographically random, which is fine here: this only decides
    // *serving order*, not anything security- or fairness-sensitive between
    // players (every player still eventually sees all 12 identical games).
    const rng = makeRng(`${gameDate}:${user.id}:order`);
    gameOrder = shuffle(Array.from({ length: GAME_COUNT_PER_DAY }, (_, i) => i), rng);
    const insertResult = await admin
      .from('player_daily_order')
      .insert({ user_id: user.id, game_date: gameDate, game_order: gameOrder })
      .select('game_order')
      .maybeSingle();
    if (insertResult.error) {
      // Most likely a race with a concurrent call for the same user/date —
      // re-read rather than fail, since the row now very likely exists.
      const reread = await admin
        .from('player_daily_order')
        .select('game_order')
        .eq('user_id', user.id)
        .eq('game_date', gameDate)
        .maybeSingle();
      if (!reread.data) {
        return new Response(JSON.stringify({ error: `Could not assign a daily order: ${insertResult.error.message}` }), { status: 500 });
      }
      gameOrder = reread.data.game_order;
    }
  }

  // 2. Work out which attempt-of-the-day this is.
  const { startUtc, endUtc } = istDayBoundsUtc(gameDate);
  const { count, error: countErr } = await admin
    .from('attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('started_at', startUtc)
    .lte('started_at', endUtc);
  if (countErr) {
    return new Response(JSON.stringify({ error: `Could not count today's attempts: ${countErr.message}` }), { status: 500 });
  }
  const attemptNumberToday = count ?? 0;
  if (attemptNumberToday >= GAME_COUNT_PER_DAY) {
    // Soft guard, not the real Phase 8 cap — see file header KNOWN GAP.
    return new Response(JSON.stringify({ error: "All of today's games have already been started." }), { status: 400 });
  }
  const gameIndex = gameOrder[attemptNumberToday];

  // 3. Fetch that game definition's 26 slots.
  const def = await admin.from('daily_game_definitions').select('id').eq('game_date', gameDate).eq('game_index', gameIndex).maybeSingle();
  if (!def.data) {
    return new Response(
      JSON.stringify({ error: `No game definition found for ${gameDate} game_index ${gameIndex} — has generate-daily-games run for today yet?` }),
      { status: 500 }
    );
  }
  const slotsResult = await admin
    .from('daily_game_definition_slots')
    .select('slot_index, theme_id, board_pattern')
    .eq('game_definition_id', def.data.id)
    .order('slot_index');
  if (slotsResult.error || !slotsResult.data || slotsResult.data.length !== 26) {
    return new Response(JSON.stringify({ error: 'Game definition is missing slots — data integrity issue, not a client error.' }), { status: 500 });
  }

  // 4. Start the attempt row.
  const attemptInsert = await admin
    .from('attempts')
    .insert({ user_id: user.id, game_definition_id: def.data.id, status: 'in_progress' })
    .select('id')
    .single();
  if (attemptInsert.error || !attemptInsert.data) {
    return new Response(JSON.stringify({ error: `Could not start attempt: ${attemptInsert.error?.message}` }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      attemptId: attemptInsert.data.id,
      gameDefinitionId: def.data.id,
      attemptNumberToday, // 0-indexed, useful for client-side "game N of 12" display
      slots: slotsResult.data.map((s) => ({
        slotIndex: s.slot_index,
        themeIndex: s.theme_id - 1, // DB's 1-26 -> the 0-25 convention used everywhere else
        boardPattern: s.board_pattern,
      })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});

// ---- Seeded RNG (kept in sync by hand with generate-daily-games/index.ts,
// game-engine.js, and score-replay/index.ts — see the standing maintenance
// note in docs/DECISIONS.md) ----
function hashSeed(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function makeRng(seedStr: string): () => number {
  let a = hashSeed(String(seedStr)) >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
