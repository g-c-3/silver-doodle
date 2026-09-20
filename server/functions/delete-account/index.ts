// Match Emojis Daily — delete-account Edge Function (Phase 12)
//
// Google Play's User Data policy requires any app that lets a player create
// an account to also provide (a) an in-app path to delete that account and
// all associated data, and (b) a web page where deletion can be requested —
// see docs/DECISIONS.md's 2026-09-19 (later still) entry and the report-2.3
// finding this closes. This function is (a); privacy-policy.html /
// account-deletion.html is (b).
//
// Deletes the CALLER'S OWN account only — there is no adminId parameter and
// none should ever be added; this must never become a "delete any user"
// endpoint. Calls Supabase Auth's admin deleteUser API on auth.users, which
// cascades through every table that references public.users(id) with
// `on delete cascade` (verified directly against every migration this
// session, not assumed): attempts, daily_stats, weekly_stats,
// all_time_stats, user_year_activity, player_daily_order, and
// ad_verifications all go with it. Nothing is soft-deleted or deactivated —
// Play's policy explicitly requires real deletion, not a disabled/frozen
// account.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function fail(error: string) {
  return { ok: false, error };
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const anonKey = publishableKeys['default'];
  const serviceRoleKey = secretKeys['default'];
  if (!anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify(fail('SUPABASE_PUBLISHABLE_KEYS/SUPABASE_SECRET_KEYS missing a "default" entry.')), { status: 500, headers: CORS_HEADERS });
  }

  // Same pattern as every other function: the caller's own JWT proves who
  // they are. There is deliberately no way to pass a different user's id —
  // self-deletion only, by construction, not by a check that could be
  // bypassed or forgotten.
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userErr,
  } = await callerClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify(fail('Not authenticated.')), { status: 401, headers: CORS_HEADERS });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // auth.admin.deleteUser removes the auth.users row directly (not a table
  // update RLS could intercept), which is what every public.* table's
  // `on delete cascade` is actually anchored to.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
  if (deleteErr) {
    console.error(`delete-account failed for user ${user.id}: ${deleteErr.message}`);
    return new Response(JSON.stringify(fail('Account deletion failed. Please try again or contact support.')), { status: 500, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
});
