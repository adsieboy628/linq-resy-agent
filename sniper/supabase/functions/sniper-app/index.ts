// Single-page web app for the sniper. Replaces Twilio SMS entirely.
//
// Auth model (personal-use, single user):
//   - All requests require ?key=<SNIPER_WEBHOOK_SECRET> in the URL
//   - The bookmark on Adam's phone holds the secret in the URL — never shared
//   - The HTML page reads the key from window.location and includes it in every fetch
//
// Routes (all on this one function):
//   GET  /sniper-app?key=...                     → HTML dashboard
//   POST /sniper-app/api/connect?key=...         → { phone } send Resy OTP
//   POST /sniper-app/api/code?key=...            → { code } verify Resy OTP
//   POST /sniper-app/api/email?key=...           → { email } complete Resy challenge
//   POST /sniper-app/api/signout?key=...         → disconnect Resy
//   POST /sniper-app/api/watch?key=...           → { text } parse + create watch(es)
//   POST /sniper-app/api/cancel?key=...          → { id } cancel watch
//   GET  /sniper-app/api/state?key=...           → JSON snapshot for dashboard polling

import { env } from '../_shared/env.ts';
import {
  upsertChat, getCredential, setCredential, clearCredential,
  createWatch, listActiveWatches, cancelWatch, db,
} from '../_shared/db.ts';
import { sendOTP, verifyOTP, completeChallenge, type Challenge } from '../_shared/resy-auth.ts';
import { searchVenues } from '../_shared/resy.ts';
import { parseRequest } from '../_shared/parse.ts';

// Single fixed chat_id for the single-user web app
const WEB_CHAT_ID = 'web:owner';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function getState() {
  const cred = await db.from('sniper_credentials').select('phone, connected_at').eq('chat_id', WEB_CHAT_ID).maybeSingle();
  const pending = await db.from('sniper_pending_otp').select('phone, claim_token, required_fields').eq('chat_id', WEB_CHAT_ID).maybeSingle();
  const watches = await listActiveWatches(WEB_CHAT_ID);
  const { data: recentAlerts } = await db.from('sniper_alerts')
    .select('id, slot_date, slot_time, outcome, venue_url, sent_at, watch_id, resy_token, failure_reason, sniper_watches(venue_name)')
    .order('sent_at', { ascending: false })
    .limit(20);
  const { data: doneWatches } = await db.from('sniper_watches')
    .select('id, venue_name, status, booked_at, matched_at, resy_token, venue_url')
    .eq('chat_id', WEB_CHAT_ID)
    .in('status', ['booked', 'matched', 'cancelled', 'expired'])
    .order('booked_at', { ascending: false, nullsFirst: false })
    .limit(20);
  return {
    connected: !!cred.data,
    connectedPhone: cred.data?.phone || null,
    connectedAt: cred.data?.connected_at || null,
    pendingOtp: pending.data ? { phone: pending.data.phone, needsEmail: !!pending.data.claim_token } : null,
    watches,
    recentAlerts: recentAlerts || [],
    doneWatches: doneWatches || [],
  };
}

async function handleApi(path: string, req: Request): Promise<Response> {
  await upsertChat(WEB_CHAT_ID, null, 'web');

  if (path === 'state' && req.method === 'GET') {
    return json(await getState());
  }

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
    if (!pending) return json({ error: 'no pending /connect — start over' }, 400);
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
      catch (e) { failed.push(`${w.venue_name}: ${e instanceof Error ? e.message : String(e)}`); continue; }
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
      } catch (e) {
        failed.push(`${w.venue_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return json({ ok: true, created, failed });
  }

  if (path === 'cancel' && req.method === 'POST') {
    const { id } = await req.json() as { id?: string };
    if (!id) return json({ error: 'id required' }, 400);
    await cancelWatch(id);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Sniper">
<title>resy sniper</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #666; --line: #e5e5e5; --accent: #d62828; --ok: #1a7f1a; --card: #fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0b; --fg: #f0f0f0; --muted: #888; --line: #222; --card: #1a1a1a; } }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; margin: 0; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); max-width: 640px; margin-inline: auto; background: var(--bg); color: var(--fg); }
  h1 { font-size: 22px; margin: 16px 0 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 24px 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  textarea, input { width: 100%; font: inherit; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); }
  textarea { min-height: 88px; resize: vertical; }
  button { font: inherit; padding: 12px 16px; border: 0; border-radius: 10px; background: var(--accent); color: white; font-weight: 600; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button.tiny { padding: 6px 10px; font-size: 13px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: center; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .card { background: var(--card); border-radius: 12px; padding: 12px 14px; }
  .toast { position: fixed; left: 16px; right: 16px; bottom: 16px; background: var(--fg); color: var(--bg); padding: 12px 14px; border-radius: 10px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 608px; margin-inline: auto; }
  .toast.show { opacity: 1; }
  .toast.error { background: var(--accent); color: white; }
  .pill { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--line); color: var(--muted); }
  .pill.ok { background: var(--ok); color: white; }
  .pill.book { background: var(--accent); color: white; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 8px 0; border-bottom: 1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  a { color: var(--accent); }
  .small { font-size: 13px; }
  .right { margin-left: auto; }
</style>
</head>
<body>
<h1>resy sniper</h1>
<div class="muted small" id="header-status">loading…</div>

<div id="connect-section" hidden>
  <h2>connect resy</h2>
  <div id="connect-step-phone" class="stack">
    <input id="phone-input" type="tel" placeholder="+15551234567" autocomplete="off">
    <button id="connect-btn">send code</button>
    <div class="muted small">resy will text you a 6-digit code. paste it in next.</div>
  </div>
  <div id="connect-step-code" class="stack" hidden>
    <input id="code-input" type="text" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code">
    <button id="code-btn">verify</button>
  </div>
  <div id="connect-step-email" class="stack" hidden>
    <input id="email-input" type="email" placeholder="you@example.com" autocomplete="email">
    <button id="email-btn">confirm</button>
    <div class="muted small">resy is asking for the email on your account.</div>
  </div>
</div>

<div id="main-section" hidden>
  <h2>add a watch</h2>
  <div class="stack">
    <textarea id="watch-text" placeholder='e.g. "watch I Sodi Sat Jun 14 6-9:30 for 3" — or list several at once'></textarea>
    <button id="watch-btn">add</button>
    <div class="muted small">auto-books by default. add "no book" anywhere to opt out.</div>
  </div>

  <h2>active watches <span id="active-count" class="muted"></span></h2>
  <ul id="active-list"></ul>

  <h2>recent activity</h2>
  <ul id="activity-list"></ul>

  <h2 class="muted">account</h2>
  <div class="row">
    <span class="muted small" id="account-phone"></span>
    <button class="secondary tiny right" id="signout-btn">sign out</button>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const params = new URLSearchParams(location.search);
const KEY = params.get('key') || '';
if (!KEY) document.body.innerHTML = '<h1>missing ?key= in URL</h1><p class="muted">bookmark the URL i gave you, including the key.</p>';

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, error = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', error);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

async function api(path, body) {
  const init = { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {} };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(\`./sniper-app/api/\${path}?key=\${encodeURIComponent(KEY)}\`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || \`http \${res.status}\`);
  return data;
}

function fmt(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function show(id, visible = true) { document.getElementById(id).hidden = !visible; }

async function refresh() {
  try {
    const s = await api('state');
    const headerEl = document.getElementById('header-status');
    if (!s.connected) {
      headerEl.textContent = 'not connected to resy.';
      show('connect-section', true);
      show('main-section', false);
      if (s.pendingOtp) {
        document.getElementById('phone-input').value = s.pendingOtp.phone;
        show('connect-step-phone', false);
        if (s.pendingOtp.needsEmail) { show('connect-step-code', false); show('connect-step-email', true); }
        else show('connect-step-code', true);
      }
    } else {
      headerEl.textContent = \`connected as \${s.connectedPhone} since \${fmt(s.connectedAt)}\`;
      show('connect-section', false);
      show('main-section', true);
      document.getElementById('account-phone').textContent = s.connectedPhone || '';

      const active = document.getElementById('active-list');
      document.getElementById('active-count').textContent = s.watches.length ? \`(\${s.watches.length})\` : '';
      if (!s.watches.length) active.innerHTML = '<li class="muted">no active watches.</li>';
      else active.innerHTML = s.watches.map(w => {
        const dr = w.date_start === w.date_end ? w.date_start : \`\${w.date_start}…\${w.date_end}\`;
        const auto = w.auto_book ? '<span class="pill book">auto-book</span>' : '<span class="pill">ping only</span>';
        const last = w.last_polled_at ? \`<span class="muted small">polled \${fmt(w.last_polled_at)}</span>\` : '<span class="muted small">not polled yet</span>';
        return \`<li>
          <div class="row"><strong>\${w.venue_name}</strong> \${auto}<button class="secondary tiny right" data-cancel="\${w.id}">cancel</button></div>
          <div class="small muted">\${dr} · \${w.time_start.slice(0,5)}-\${w.time_end.slice(0,5)} · party \${w.party_size}</div>
          <div>\${last}</div>
        </li>\`;
      }).join('');
      active.querySelectorAll('[data-cancel]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('cancel this watch?')) return;
          await api('cancel', { id: btn.dataset.cancel });
          toast('cancelled');
          refresh();
        });
      });

      const events = [];
      for (const a of s.recentAlerts) {
        const venue = a.sniper_watches?.venue_name || 'venue';
        const label = a.outcome === 'booked' ? 'BOOKED' : a.outcome === 'book_failed' ? 'book failed' : 'slot found';
        const pill = a.outcome === 'booked' ? 'pill ok' : a.outcome === 'book_failed' ? 'pill book' : 'pill';
        events.push({ when: a.sent_at, html: \`<li><span class="\${pill}">\${label}</span> <strong>\${venue}</strong> <span class="muted small">— \${a.slot_date} \${a.slot_time.slice(0,5)} · \${fmt(a.sent_at)}</span>\${a.venue_url ? \` <a href="\${a.venue_url}" target="_blank">resy →</a>\` : ''}\${a.failure_reason ? \` <div class="small muted">\${a.failure_reason}</div>\` : ''}</li>\` });
      }
      events.sort((x, y) => (y.when || '').localeCompare(x.when || ''));
      const activity = document.getElementById('activity-list');
      activity.innerHTML = events.length ? events.slice(0, 15).map(e => e.html).join('') : '<li class="muted">no activity yet. add a watch above.</li>';
    }
  } catch (e) {
    toast(\`error: \${e.message}\`, true);
  }
}

document.getElementById('connect-btn')?.addEventListener('click', async () => {
  const phone = document.getElementById('phone-input').value.trim();
  try { await api('connect', { phone }); toast('code sent — check resy SMS'); refresh(); }
  catch (e) { toast(e.message, true); }
});

document.getElementById('code-btn')?.addEventListener('click', async () => {
  const code = document.getElementById('code-input').value.trim();
  try {
    const r = await api('code', { code });
    if (r.needsEmail) { show('connect-step-code', false); show('connect-step-email', true); toast('one more step — enter your email'); }
    else { toast('connected'); refresh(); }
  } catch (e) { toast(e.message, true); }
});

document.getElementById('email-btn')?.addEventListener('click', async () => {
  const email = document.getElementById('email-input').value.trim();
  try { await api('email', { email }); toast('connected'); refresh(); }
  catch (e) { toast(e.message, true); }
});

document.getElementById('watch-btn')?.addEventListener('click', async () => {
  const text = document.getElementById('watch-text').value.trim();
  if (!text) return;
  const btn = document.getElementById('watch-btn');
  btn.disabled = true; btn.textContent = 'parsing…';
  try {
    const r = await api('watch', { text });
    const parts = [];
    if (r.created?.length) parts.push(\`added \${r.created.length}\`);
    if (r.failed?.length) parts.push(\`\${r.failed.length} failed: \${r.failed[0]}\`);
    toast(parts.join(' · '));
    if (r.created?.length) document.getElementById('watch-text').value = '';
    refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'add'; }
});

document.getElementById('signout-btn')?.addEventListener('click', async () => {
  if (!confirm('disconnect resy?')) return;
  await api('signout');
  toast('signed out');
  refresh();
});

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Authn for everything
  const key = url.searchParams.get('key') || req.headers.get('x-sniper-key');
  if (key !== env.webhookSecret) {
    return new Response('Forbidden — append ?key=<your_secret> to the URL', { status: 403 });
  }

  // Routes: /sniper-app (HTML) or /sniper-app/api/<path>
  const parts = url.pathname.split('/').filter(Boolean);
  // parts[0] = 'functions', parts[1] = 'v1', parts[2] = 'sniper-app', parts[3...] = subpath
  const sub = parts.slice(3);

  if (sub.length === 0) {
    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (sub[0] === 'api' && sub.length === 2) {
    try {
      return await handleApi(sub[1]!, req);
    } catch (e) {
      console.error('[sniper-app] handler error', e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return new Response('Not found', { status: 404 });
});
