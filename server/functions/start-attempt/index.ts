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
// Phase 2 `validate_game_order` trigger. On every call: atomically (via the
// Phase 8 `start_attempt_slot` Postgres function) locks this player+day,
// works out which attempt-of-the-day this is, enforces the 12/day cap,
// resolves that to a game_index/game_definition_id, and inserts the new
// `attempts` row (status in_progress) — all in one transaction, so a
// concurrent second call can't race past the cap. Then fetches that game
// definition's 26 slots and returns everything the client needs to play
// deterministically.
//
// FIXED 2026-09-15 (Phase 8): the cap check used to be a separate
// count-then-insert (two queries, no lock), which a concurrent second call
// could race past — see docs/DECISIONS.md's 2026-09-15 "atomic slot cap"
// entry. Now the whole count/cap-check/insert is one atomic RPC call.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// CORS: the client calls these functions from a github.io origin, which is
// cross-origin from *.supabase.co, so the browser sends an OPTIONS
// preflight before the real POST. Every response (including error
// responses) needs these headers, or the browser discards the response
// before the caller's code ever sees it — see docs/DECISIONS.md's
// 2026-09-14 "CORS" entry for why this was missing initially and how it
// was found (405s on OPTIONS in the Invocations log, not a local repro).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};


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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only.' }), { status: 405, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header.' }), { status: 401, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  // New sb_secret_.../sb_publishable_... key system — see
  // docs/DECISIONS.md's 2026-09-14 "Edge Function key sourcing" entry.
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const anonKey = publishableKeys['default'];
  const serviceRoleKey = secretKeys['default'];
  if (!anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'SUPABASE_PUBLISHABLE_KEYS/SUPABASE_SECRET_KEYS missing a "default" entry.' }), { status: 500, headers: CORS_HEADERS });
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
    return new Response(JSON.stringify({ error: 'Not authenticated.' }), { status: 401, headers: CORS_HEADERS });
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
        return new Response(JSON.stringify({ error: `Could not assign a daily order: ${insertResult.error.message}` }), { status: 500, headers: CORS_HEADERS });
      }
      gameOrder = reread.data.game_order;
    }
  }

  // 2. Atomically: lock this (user, date), count today's attempts, check
  // the 12/day cap, resolve which game_index this attempt is, and insert
  // the attempts row — all inside one Postgres function/transaction, so a
  // concurrent second call can't race past the cap or double-claim the same
  // game_index. See supabase/migrations/20260915000000_phase8_atomic_slot_cap.sql.
  const { startUtc, endUtc } = istDayBoundsUtc(gameDate);
  const slotResult = await admin
    .rpc('start_attempt_slot', {
      p_user_id: user.id,
      p_game_date: gameDate,
      p_start_bound_utc: startUtc,
      p_end_bound_utc: endUtc,
      p_game_count: GAME_COUNT_PER_DAY,
      p_game_order: gameOrder,
    })
    .single();
  if (slotResult.error) {
    if (slotResult.error.message.includes('DAILY_CAP_REACHED')) {
      return new Response(JSON.stringify({ error: "All of today's games have already been started." }), { status: 400, headers: CORS_HEADERS });
    }
    if (slotResult.error.message.includes('NO_GAME_DEFINITION')) {
      return new Response(
        JSON.stringify({ error: `No game definition found for ${gameDate} — has generate-daily-games run for today yet?` }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
    return new Response(JSON.stringify({ error: `Could not start attempt: ${slotResult.error.message}` }), { status: 500, headers: CORS_HEADERS });
  }
  const { attempt_id: attemptId, attempt_number: attemptNumberToday, game_definition_id: gameDefinitionId } = slotResult.data;

  // 3. Fetch that game definition's 26 slots.
  const slotsResult = await admin
    .from('daily_game_definition_slots')
    .select('slot_index, theme_id, board_pattern')
    .eq('game_definition_id', gameDefinitionId)
    .order('slot_index');
  if (slotsResult.error || !slotsResult.data || slotsResult.data.length !== 26) {
    return new Response(JSON.stringify({ error: 'Game definition is missing slots — data integrity issue, not a client error.' }), { status: 500, headers: CORS_HEADERS });
  }

  // 4. Roll this attempt into attempts_started on the daily/weekly/all-time
  // stats rows for TODAY (the start date — see the function's own comment
  // in the Phase 7 migration for why this is deliberately not score_day).
  // Best-effort: a failure here doesn't block the player from getting their
  // game — it only means this one attempt under-counts on the leaderboard's
  // "attempts played" tier, which self-corrects on their next attempt.
  const statsResult = await admin.rpc('record_attempt_start', {
    p_user_id: user.id,
    p_start_date: gameDate,
  });
  if (statsResult.error) {
    console.error(`record_attempt_start failed for user ${user.id}, ${gameDate}: ${statsResult.error.message}`);
  }

  return new Response(
    JSON.stringify({
      attemptId,
      gameDefinitionId,
      attemptNumberToday, // 0-indexed, useful for client-side "game N of 12" display
      slots: slotsResult.data.map((s) => ({
        slotIndex: s.slot_index,
        themeIndex: s.theme_id - 1, // DB's 1-26 -> the 0-25 convention used everywhere else
        boardPattern: s.board_pattern,
      })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
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
