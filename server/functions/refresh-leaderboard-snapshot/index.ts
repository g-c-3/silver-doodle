// Match Emojis Daily — refresh-leaderboard-snapshot
//
// Scheduled function (Supabase Dashboard → Edge Functions → this function →
// Cron — manual one-time setup, same pattern as generate-daily-games and
// the original forfeit-stale-attempts). Suggested schedule: every 3 hours,
// on the 8 fixed IST boundaries the product wants (12am/3/6/9am/12pm/3/6/9pm
// IST) — see the exact UTC cron expression in docs/SESSIONS.md's setup
// notes for this session, since IST has no DST and the offset is constant.
//
// Refreshes ONLY the 'daily' scope, via refresh_leaderboard_snapshot()
// (supabase/migrations/20260927010000_leaderboard_snapshot_caching.sql).
// 'weekly' and 'all-time' only need refreshing once a day and are handled
// by generate-daily-games' existing once-daily cron run instead, rather
// than standing up a second scheduled function for a once-a-day job — see
// that file's own comment. This function running at the same midnight IST
// instant generate-daily-games also refreshes 'daily' is intentional, not
// a bug: two scopes, one shared boundary, nothing gained by trying to skip
// one of them at that exact slot.
//
// Requires CRON_SECRET (x-cron-secret header) — same shared secret already
// set up for generate-daily-games (docs/DECISIONS.md's 2026-09-19 entry),
// reused here rather than minting a second one.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const REFRESH_HOURS_IST = [0, 3, 6, 9, 12, 15, 18, 21]; // the 8 fixed daily boundaries, product decision

function istDateString(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The next of the 8 fixed IST boundaries strictly after `now`, as a UTC
// instant. IST is a fixed UTC+5:30 offset (no DST) — safe as constant
// string-built Dates, same technique used throughout this codebase
// (start-attempt's istDayBoundsUtc(), generate-daily-games' istDayStartUtc()).
function nextRefreshAtUtc(now: Date): string {
  const todayIst = istDateString(now);
  for (const hour of REFRESH_HOURS_IST) {
    const candidate = new Date(`${todayIst}T${String(hour).padStart(2, '0')}:00:00+05:30`);
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  // Past 9pm IST — the next boundary is tomorrow's midnight.
  const tomorrow = new Date(new Date(`${todayIst}T00:00:00+05:30`).getTime() + 86_400_000);
  const tomorrowIst = istDateString(tomorrow);
  return new Date(`${tomorrowIst}T00:00:00+05:30`).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only.' }), { status: 405, headers: CORS_HEADERS });
  }

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'Forbidden.' }), { status: 403, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const serviceRoleKey = secretKeys['default'];
  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ ok: false, error: 'SUPABASE_SECRET_KEYS missing a "default" entry.' }), { status: 500, headers: CORS_HEADERS });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const now = new Date();
  const periodKey = istDateString(now);
  const nextRefreshAt = nextRefreshAtUtc(now);

  const result = await admin.rpc('refresh_leaderboard_snapshot', {
    p_scope: 'daily',
    p_period_key: periodKey,
    p_next_refresh_at: nextRefreshAt,
  });
  if (result.error) {
    console.error(`refresh-leaderboard-snapshot (daily, ${periodKey}) failed: ${result.error.message}`);
    return new Response(JSON.stringify({ ok: false, error: result.error.message }), { status: 500, headers: CORS_HEADERS });
  }

  return new Response(
    JSON.stringify({ ok: true, scope: 'daily', periodKey, totalPlayers: result.data, nextRefreshAt }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});
