// Match Emojis Daily — leaderboard Edge Function (Phase 7)
//
// Reads the daily_stats/weekly_stats/all_time_stats rows populated by
// start-attempt's record_attempt_start and score-replay's
// record_attempt_completion (see this session's migration:
// supabase/migrations/20260914020000_phase7_stats_functions.sql), applies
// the 7-tier cascade from docs/ARCHITECTURE.md Section 7, and returns a
// ranked top-N list plus the caller's own rank and a breakdown of which
// tier decided it.
//
// Accepts POST { scope: 'daily' | 'weekly' | 'all-time', date?: string,
// limit?: number }. `date` (YYYY-MM-DD, IST calendar date) only applies to
// 'daily' and 'weekly' scopes — daily uses it directly, weekly resolves it
// to that date's Monday-start week. Both default to "now, in IST" if
// omitted. `limit` defaults to 50, capped at 200.
//
// SECURITY FIX (2026-09-19, §5.9): the cascade used to be sorted here in
// JS, over the ENTIRE scope table fetched via PostgREST — see
// docs/DECISIONS.md's 2026-09-19 (later still) entry for why that broke at
// scale (PostgREST's 1,000-row cap silently truncating the sort input,
// and a display-name lookup that put every single user id into one
// request URL). The cascade itself — same 7 tiers, same tie-break order,
// same divide-by-zero handling for players with zero completed attempts —
// now lives in the get_leaderboard_page() SQL function
// (supabase/migrations/20260919020000_phase12_leaderboard_scaling_fix.sql)
// so it runs once, in Postgres, over an indexed sort, and only the rows
// this function actually needs (top N + the caller's own row) ever cross
// the wire. The comparator/tier logic that used to live in this file
// (TIERS, compareRows, average()) is gone — this file's job now is just to
// call that RPC and shape its result into the same response JSON as
// before, so nothing about the CLIENT'S contract with this function
// changed.
//
// RANKING FOR PLAYERS WHO NEVER COMPLETED AN ATTEMPT: max_score defaults to
// 0, so a player with attempts_started > 0 but attempts_completed === 0
// still appears (tied at the bottom on tier 1 with anyone else at 0), but
// their average tiers (2/4/5/7, NULL via NULLIF in SQL now rather than
// undefined in JS) sort as the worst possible value for that tier's
// direction via NULLS LAST — see the migration's own comment for why that
// single rule covers both ASC and DESC tiers.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Scope = 'daily' | 'weekly' | 'all-time';

// One row of get_leaderboard_page()'s result — every column is prefixed
// out_* to dodge PL/pgSQL's "ambiguous column reference" error against the
// source tables' own column names AND against the function's own OUT
// parameters (RETURNS TABLE implicitly declares a PL/pgSQL variable per
// column, so an unprefixed working name anywhere in the function body can
// collide with its own output column — this bit the original migration
// once already: 2026-09-21, see docs/DECISIONS.md).
interface RankedRow {
  out_user_id: string;
  out_rnk: number;
  out_max_score: number;
  out_sum_score: number;
  out_max_time_bonus_micros: number;
  out_sum_time_bonus_micros: number;
  out_sum_lives_used: number;
  out_sum_levels_played: number;
  out_attempts_started: number;
  out_attempts_completed: number;
  total_players: number;
  is_caller: boolean;
}

// Tier names only — used purely for the human-readable decidingTierName in
// the response. The actual comparison logic lives in the SQL function now;
// this list's ORDER must still match it exactly, since decidingTierIndex()
// below re-derives which tier decided a tie by comparing the same raw
// values the SQL function already ranked by.
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

// First tier (1-indexed) at which two adjacent ranked rows actually
// differ — i.e. what decided `row` not sharing `betterRow`'s rank. Only
// ever called on the caller's row against the row directly above it (two
// rows, not the whole table), so re-deriving the 7 tier values here in JS
// is cheap and doesn't reintroduce the scaling problem this fix addresses.
function decidingTierIndex(row: RankedRow, betterRow: RankedRow): number {
  const tierValues = (r: RankedRow): (number | null)[] => [
    r.out_max_score,
    average(r.out_sum_score, r.out_attempts_completed),
    r.out_max_time_bonus_micros,
    average(r.out_sum_time_bonus_micros, r.out_attempts_completed),
    average(r.out_sum_lives_used, r.out_attempts_completed),
    r.out_attempts_started,
    average(r.out_sum_levels_played, r.out_attempts_completed),
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
// week_start_ist() (date_trunc('week', ...) is Monday-first by default).
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
    rank: row.out_rnk,
    userId: row.out_user_id,
    displayName,
    score: row.out_max_score,
    avgScore: row.out_attempts_completed > 0 ? Math.round(row.out_sum_score / row.out_attempts_completed) : null,
    timeBonusMicros: row.out_max_time_bonus_micros,
    avgTimeBonusMicros: row.out_attempts_completed > 0 ? Math.round(row.out_sum_time_bonus_micros / row.out_attempts_completed) : null,
    avgLivesUsed: row.out_attempts_completed > 0 ? Number((row.out_sum_lives_used / row.out_attempts_completed).toFixed(2)) : null,
    attemptsPlayed: row.out_attempts_started,
    avgLevelsPlayed: row.out_attempts_completed > 0 ? Number((row.out_sum_levels_played / row.out_attempts_completed).toFixed(2)) : null,
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
  let periodKey: string; // date sent to get_leaderboard_page; 'all-time' ignores it but the RPC signature still requires one

  if (scope === 'daily') {
    periodKey = body.date ?? today;
    periodLabel = periodKey;
  } else if (scope === 'weekly') {
    periodKey = mondayOfWeek(body.date ?? today);
    periodLabel = periodKey;
  } else {
    periodKey = today; // unused by the SQL function's 'all-time' branch, but the parameter is not nullable
    periodLabel = 'all-time';
  }

  // SECURITY FIX (2026-09-19, §5.9): single RPC call replaces the old
  // fetch-everything-then-sort-in-JS approach. get_leaderboard_page does
  // the 7-tier ranking in SQL and returns ONLY the top `limit` rows plus
  // the caller's own row (and, if the caller is outside the top `limit`,
  // the row directly above them, so decidingTier stays accurate) — never
  // the whole scope table.
  const rankedResult = await admin.rpc('get_leaderboard_page', {
    p_scope: scope,
    p_period_key: periodKey,
    p_caller_id: user.id,
    p_limit: limit,
  });
  if (rankedResult.error) return new Response(JSON.stringify(fail(rankedResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const rankedRows = (rankedResult.data ?? []) as RankedRow[];

  if (rankedRows.length === 0) {
    return new Response(
      JSON.stringify({ scope, periodLabel, totalPlayers: 0, top: [], you: null }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const totalPlayers = rankedRows[0].total_players;

  // Display names for exactly the rows returned above (top N + caller +
  // maybe one extra row for decidingTier) — never more than ~limit+2 ids,
  // so this can never approach the URL-length problem §5.9 found: the old
  // code put every single player in the scope into this same query.
  const namesResult = await admin
    .from('leaderboard_profiles')
    .select('id, display_name')
    .in('id', rankedRows.map((r) => r.out_user_id));
  if (namesResult.error) return new Response(JSON.stringify(fail(namesResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const nameById = new Map<string, string>(namesResult.data.map((n) => [n.id, n.display_name]));

  // The RPC can return one extra row (the caller's decidingTier reference
  // row, out_rnk = callerRank - 1) when the caller is outside the top
  // `limit` — exclude it from the public top list, it was only fetched for
  // the comparison below.
  const top = rankedRows
    .filter((r) => r.out_rnk <= limit)
    .map((r) => buildEntry(r, nameById.get(r.out_user_id) ?? 'Unknown'));

  const callerRow = rankedRows.find((r) => r.is_caller);
  let you: ReturnType<typeof buildEntry> & { inTop: boolean; decidingTier: number | null; decidingTierName: string | null } | null = null;
  if (callerRow) {
    const entry = buildEntry(callerRow, nameById.get(user.id) ?? 'You');
    const aboveRow = rankedRows.find((r) => r.out_rnk === callerRow.out_rnk - 1);
    const decidingTier = callerRow.out_rnk === 1 ? null : aboveRow ? decidingTierIndex(callerRow, aboveRow) : null;
    you = {
      ...entry,
      inTop: callerRow.out_rnk <= limit,
      decidingTier,
      decidingTierName: decidingTier !== null ? TIER_NAMES[decidingTier - 1] : null,
    };
  }

  return new Response(
    JSON.stringify({ scope, periodLabel, totalPlayers, top, you }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});
