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
// WHY THE CASCADE IS DONE IN JS, NOT SQL ORDER BY: tiers 2/4/5/7 are
// per-row *averages* (sum / attempts_completed), and a >1000-player table
// sorted by a 7-expression tie-break chain (with divide-by-zero guards for
// players who started but never completed anything) is exactly the kind of
// thing that's easy to get subtly wrong in raw SQL and hard to unit-test.
// The scope tables are small (bounded by daily active players, not by
// attempts), so fetching the whole scope and sorting in Deno is cheap and
// keeps the comparator logic in one readable, testable place. Revisit if a
// scope table ever grows large enough for this to matter.
//
// RANKING FOR PLAYERS WHO NEVER COMPLETED AN ATTEMPT: max_score defaults to
// 0, so a player with attempts_started > 0 but attempts_completed === 0
// still appears (tied at the bottom on tier 1 with anyone else at 0), but
// their average tiers (2/4/5/7, all undefined with a 0 divisor) are treated
// as the worst possible value for that tier's direction so they always lose
// any tie-break reached that far — see `AVERAGE_SENTINEL` below.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Scope = 'daily' | 'weekly' | 'all-time';

interface StatsRow {
  user_id: string;
  max_score: number;
  sum_score: number;
  max_time_bonus_micros: number;
  sum_time_bonus_micros: number;
  sum_lives_used: number;
  sum_levels_played: number;
  attempts_started: number;
  attempts_completed: number;
}

// One entry per cascade tier, in priority order (ARCHITECTURE.md Section 7).
// `dir: 'desc'` = higher wins; `dir: 'asc'` = lower wins.
// `value(row)` returns the comparable number for that tier, already
// carrying the divide-by-zero guard for the four average tiers.
const TIERS: {
  name: string;
  dir: 'asc' | 'desc';
  value: (r: StatsRow) => number;
}[] = [
  { name: 'Highest single-attempt score', dir: 'desc', value: (r) => r.max_score },
  { name: 'Average score', dir: 'desc', value: (r) => average(r.sum_score, r.attempts_completed, 'desc') },
  { name: 'Highest single-attempt time bonus', dir: 'desc', value: (r) => r.max_time_bonus_micros },
  { name: 'Average time bonus', dir: 'desc', value: (r) => average(r.sum_time_bonus_micros, r.attempts_completed, 'desc') },
  { name: 'Average lives used (fewer is better)', dir: 'asc', value: (r) => average(r.sum_lives_used, r.attempts_completed, 'asc') },
  { name: 'Attempts played (fewer is better)', dir: 'asc', value: (r) => r.attempts_started },
  { name: 'Average levels played (fewer is better)', dir: 'asc', value: (r) => average(r.sum_levels_played, r.attempts_completed, 'asc') },
];

// A player who never completed an attempt has no meaningful average for
// this tier — sentinel it to the direction's own worst value so they always
// lose the tie-break rather than the comparator dividing by zero or two
// zero-attempt players comparing as "equal" on a tier that's actually
// undefined for both.
function average(sum: number, count: number, dir: 'asc' | 'desc'): number {
  if (count <= 0) return dir === 'desc' ? -Infinity : Infinity;
  return sum / count;
}

function compareRows(a: StatsRow, b: StatsRow): number {
  for (const tier of TIERS) {
    const av = tier.value(a);
    const bv = tier.value(b);
    if (av === bv) continue;
    return tier.dir === 'desc' ? bv - av : av - bv;
  }
  return 0; // fully tied across all 7 tiers — stable order is fine here
}

// First tier (1-indexed) at which `row` and `betterRow` actually differ —
// i.e. what decided `row` not outranking the player directly above it.
function decidingTierIndex(row: StatsRow, betterRow: StatsRow): number {
  for (let i = 0; i < TIERS.length; i++) {
    if (TIERS[i].value(row) !== TIERS[i].value(betterRow)) return i + 1;
  }
  return TIERS.length; // identical on every tier but ordered by insertion — shouldn't normally happen
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

function buildEntry(row: StatsRow, rank: number, displayName: string) {
  return {
    rank,
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
  let rows: StatsRow[];

  if (scope === 'daily') {
    const statDate = body.date ?? today;
    periodLabel = statDate;
    const result = await admin
      .from('daily_stats')
      .select('user_id, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed')
      .eq('stat_date', statDate);
    if (result.error) return new Response(JSON.stringify(fail(result.error.message)), { status: 500, headers: CORS_HEADERS });
    rows = result.data as StatsRow[];
  } else if (scope === 'weekly') {
    const weekStart = mondayOfWeek(body.date ?? today);
    periodLabel = weekStart;
    const result = await admin
      .from('weekly_stats')
      .select('user_id, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed')
      .eq('week_start', weekStart);
    if (result.error) return new Response(JSON.stringify(fail(result.error.message)), { status: 500, headers: CORS_HEADERS });
    rows = result.data as StatsRow[];
  } else {
    periodLabel = 'all-time';
    const result = await admin
      .from('all_time_stats')
      .select('user_id, max_score, sum_score, max_time_bonus_micros, sum_time_bonus_micros, sum_lives_used, sum_levels_played, attempts_started, attempts_completed');
    if (result.error) return new Response(JSON.stringify(fail(result.error.message)), { status: 500, headers: CORS_HEADERS });
    rows = result.data as StatsRow[];
  }

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ scope, periodLabel, totalPlayers: 0, top: [], you: null }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  rows.sort(compareRows);

  // Display names, batched in one query rather than N+1 — leaderboard_profiles
  // is the RLS-safe public view (id, display_name only, no email).
  const namesResult = await admin
    .from('leaderboard_profiles')
    .select('id, display_name')
    .in('id', rows.map((r) => r.user_id));
  if (namesResult.error) return new Response(JSON.stringify(fail(namesResult.error.message)), { status: 500, headers: CORS_HEADERS });
  const nameById = new Map<string, string>(namesResult.data.map((n) => [n.id, n.display_name]));

  const top = rows.slice(0, limit).map((r, i) => buildEntry(r, i + 1, nameById.get(r.user_id) ?? 'Unknown'));

  const callerIndex = rows.findIndex((r) => r.user_id === user.id);
  let you: ReturnType<typeof buildEntry> & { inTop: boolean; decidingTier: number | null; decidingTierName: string | null } | null = null;
  if (callerIndex !== -1) {
    const rank = callerIndex + 1;
    const entry = buildEntry(rows[callerIndex], rank, nameById.get(user.id) ?? 'You');
    const decidingTier = callerIndex === 0 ? null : decidingTierIndex(rows[callerIndex], rows[callerIndex - 1]);
    you = {
      ...entry,
      inTop: rank <= limit,
      decidingTier,
      decidingTierName: decidingTier !== null ? TIERS[decidingTier - 1].name : null,
    };
  }

  return new Response(
    JSON.stringify({ scope, periodLabel, totalPlayers: rows.length, top, you }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});
