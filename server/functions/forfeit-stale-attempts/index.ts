// Match Emojis Daily — forfeit-stale-attempts (Phase 8)
//
// Scheduled function (Supabase Dashboard → Cron, suggested every 5 minutes
// — see docs/ARCHITECTURE.md Section 8) that marks any in_progress attempt
// forfeited once its last_heartbeat_at falls more than FORFEIT_TIMEOUT_MS
// behind. This is the actual forfeit *detection* — attempt-heartbeat only
// records liveness, it never forfeits anything itself.
//
// FORFEIT_TIMEOUT_MS is deliberately generous relative to the client's
// ~20s heartbeat interval (attempt.js) — this only needs to catch a
// genuinely abandoned session (app closed/force-killed, tab reloaded), not
// a missed beat or two from real-world flakiness (brief backgrounding, a
// dropped request, a slow network).
//
// No client-reported score or status is ever trusted here (Score
// Integrity) — a forfeited attempt's score/time_bonus_micros/lives_used/
// levels_reached simply stay at their DB defaults (0), since the server
// never received any move data for it to replay in the first place. This
// also means a forfeited attempt does NOT feed record_attempt_completion —
// it already counted toward attempts_started (record_attempt_start, at
// start-attempt time), which is exactly how the leaderboard's tier-6
// "fewer attempts for the same score" cascade is supposed to work.
//
// Invoked only by Supabase's own cron scheduler (service-role context) —
// never by the client, unlike every other function in this project. No
// Authorization header or CORS handling needed as a result.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const FORFEIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — ~15x the client's heartbeat interval

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

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const serviceRoleKey = secretKeys['default'];
  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'SUPABASE_SECRET_KEYS missing a "default" entry.' }), { status: 500 });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const cutoff = new Date(Date.now() - FORFEIT_TIMEOUT_MS).toISOString();
  // score_day per Section 8: a forfeit is a completion event, scored (at 0)
  // against the day it was detected/settled, same as every other
  // completion — not the day the attempt started.
  const scoreDay = istDateString();

  const result = await admin
    .from('attempts')
    .update({ status: 'forfeited', completed_at: new Date().toISOString(), score_day: scoreDay })
    .eq('status', 'in_progress')
    .lt('last_heartbeat_at', cutoff)
    .select('id');

  if (result.error) {
    return new Response(JSON.stringify({ error: result.error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(
    JSON.stringify({ forfeited: result.data?.length ?? 0 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
