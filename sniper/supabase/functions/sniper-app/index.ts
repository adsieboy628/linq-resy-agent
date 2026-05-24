// JSON API for the sniper. UI is a static HTML page served from jsdelivr
// (Supabase Edge Functions force text/plain + strict CSP, so HTML can't live here).
//
// Routes:
//   OPTIONS *                                    → CORS preflight
//   GET  /sniper-app/api/state?key=...           → snapshot
//   POST /sniper-app/api/connect?key=...         → { phone } send Resy OTP
//   POST /sniper-app/api/code?key=...            → { code } verify Resy OTP
//   POST /sniper-app/api/email?key=...           → { email } complete Resy challenge
//   POST /sniper-app/api/signout?key=...         → disconnect Resy
//   POST /sniper-app/api/watch?key=...           → { text } parse + create watch(es)
//   POST /sniper-app/api/cancel?key=...          → { id } cancel watch

import { env } from '../_shared/env.ts';
import {
  upsertChat, getCredential, setCredential, clearCredential,
  createWatch, listActiveWatches, cancelWatch, db,
} from '../_shared/db.ts';
import { sendOTP, verifyOTP, completeChallenge, type Challenge } from '../_shared/resy-auth.ts';
import { searchVenues } from '../_shared/resy.ts';
import { parseRequest } from '../_shared/parse.ts';

const WEB_CHAT_ID = 'web:owner';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-sniper-key',
  'access-control-max-age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const o = e as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.message === 'string') parts.push(o.message);
    if (typeof o.code === 'string') parts.push(`[${o.code}]`);
    if (typeof o.hint === 'string') parts.push(`hint: ${o.hint}`);
    if (typeof o.details === 'string') parts.push(o.details);
    if (parts.length) return parts.join(' ');
    return JSON.stringify(o).slice(0, 300);
  }
  return String(e);
}

async function getState() {
  const cred = await db.from('sniper_credentials').select('phone, connected_at').eq('chat_id', WEB_CHAT_ID).maybeSingle();
  const pending = await db.from('sniper_pending_otp').select('phone, claim_token, required_fields').eq('chat_id', WEB_CHAT_ID).maybeSingle();
  const watches = await listActiveWatches(WEB_CHAT_ID);
  const { data: recentAlerts } = await db.from('sniper_alerts')
    .select('id, slot_date, slot_time, outcome, venue_url, sent_at, watch_id, resy_token, failure_reason, sniper_watches(venue_name)')
    .order('sent_at', { ascending: false })
    .limit(20);
  return {
    connected: !!cred.data,
    connectedPhone: cred.data?.phone || null,
    connectedAt: cred.data?.connected_at || null,
    pendingOtp: pending.data ? { phone: pending.data.phone, needsEmail: !!pending.data.claim_token } : null,
    watches,
    recentAlerts: recentAlerts || [],
  };
}

async function handleApi(path: string, req: Request): Promise<Response> {
  await upsertChat(WEB_CHAT_ID, null, 'web');

  if (path === 'state' && req.method === 'GET') return json(await getState());

  if (path === 'connect' && req.method === 'POST') {
    const { phone } = await req.json() as { phone?: string };
    if (!phone || !phone.match(/^\+\d{6,}$/)) return json({ error: 'phone must be E.164 like +15551234567' }, 400);
    const result = await sendOTP(phone);
    if (result === 'sms') {
      await db.from('sniper_pending_otp').upsert({ chat_id: WEB_CHAT_ID, phone, claim_token: null, challenge_id: null, required_fields: null }, { onConflict: 'chat_id' });
      return json({ ok: true, message: `code sent to ${phone}` });
    }
    if (result === 'rate_limited') return json({ error: 'resy rate-limited that number. wait ~10 min.' }, 429);
    return json({ error: 'failed to send code. check the phone format.' }, 500);
  }

  if (path === 'code' && req.method === 'POST') {
    const { code } = await req.json() as { code?: string };
    if (!code) return json({ error: 'code required' }, 400);
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', WEB_CHAT_ID).maybeSingle();
    if (!pending) return json({ error: 'no pending connect — start over' }, 400);
    const result = await verifyOTP(pending.phone, code);
    if (result.kind === 'token') {
      await setCredential(WEB_CHAT_ID, result.token, pending.phone);
      await db.from('sniper_pending_otp').delete().eq('chat_id', WEB_CHAT_ID);
      return json({ ok: true, message: 'connected' });
    }
    if (result.kind === 'challenge') {
      await db.from('sniper_pending_otp').update({
        claim_token: result.challenge.claimToken,
        challenge_id: result.challenge.challengeId,
        required_fields: result.challenge.requiredFields,
      }).eq('chat_id', WEB_CHAT_ID);
      return json({ ok: true, needsEmail: true, message: 'enter the email on your resy account' });
    }
    return json({ error: result.reason }, 400);
  }

  if (path === 'email' && req.method === 'POST') {
    const { email } = await req.json() as { email?: string };
    if (!email) return json({ error: 'email required' }, 400);
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', WEB_CHAT_ID).maybeSingle();
    if (!pending?.claim_token) return json({ error: 'no pending challenge' }, 400);
    const challenge: Challenge = {
      claimToken: pending.claim_token,
      challengeId: pending.challenge_id || '',
      mobileNumber: pending.phone,
      requiredFields: pending.required_fields || [],
    };
    const token = await completeChallenge(challenge, { em_address: email });
    if (!token) return json({ error: 'challenge failed — start over' }, 400);
    await setCredential(WEB_CHAT_ID, token, pending.phone);
    await db.from('sniper_pending_otp').delete().eq('chat_id', WEB_CHAT_ID);
    return json({ ok: true, message: 'connected' });
  }

  if (path === 'signout' && req.method === 'POST') {
    await clearCredential(WEB_CHAT_ID);
    return json({ ok: true });
  }

  if (path === 'password' && req.method === 'POST') {
    // Login with Resy email + password — no SMS required.
    const { email, password } = await req.json() as { email?: string; password?: string };
    if (!email || !password) return json({ error: 'email and password required' }, 400);
    const res = await fetch('https://api.resy.com/3/auth/password', {
      method: 'POST',
      headers: {
        'authorization': `ResyAPI api_key="${env.resyApiKey}"`,
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://resy.com',
        'referer': 'https://resy.com/',
        'accept': 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({ email, password }).toString(),
    });
    if (!res.ok) {
      const body = await res.text();
      return json({ error: `resy login failed (${res.status}): ${body.slice(0, 200)}` }, 401);
    }
    // deno-lint-ignore no-explicit-any
    const data = await res.json() as Record<string, any>;
    const token = data.token || data.auth_token || data.access_token;
    if (!token) return json({ error: 'resy returned no token. response: ' + JSON.stringify(data).slice(0, 200) }, 500);
    await setCredential(WEB_CHAT_ID, token, data.mobile_number || data.em_address || email);
    return json({ ok: true, message: 'connected via password' });
  }

  if (path === 'cancel' && req.method === 'POST') {
    const { id } = await req.json() as { id?: string };
    if (!id) return json({ error: 'id required' }, 400);
    await cancelWatch(id);
    return json({ ok: true });
  }

  if (path === 'token' && req.method === 'POST') {
    // Fallback: paste an existing Resy auth token directly (advanced).
    const { token, label } = await req.json() as { token?: string; label?: string };
    if (!token || token.length < 20) return json({ error: 'token required (paste the x-resy-auth-token value from resy.com)' }, 400);
    // Verify it works by hitting /2/user
    const probeRes = await fetch('https://api.resy.com/2/user', {
      method: 'GET',
      headers: {
        'authorization': `ResyAPI api_key="${env.resyApiKey}"`,
        'x-resy-auth-token': token,
        'x-resy-universal-auth': token,
        'accept': 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0',
      },
    });
    if (!probeRes.ok) {
      const body = await probeRes.text();
      return json({ error: `token rejected by resy (${probeRes.status}): ${body.slice(0, 200)}` }, 401);
    }
    // deno-lint-ignore no-explicit-any
    const user = await probeRes.json() as Record<string, any>;
    await setCredential(WEB_CHAT_ID, token, user.mobile_number || user.em_address || label || 'pasted');
    return json({ ok: true, message: 'connected via pasted token', as: user.em_address || user.first_name || 'user' });
  }

  if (path === 'watch' && req.method === 'POST') {
    const { text } = await req.json() as { text?: string };
    if (!text?.trim()) return json({ error: 'text required' }, 400);
    const token = await getCredential(WEB_CHAT_ID);
    if (!token) return json({ error: 'not connected — click connect first' }, 401);
    const todayIso = new Date().toISOString().slice(0, 10);
    const parsed = await parseRequest(text, todayIso);
    if (!Array.isArray(parsed)) return json({ error: parsed.error }, 400);
    const created: string[] = [];
    const failed: string[] = [];
    for (const w of parsed) {
      let venues;
      try { venues = await searchVenues(token, w.venue_name); }
      catch (e) { console.error('[watch] searchVenues threw', e); failed.push(`${w.venue_name}: ${errMsg(e)}`); continue; }
      if (!venues.length) { failed.push(`${w.venue_name}: not found on resy`); continue; }
      const venue = venues[0]!;
      try {
        await createWatch({
          chat_id: WEB_CHAT_ID, raw_request: text,
          venue_name: venue.name, venue_id: venue.venue_id, venue_url: venue.url,
          date_start: w.date_start, date_end: w.date_end, party_size: w.party_size,
          time_start: w.time_start, time_end: w.time_end, auto_book: w.auto_book,
        });
        const dr = w.date_start === w.date_end ? w.date_start : `${w.date_start}…${w.date_end}`;
        created.push(`${venue.name} — ${dr}, ${w.time_start}-${w.time_end}, party ${w.party_size}${w.auto_book ? '' : ' (ping only)'}`);
      } catch (e) { console.error('[watch] createWatch threw for', w, '→', e); failed.push(`${w.venue_name}: ${errMsg(e)}`); }
    }
    return json({ ok: true, created, failed });
  }

  if (path === '_setup-ui' && req.method === 'POST') {
    // Pull the latest HTML from GitHub raw and upload to Supabase Storage.
    // Storage serves with proper text/html and no CSP injection.
    const sourceUrl = 'https://raw.githubusercontent.com/adsieboy628/linq-resy-agent/claude/sniper-v1/sniper/web/index.html';
    const htmlRes = await fetch(sourceUrl);
    if (!htmlRes.ok) return json({ error: `fetch HTML from github failed: ${htmlRes.status}` }, 500);
    const html = await htmlRes.text();

    const { data, error } = await db.storage.from('sniper-ui').upload('index.html', new Blob([html], { type: 'text/html' }), {
      upsert: true,
      contentType: 'text/html',
      cacheControl: '60',
    });
    if (error) {
      return json({ error: `storage upload failed: ${error.message}`, raw: JSON.stringify(error) }, 500);
    }
    return json({
      ok: true,
      path: data?.path,
      url: `${env.supabaseUrl}/storage/v1/object/public/sniper-ui/index.html`,
      source_bytes: html.length,
    });
  }

  return json({ error: 'not found' }, 404);
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key') || req.headers.get('x-sniper-key');
  if (key !== env.webhookSecret) {
    return new Response(JSON.stringify({ error: 'forbidden — bad or missing key' }), {
      status: 403,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Path inside the function may or may not include the /functions/v1/sniper-app prefix
  // depending on the runtime. Extract what's after /api/ as the action.
  const apiMatch = url.pathname.match(/\/api\/([^/?]+)/);
  if (apiMatch) {
    try {
      return await handleApi(apiMatch[1]!, req);
    } catch (e) {
      console.error('[sniper-app] handler error', e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // No /api/ in path — return UI pointer
  return json({
    ok: true,
    message: 'sniper API. UI is at https://raw.githack.com/adsieboy628/linq-resy-agent/claude/sniper-v1/sniper/web/index.html#key=YOUR_KEY',
  });
});
