// Match Emojis Daily — attempt-heartbeat (Phase 8)
//
// Called periodically (client/src/js/attempt.js, every ~20s) while an
// attempt is in_progress, to prove the client is still actually there.
// Bumps last_heartbeat_at on the caller's own attempts row. The forfeit
// sweep (server/functions/forfeit-stale-attempts/index.ts, a scheduled
// function) is what actually marks an attempt forfeited once its
// last_heartbeat_at falls too far behind — this endpoint only records
// liveness, it never forfeits anything itself.
//
// Deliberately accepts nothing beyond attemptId — no client-reported score
// or status, ever (Score Integrity). Returns { forfeited: true } if the
// server-side sweep already gave up on this attempt before this heartbeat
// arrived, so the client can stop treating the run as live and send the
// player home rather than letting them keep playing something that can
// never be scored.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

  let body: { attemptId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers: CORS_HEADERS });
  }
  if (!body.attemptId) {
    return new Response(JSON.stringify({ error: 'attemptId is required.' }), { status: 400, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const anonKey = publishableKeys['default'];
  const serviceRoleKey = secretKeys['default'];
  if (!anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'SUPABASE_PUBLISHABLE_KEYS/SUPABASE_SECRET_KEYS missing a "default" entry.' }), { status: 500, headers: CORS_HEADERS });
  }

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'Not authenticated.' }), { status: 401, headers: CORS_HEADERS });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Read the row's current status first, rather than blindly UPDATEing
  // WHERE status = 'in_progress' and inferring "forfeited" from a 0-row
  // match — that would also match a *normally completed* attempt (the
  // client's own submitAttempt() flow), which is not a forfeit and
  // shouldn't be reported as one to a straggler heartbeat that arrives
  // just after.
  const attemptRow = await admin
    .from('attempts')
    .select('status')
    .eq('id', body.attemptId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!attemptRow.data) {
    return new Response(JSON.stringify({ error: 'Attempt not found.' }), { status: 404, headers: CORS_HEADERS });
  }

  if (attemptRow.data.status !== 'in_progress') {
    // Either already forfeited by the sweep (real answer: yes, stop) or
    // already completed via the normal flow (not a forfeit — the client's
    // own submitAttempt() already stopped this heartbeat interval, this is
    // just a harmless straggler call).
    return new Response(
      JSON.stringify({ ok: true, forfeited: attemptRow.data.status === 'forfeited' }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const update = await admin
    .from('attempts')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', body.attemptId);
  if (update.error) {
    return new Response(JSON.stringify({ error: `Could not record heartbeat: ${update.error.message}` }), { status: 500, headers: CORS_HEADERS });
  }

  return new Response(
    JSON.stringify({ ok: true, forfeited: false }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
});
