// Match Emojis Daily — admob-ssv Edge Function (Phase 10)
//
// This is Google AdMob's server-side verification (SSV) callback target,
// not something the client ever calls. AdMob's own ad-serving
// infrastructure sends a GET request here directly whenever a player
// finishes watching a rewarded ad that was requested with SSV options set
// (see client/src/js/attempt.js's playRewardedAd() — every rewarded-ad
// request in this app sets ssv.userId to the player's Supabase user id and
// ssv.customData to `${attemptId}:${slotIndex}:${type}`).
//
// This function is what makes the ad-life grant and bonus-round entry gate
// an actual score-integrity boundary rather than a client-trusted flag:
// score-replay/index.ts requires a matching row in ad_verifications before
// it will credit any level where adLifeUsed=true or isBonus=true. A
// modified client can claim whatever it wants in its own payload — without
// a row here written by *this* function, score-replay rejects the attempt.
//
// SIGNATURE VERIFICATION, per Google's documented SSV algorithm
// (https://developers.google.com/admob/ios/ssv#manual_verification_of_rewarded_ssv):
//   1. The last two query parameters of every callback are always
//      `signature` then `key_id`, in that order — everything before them is
//      the exact byte content that was signed (the raw query-string
//      substring up to, not including, `signature=`).
//   2. The signature itself is ECDSA (P-256, SHA-256), **DER-encoded**
//      (Google's own reference code verifies it with `EcdsaEncoding.DER`)
//      and then base64url-encoded for the URL.
//   3. The public key to verify against is selected by the `key_id`
//      parameter from Google's published, rotating key set at
//      https://www.gstatic.com/admob/reward/verifier-keys.json.
//
// CONFIRMED against a real signed test callback (2026-09-18, AdMob's
// "Verify callback URL" flow) that this function's FIRST version had a real
// bug here: WebCrypto's `crypto.subtle.verify({name:'ECDSA',...})` expects a
// raw, fixed-width IEEE-P1363 r‖s signature, not the DER (ASN.1 SEQUENCE of
// two INTEGERs) signature Google actually sends — every real callback was
// failing verification. derSignatureToRaw() below converts DER to the raw format
// WebCrypto needs; reproduced the exact failure and the fix locally with
// Node's crypto module (DER by default) against WebCrypto's verify before
// shipping this, rather than guessing the fix was right.
//
// verify_jwt is set to false for this function in supabase/config.toml —
// AdMob's callback carries no Supabase Authorization header at all, same
// reasoning as generate-daily-games/forfeit-stale-attempts.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

interface GoogleKey {
  keyId: number;
  base64: string; // base64 DER SPKI-encoded EC public key
}

let cachedKeys: GoogleKey[] | null = null;
let cachedKeysAt = 0;
const KEY_CACHE_MS = 60 * 60 * 1000; // Google rotates these infrequently; re-fetch hourly, not per-request.

async function getVerifierKeys(): Promise<GoogleKey[]> {
  const now = Date.now();
  if (cachedKeys && now - cachedKeysAt < KEY_CACHE_MS) return cachedKeys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`Could not fetch AdMob verifier keys: HTTP ${res.status}`);
  const json = await res.json();
  cachedKeys = json.keys as GoogleKey[];
  cachedKeysAt = now;
  return cachedKeys;
}

function base64UrlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importGoogleKey(base64Der: string): Promise<CryptoKey> {
  const der = base64UrlToUint8Array(base64Der.replace(/-/g, '+').replace(/_/g, '/'));
  return crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

// DER-encoded ECDSA signatures are an ASN.1 SEQUENCE of two INTEGERs (r and
// s), each optionally prefixed with a 0x00 padding byte when its own high
// bit is set (so it isn't misread as a negative INTEGER) — this decodes
// that structure and produces the fixed-width 64-byte raw r‖s format
// WebCrypto's ECDSA verify requires for a P-256 key (32 bytes per
// component, zero-padded on the left if DER's minimal encoding trimmed
// leading zero bytes that aren't the sign-avoidance padding byte).
function derSignatureToRaw(der: Uint8Array, componentLen = 32): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('derSignatureToRaw: expected SEQUENCE (0x30) tag.');
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  const readInteger = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new Error('derSignatureToRaw: expected INTEGER (0x02) tag.');
    let len = der[offset++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[offset++];
    }
    let bytes = der.slice(offset, offset + len);
    offset += len;
    while (bytes.length > componentLen && bytes[0] === 0x00) bytes = bytes.slice(1);
    if (bytes.length < componentLen) {
      const padded = new Uint8Array(componentLen);
      padded.set(bytes, componentLen - bytes.length);
      bytes = padded;
    }
    return bytes;
  };
  const r = readInteger();
  const s = readInteger();
  const raw = new Uint8Array(componentLen * 2);
  raw.set(r, 0);
  raw.set(s, componentLen);
  return raw;
}

async function verifySignature(keyBase64: string, message: string, signatureB64url: string): Promise<boolean> {
  const key = await importGoogleKey(keyBase64);
  const derSig = base64UrlToUint8Array(signatureB64url);
  const rawSig = derSignatureToRaw(derSig);
  const msgBytes = new TextEncoder().encode(message);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, msgBytes);
}

Deno.serve(async (req: Request) => {
  // AdMob's SSV callback is always a GET with query parameters — there is
  // no request body and no CORS concern (Google's servers call this
  // directly, never a browser).
  if (req.method !== 'GET') {
    return new Response('GET only.', { status: 405 });
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  const signature = params.get('signature');
  const keyId = params.get('key_id');
  const transactionId = params.get('transaction_id');
  const customData = params.get('custom_data');
  const userIdParam = params.get('user_id');

  if (!signature || !keyId || !transactionId) {
    console.error('admob-ssv: missing signature/key_id/transaction_id on callback.');
    return new Response('Missing required parameters.', { status: 400 });
  }

  // The signed message is the raw query string up to (not including) the
  // `signature=` parameter — per Google's documented algorithm (see file
  // header). Read directly off the request's own raw query string rather
  // than re-serializing `params`, since re-serialization could silently
  // reorder or re-encode parameters and produce a message Google never
  // actually signed.
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const sigParamIdx = rawQuery.indexOf('signature=');
  if (sigParamIdx <= 0) {
    console.error('admob-ssv: could not locate signature= in the raw query string.');
    return new Response('Malformed callback.', { status: 400 });
  }
  // Trim the trailing '&' that precedes 'signature='.
  const message = rawQuery.slice(0, sigParamIdx - 1);

  let verified = false;
  try {
    const keys = await getVerifierKeys();
    const matchingKey = keys.find((k) => String(k.keyId) === keyId);
    if (!matchingKey) {
      console.error(`admob-ssv: no verifier key found for key_id ${keyId} (keys may have rotated — cache is hourly).`);
      return new Response('Unknown key_id.', { status: 400 });
    }
    verified = await verifySignature(matchingKey.base64, message, signature);
  } catch (err) {
    console.error('admob-ssv: signature verification threw:', err);
    return new Response('Verification error.', { status: 500 });
  }

  if (!verified) {
    console.error(`admob-ssv: signature did NOT verify for transaction_id ${transactionId}.`);
    // Respond 200 regardless of verification outcome — Google's own docs
    // note AdMob doesn't retry based on this response's status, and this
    // function has already done its job either way; the important thing is
    // that a failed verification never reaches the insert below.
    return new Response('Signature invalid — not recorded.', { status: 200 });
  }

  // customData is the app's own `${attemptId}:${slotIndex}:${type}` string
  // set on the ad request (see attempt.js's playRewardedAd()) — parsed
  // here, not trusted blindly: malformed customData is rejected the same
  // as a bad signature, since score-replay's lookup depends on this
  // parsing exactly matching what was set client-side.
  const parts = (customData ?? '').split(':');
  if (parts.length !== 3 || (parts[2] !== 'life' && parts[2] !== 'bonus')) {
    console.error(`admob-ssv: malformed custom_data "${customData}" for transaction_id ${transactionId}.`);
    return new Response('Malformed custom_data.', { status: 200 });
  }
  const [attemptId, slotIndexStr, adType] = parts;
  const slotIndex = Number(slotIndexStr);
  if (!attemptId || !Number.isInteger(slotIndex) || slotIndex < 0) {
    console.error(`admob-ssv: invalid attemptId/slotIndex in custom_data "${customData}".`);
    return new Response('Malformed custom_data.', { status: 200 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const serviceRoleKey = secretKeys['default'];
  if (!serviceRoleKey) {
    console.error('admob-ssv: SUPABASE_SECRET_KEYS missing a "default" entry.');
    return new Response('Server misconfigured.', { status: 500 });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  // The attempt row is the source of truth for which user this belongs to
  // — userIdParam (echoed back from ssv.userId on the ad request) is
  // cross-checked against it rather than trusted on its own, since it's
  // just another value Google is relaying from the original ad request.
  const attemptRow = await admin.from('attempts').select('user_id').eq('id', attemptId).maybeSingle();
  if (!attemptRow.data) {
    console.error(`admob-ssv: unknown attemptId "${attemptId}" in custom_data for transaction_id ${transactionId}.`);
    return new Response('Unknown attempt.', { status: 200 });
  }
  if (userIdParam && userIdParam !== attemptRow.data.user_id) {
    console.error(`admob-ssv: user_id mismatch for attemptId "${attemptId}" (param ${userIdParam} vs attempt owner ${attemptRow.data.user_id}).`);
    return new Response('User mismatch.', { status: 200 });
  }

  const insert = await admin.from('ad_verifications').insert({
    user_id: attemptRow.data.user_id,
    attempt_id: attemptId,
    slot_index: slotIndex,
    ad_type: adType,
    transaction_id: transactionId,
  });
  if (insert.error) {
    // A duplicate transaction_id (unique constraint) is the expected,
    // harmless case of Google retrying a callback it didn't get a prompt
    // enough response to the first time — not a real error. Anything else
    // is logged for real investigation.
    if (insert.error.code === '23505') {
      return new Response('Already recorded.', { status: 200 });
    }
    console.error(`admob-ssv: insert failed for transaction_id ${transactionId}:`, insert.error.message);
    return new Response('Insert failed.', { status: 500 });
  }

  return new Response('Verified and recorded.', { status: 200 });
});
