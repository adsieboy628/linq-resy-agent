// Twilio webhook receiver. Auth: shared secret as `?secret=...` query param.
// Twilio sends application/x-www-form-urlencoded with fields: From, To, Body, MessageSid, etc.

import { env } from '../_shared/env.ts';
import {
  upsertChat, getCredential, setCredential, clearCredential,
  createWatch, listActiveWatches, cancelWatch, db,
} from '../_shared/db.ts';
import { sendSMS } from '../_shared/twilio.ts';
import { sendOTP, verifyOTP, completeChallenge, type Challenge } from '../_shared/resy-auth.ts';
import { searchVenues } from '../_shared/resy.ts';
import { parseRequest } from '../_shared/parse.ts';

function isOwner(handle: string): boolean {
  return env.ownerHandles.includes(handle);
}

const HELP = `commands:
/connect +15551234567 — connect resy (sends sms code)
/code 123456 — verify the code
/email you@x.com — provide email if challenged after /code
/list — show active watches
/cancel N — cancel watch N from /list
/signout — disconnect resy

or just text what you want:
"watch I Sodi Saturday June 14 6-9:30 for 3"

auto-books by default. add "no book" or "just ping" to opt out per request.`;

async function handleMessage(from: string, text: string): Promise<void> {
  // chat_id = from phone (one row per number for SMS)
  const chatId = from;
  await upsertChat(chatId, from, 'sms');

  const cmd = text.trim();
  const lower = cmd.toLowerCase();

  // Twilio compliance: STOP / HELP / START / UNSTOP
  if (lower === 'stop' || lower === 'stopall' || lower === 'unsubscribe' || lower === 'cancel' || lower === 'end' || lower === 'quit') {
    // Twilio auto-handles STOP (blocks future messages from this number).
    return;
  }
  if (lower === 'help') {
    await sendSMS(from, HELP);
    return;
  }
  if (lower === 'start' || lower === 'unstop') {
    await sendSMS(from, 'resy sniper. text /help for commands.');
    return;
  }

  if (lower === '/help') {
    await sendSMS(from, HELP);
    return;
  }

  // /connect <phone>
  if (lower.startsWith('/connect')) {
    const phone = cmd.split(/\s+/)[1];
    if (!phone || !phone.match(/^\+\d{6,}$/)) {
      await sendSMS(from, 'usage: /connect +15551234567');
      return;
    }
    const result = await sendOTP(phone);
    if (result === 'sms') {
      await db.from('sniper_pending_otp').upsert({ chat_id: chatId, phone }, { onConflict: 'chat_id' });
      await sendSMS(from, `code sent to ${phone}. reply: /code 123456`);
    } else if (result === 'rate_limited') {
      await sendSMS(from, 'resy rate-limited that number. wait 10 min.');
    } else {
      await sendSMS(from, 'failed to send code. check the number format.');
    }
    return;
  }

  // /code <code>
  if (lower.startsWith('/code')) {
    const code = cmd.split(/\s+/)[1];
    if (!code) { await sendSMS(from, 'usage: /code 123456'); return; }
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', chatId).maybeSingle();
    if (!pending) { await sendSMS(from, 'no pending /connect — run /connect first'); return; }
    const result = await verifyOTP(pending.phone, code);
    if (result.kind === 'token') {
      await setCredential(chatId, result.token, pending.phone);
      await db.from('sniper_pending_otp').delete().eq('chat_id', chatId);
      await sendSMS(from, "connected. you're ready. text me a request or /help.");
    } else if (result.kind === 'challenge') {
      await db.from('sniper_pending_otp').update({
        claim_token: result.challenge.claimToken,
        challenge_id: result.challenge.challengeId,
        required_fields: result.challenge.requiredFields,
      }).eq('chat_id', chatId);
      const needs = result.challenge.requiredFields.map(f => f.name).join(', ');
      await sendSMS(from, `code accepted. need: ${needs}. reply: /email you@example.com`);
    } else {
      await sendSMS(from, `verify failed: ${result.reason}. try /connect again.`);
    }
    return;
  }

  // /email <email>
  if (lower.startsWith('/email')) {
    const email = cmd.split(/\s+/)[1];
    if (!email) { await sendSMS(from, 'usage: /email you@example.com'); return; }
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', chatId).maybeSingle();
    if (!pending?.claim_token) { await sendSMS(from, 'no pending challenge — run /connect then /code first'); return; }
    const challenge: Challenge = {
      claimToken: pending.claim_token,
      challengeId: pending.challenge_id || '',
      mobileNumber: pending.phone,
      requiredFields: pending.required_fields || [],
    };
    const token = await completeChallenge(challenge, { em_address: email });
    if (!token) { await sendSMS(from, 'challenge failed. try /connect again from scratch.'); return; }
    await setCredential(chatId, token, pending.phone);
    await db.from('sniper_pending_otp').delete().eq('chat_id', chatId);
    await sendSMS(from, "connected. you're ready. text me a request or /help.");
    return;
  }

  // /signout
  if (lower === '/signout') {
    await clearCredential(chatId);
    await sendSMS(from, 'disconnected. /connect to reconnect.');
    return;
  }

  // /list
  if (lower === '/list') {
    const watches = await listActiveWatches(chatId);
    if (!watches.length) { await sendSMS(from, 'no active watches.'); return; }
    const lines = watches.map((w, i) => {
      const dr = w.date_start === w.date_end ? w.date_start : `${w.date_start}…${w.date_end}`;
      return `${i + 1}. ${w.venue_name} — ${dr}, ${w.time_start.slice(0, 5)}-${w.time_end.slice(0, 5)}, party ${w.party_size}${w.auto_book ? '' : ' [ping only]'}`;
    });
    await sendSMS(from, lines.join('\n'));
    return;
  }

  // /cancel N
  if (lower.startsWith('/cancel')) {
    const n = parseInt(cmd.split(/\s+/)[1] || '0', 10);
    const watches = await listActiveWatches(chatId);
    const target = watches[n - 1];
    if (!target) { await sendSMS(from, 'no watch at that number. /list to see them.'); return; }
    await cancelWatch(target.id);
    await sendSMS(from, `cancelled: ${target.venue_name}`);
    return;
  }

  // Auth gate
  const token = await getCredential(chatId);
  if (!token) {
    await sendSMS(from, "not connected yet. start with: /connect +15551234567");
    return;
  }

  // Natural-language watch request
  const todayIso = new Date().toISOString().slice(0, 10);
  const parsed = await parseRequest(text, todayIso);
  if ('error' in parsed) {
    await sendSMS(from, `couldn't parse: ${parsed.error}\n\ntry: "watch I Sodi Sat Jun 14 6-9:30 for 3"`);
    return;
  }

  let venues;
  try {
    venues = await searchVenues(token, parsed.venue_name);
  } catch (e) {
    await sendSMS(from, `resy error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!venues.length) {
    await sendSMS(from, `couldn't find "${parsed.venue_name}" on resy. try the exact name.`);
    return;
  }
  const venue = venues[0]!;

  await createWatch({
    chat_id: chatId,
    raw_request: text,
    venue_name: venue.name,
    venue_id: venue.venue_id,
    venue_url: venue.url,
    date_start: parsed.date_start,
    date_end: parsed.date_end,
    party_size: parsed.party_size,
    time_start: parsed.time_start,
    time_end: parsed.time_end,
    auto_book: parsed.auto_book,
  });

  const dr = parsed.date_start === parsed.date_end ? parsed.date_start : `${parsed.date_start}…${parsed.date_end}`;
  const mode = parsed.auto_book ? "will auto-book when found" : "ping only, won't book";
  await sendSMS(from, `watching ${venue.name} — ${dr}, ${parsed.time_start}-${parsed.time_end}, party ${parsed.party_size}. ${mode}.`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Shared secret in query param (Twilio webhook config doesn't support custom headers)
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== env.webhookSecret) {
    return new Response('Forbidden', { status: 403 });
  }

  // Twilio sends application/x-www-form-urlencoded
  const form = await req.formData();
  const from = String(form.get('From') || '');
  const to = String(form.get('To') || '');
  const body = String(form.get('Body') || '').trim();

  // Only accept messages to our Twilio number, from our owner
  if (to && to !== env.twilioFromNumber) {
    return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
  }
  if (!isOwner(from)) {
    console.log(`[inbound] refusing message from non-owner: ${from}`);
    return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
  }
  if (!body) {
    return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
  }

  try {
    await handleMessage(from, body);
  } catch (e) {
    console.error('[inbound] handler error', e);
    try { await sendSMS(from, `error: ${e instanceof Error ? e.message : String(e)}`); } catch {}
  }

  // Reply with empty TwiML — we send messages out-of-band via API
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'content-type': 'text/xml' },
  });
});
