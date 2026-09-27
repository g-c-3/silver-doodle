// Match Emojis Daily — leaderboard Edge Function (Phase 7)
//
// REWRITTEN 2026-09-27: previously called get_leaderboard_page() live, on
// every request — a full 7-tier rank() pass over the scope's entire stats
// table, every single leaderboard screen open, from every player. Now
// reads leaderboard_ranks/leaderboard_snapshots instead (supabase/
// migrations/20260927010000_leaderboard_snapshot_caching.sql), populated
// on a fixed refresh schedule (daily: every 3h; weekly/all-time: once a
// day) rather than per-request — this function's job is now just cheap
// indexed lookups: top N, the caller's own row, and (if the caller is
// outside the top N) the row directly above them for decidingTier. See
// docs/DECISIONS.md's 2026-09-27 entry for the full reasoning.
//
// get_leaderboard_page() itself (docs/ARCHITECTURE.md Section 7's 7-tier
// cascade, supabase/migrations/20260919020000_phase12_leaderboard_scaling_fix.sql)
// is kept as-is and used ONLY as a graceful fallback here — see
// liveFallback() below — for the narrow case where a snapshot for the
// requested scope/period doesn't exist yet (e.g. right after this feature
// first deploys, before the first scheduled refresh has run for that
// period). This fallback is expected to be rare in steady state, not the
// normal path.
//
// Accepts POST { scope: 'daily' | 'weekly' | 'all-time', date?: string,
// limit?: number } — contract unchanged from before this rewrite. `date`
// only applies to 'daily'/'weekly'; both default to "now, in IST" if
// omitted. `limit` defaults to 50, capped at 200.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Scope = 'daily' | 'weekly' | 'all-time';

// Fixed sentinel period_key for the 'all-time' scope's single snapshot row
// — MUST stay identical to generate-daily-games/index.ts's own constant of
// the same name (see that file's comment for why this can't just be
// "today"). Duplicated by hand, same convention as this codebase's other
// small cross-file constants (e.g. the seeded RNG).
const ALL_TIME_PERIOD_KEY = '2000-01-01';

// One row of leaderboard_ranks — the persisted, already-computed shape.
// Unprefixed column names now (no more out_* — that was only needed to
// dodge PL/pgSQL's ambiguous-column-reference error inside a RETURNS TABLE
// function; this is a plain table select, no such collision exists here).
interface RankedRow {
  user_id: string;
  rnk: number;
  max_score: number;
  sum_score: number;
  max_time_bonus_micros: number;
  sum_time_bonus_micros: number;
  sum_lives_used: number;
  sum_levels_played: number;
  attempts_started: number;
  attempts_completed: number;
}

const TIER_NAMES = [
  'Highest single-attempt score',
  'Average score',
  'Highest single-attempt time bonus',
  'Average time bonus',
  'Average lives used (fewer is better)',
  'Attempts played (fewer is better)',
  'Average levels played (fewer is better)',
];

function average(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null;
}

// Same purpose as before the rewrite: first tier (1-indexed) at which two
// adjacent ranked rows actually differ. Only ever called on two rows, so
// re-deriving the 7 tier values here in JS is cheap.
function decidingTierIndex(row: RankedRow, betterRow: RankedRow): number {
  const tierValues = (r: RankedRow): (number | null)[] => [
    r.max_score,
    average(r.sum_score, r.attempts_completed),
    r.max_time_bonus_micros,
    average(r.sum_time_bonus_micros, r.attempts_completed),
    average(r.sum_lives_used, r.attempts_completed),
    r.attempts_started,
    average(r.sum_levels_played, r.attempts_completed),
  ];
  const a = tierValues(row);
  const b = tierValues(betterRow);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return TIER_NAMES.length;
}

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

// Monday of the ISO week containing `dateStr` — matches the SQL side's
// weekly branch in refresh_leaderboard_snapshot().
function mondayOfWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d.toISOString().slice(0, 10);
}

function fail(error: string) {
  return { error };
}

function buildEntry(row: RankedRow, displayName: string) {
  return {
    rank: row.rnk,
    userId: row.user_id,
    displayName,
    score: row.max_score,
    avgScore: row.attempts_completed > 0 ? Math.round(row.sum_score / row.attempts_completed) : null,
    timeBonusMicros: row.max_time_bonus_micros,
    avgTimeBonusMicros: row.attempts_completed > 0 ? Math.round(row.sum_time_bonus_micros / row.attempts_completed) : null,
    avgLivesUsed: row.attempts_completed > 0 ? Number((row.sum_lives_used / row.attempts_completed).toFixed(2)) : null,
    attemptsPlayed: row.attempts_started,
    avgLevelsPlayed: row.attempts_completed > 0 ? Number((row.sum_levels_played / row.attempts_completed).toFixed(2)) : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify(fail('POST only.')), { status: 405, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify(fail('Missing Authorization header.')), { status: 401, headers: CORS_HEADERS });
  }

  let body: { scope?: string; date?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(fail('Invalid JSON body.')), { status: 400, headers: CORS_HEADERS });
  }
  const scope = body.scope as Scope;
  if (scope !== 'daily' && scope !== 'weekly' && scope !== 'all-time') {
    return new Response(JSON.stringify(fail("scope must be 'daily', 'weekly', or 'all-time'.")), { status: 400, headers: CORS_HEADERS });
  }
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const anonKey = publishableKeys['default'];
  const serviceRoleKey = secretKeys['default'];
  if (!anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify(fail('SUPABASE_PUBLISHABLE_KEYS/SUPABASE_SECRET_KEYS missing a "default" entry.')), { status: 500, headers: CORS_HEADERS });
  }

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify(fail('Not authenticated.')), { status: 401, headers: CORS_HEADERS });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const today = istDateString();
  let periodLabel: string;
  let periodKey: string;

  if (scope === 'daily') {
    periodKey = body.date ?? today;
    periodLabel = periodKey;
  } else if (scope === 'weekly') {
    periodKey = mondayOfWeek(body.date ?? today);
    periodLabel = periodKey;
  } else {
    periodKey = ALL_TIME_PERIOD_KEY; // the single fixed row — see the constant's own comment
    periodLabel = 'all-time';
  }

  const snapshot = await admin
    .from('leaderboard_snapshots')
    .select('generated_at, next_refresh_at, total_players')
    .eq('scope', scope)
    .eq('period_key', periodKey)
    .maybeSingle();
  if (snapshot.error) return new Response(JSON.stringify(fail(snapshot.error.message)), { status: 500, headers: CORS_HEADERS });

  if (!snapshot.data) {
    // No refresh has run yet for this exact scope/period — expected to be
    // rare (a brand-new period right as this feature first deploys, or a
    // manually-requested past date old enough to predate this feature).
    // Falls back to computing live, this one time, rather than showing the
    // player an empty leaderboard. Does not write a snapshot itself — the
    // scheduled refresh is still the only writer, keeping this fallback's
    // own read-cost bounded to just this one request.
    return await liveFallback(admin, scope, periodKey, periodLabel, user.id, limit);
  }

  const rankedResult = await admin
    .from('leaderboard_ranks')
    .select('user_id, rnk, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed')
    .eq('scope', scope)
    .eq('period_key', periodKey)
    .order('rnk', { ascending: true })
    .limit(limit);
  if (rankedResult.error) return new Response(JSON.stringify(fail(rankedResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const topRows = (rankedResult.data ?? []) as RankedRow[];

  // The caller's own row (present or not) plus, if they're outside the top
  // N, the row directly above them for decidingTier — two more single-row
  // indexed lookups, never a re-rank.
  let callerRow: RankedRow | null = null;
  let aboveRow: RankedRow | null = null;
  const callerInTop = topRows.find((r) => r.user_id === user.id);
  if (callerInTop) {
    callerRow = callerInTop;
  } else {
    const callerResult = await admin
      .from('leaderboard_ranks')
      .select('user_id, rnk, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed')
      .eq('scope', scope)
      .eq('period_key', periodKey)
      .eq('user_id', user.id)
      .maybeSingle();
    if (callerResult.error) return new Response(JSON.stringify(fail(callerResult.error.message)), { status: 500, headers: CORS_HEADERS });
    callerRow = (callerResult.data as RankedRow) ?? null;
    if (callerRow && callerRow.rnk > 1) {
      const aboveResult = await admin
        .from('leaderboard_ranks')
        .select('user_id, rnk, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed')
        .eq('scope', scope)
        .eq('period_key', periodKey)
        .eq('rnk', callerRow.rnk - 1)
        .limit(1)
        .maybeSingle();
      if (!aboveResult.error) aboveRow = (aboveResult.data as RankedRow) ?? null;
    }
  }

  const totalPlayers = snapshot.data.total_players;
  if (totalPlayers === 0) {
    return new Response(
      JSON.stringify({ scope, periodLabel, totalPlayers: 0, top: [], you: null, generatedAt: snapshot.data.generated_at, nextRefreshAt: snapshot.data.next_refresh_at }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const idsNeeded = new Set(topRows.map((r) => r.user_id));
  if (callerRow) idsNeeded.add(callerRow.user_id);
  const namesResult = await admin
    .from('leaderboard_profiles')
    .select('id, display_name')
    .in('id', Array.from(idsNeeded));
  if (namesResult.error) return new Response(JSON.stringify(fail(namesResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const nameById = new Map<string, string>(namesResult.data.map((n) => [n.id, n.display_name]));

  const top = topRows.map((r) => buildEntry(r, nameById.get(r.user_id) ?? 'Unknown'));

  let you:
    | (ReturnType<typeof buildEntry> & { inTop: boolean; decidingTier: number | null; decidingTierName: string | null })
    | null = null;
  if (callerRow) {
    const entry = buildEntry(callerRow, nameById.get(user.id) ?? 'You');
    const decidingTier = callerRow.rnk === 1 ? null : aboveRow ? decidingTierIndex(callerRow, aboveRow) : null;
    you = {
      ...entry,
      inTop: callerRow.rnk <= limit,
      decidingTier,
      decidingTierName: decidingTier !== null ? TIER_NAMES[decidingTier - 1] : null,
    };
  }

  return new Response(
    JSON.stringify({ scope, periodLabel, totalPlayers, top, you, generatedAt: snapshot.data.generated_at, nextRefreshAt: snapshot.data.next_refresh_at }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});

// Fallback for a scope/period with no snapshot row yet — calls the
// original live get_leaderboard_page() RPC (unchanged, still deployed;
// supabase/migrations/20260919020000_phase12_leaderboard_scaling_fix.sql),
// same as this function's entire behavior before the 2026-09-27 rewrite.
// generatedAt/nextRefreshAt are omitted (null) — the client (leaderboard.js)
// treats a missing nextRefreshAt as "don't cache this response, and show no
// countdown," which is correct here: this data wasn't produced by the
// fixed refresh schedule, so there's no meaningful "next refresh" to count
// down to.
async function liveFallback(
  admin: ReturnType<typeof createClient>,
  scope: Scope,
  periodKey: string,
  periodLabel: string,
  callerId: string,
  limit: number
): Promise<Response> {
  const rankedResult = await admin.rpc('get_leaderboard_page', {
    p_scope: scope,
    p_period_key: periodKey,
    p_caller_id: callerId,
    p_limit: limit,
  });
  if (rankedResult.error) return new Response(JSON.stringify(fail(rankedResult.error.message)), { status: 500, headers: CORS_HEADERS });
  type LiveRow = RankedRow & { total_players: number; is_caller: boolean };
  const rows = ((rankedResult.data ?? []) as any[]).map((r) => ({
    user_id: r.out_user_id,
    rnk: r.rnk,
    max_score: r.out_max_score,
    sum_score: r.out_sum_score,
    max_time_bonus_micros: r.out_max_time_bonus_micros,
    sum_time_bonus_micros: r.out_sum_time_bonus_micros,
    sum_lives_used: r.out_sum_lives_used,
    sum_levels_played: r.out_sum_levels_played,
    attempts_started: r.out_attempts_started,
    attempts_completed: r.out_attempts_completed,
    total_players: r.total_players,
    is_caller: r.is_caller,
  })) as LiveRow[];

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ scope, periodLabel, totalPlayers: 0, top: [], you: null, generatedAt: null, nextRefreshAt: null }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const totalPlayers = rows[0].total_players;
  const namesResult = await admin.from('leaderboard_profiles').select('id, display_name').in('id', rows.map((r) => r.user_id));
  if (namesResult.error) return new Response(JSON.stringify(fail(namesResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const nameById = new Map<string, string>(namesResult.data.map((n) => [n.id, n.display_name]));

  const top = rows.filter((r) => r.rnk <= limit).map((r) => buildEntry(r, nameById.get(r.user_id) ?? 'Unknown'));
  const callerRow = rows.find((r) => r.is_caller) ?? null;
  let you:
    | (ReturnType<typeof buildEntry> & { inTop: boolean; decidingTier: number | null; decidingTierName: string | null })
    | null = null;
  if (callerRow) {
    const entry = buildEntry(callerRow, nameById.get(callerId) ?? 'You');
    const aboveRow = rows.find((r) => r.rnk === callerRow.rnk - 1) ?? null;
    const decidingTier = callerRow.rnk === 1 ? null : aboveRow ? decidingTierIndex(callerRow, aboveRow) : null;
    you = {
      ...entry,
      inTop: callerRow.rnk <= limit,
      decidingTier,
      decidingTierName: decidingTier !== null ? TIER_NAMES[decidingTier - 1] : null,
    };
  }

  return new Response(
    JSON.stringify({ scope, periodLabel, totalPlayers, top, you, generatedAt: null, nextRefreshAt: null }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
}
