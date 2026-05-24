// Linq Blue webhook receiver. Auth: shared secret in `x-sniper-secret` header.

import { env } from '../_shared/env.ts';
import { upsertChat, getCredential, setCredential, clearCredential, createWatch, listActiveWatches, cancelWatch, db } from '../_shared/db.ts';
import { sendMessage } from '../_shared/linq.ts';
import { sendOTP, verifyOTP, completeChallenge, type Challenge } from '../_shared/resy-auth.ts';
import { searchVenues } from '../_shared/resy.ts';
import { parseRequest } from '../_shared/parse.ts';

interface WebhookEvent {
  event_type: string;
  data?: {
    chat_id?: string;
    from?: string;
    recipient_phone?: string;
    is_from_me?: boolean;
    service?: string;
    message?: { id?: string; parts?: Array<{ type: string; value?: string }> };
  };
}

function extractText(parts?: Array<{ type: string; value?: string }>): string {
  return (parts || []).filter(p => p.type === 'text').map(p => p.value || '').join('\n').trim();
}

function isOwner(handle: string): boolean {
  return env.ownerHandles.includes(handle);
}

const HELP = `commands:
  /connect +15551234567 — connect your resy account (sends sms code)
  /code 123456 — verify the sms code
  /email you@x.com — provide email if challenged after /code
  /list — show active watches
  /cancel <number> — cancel a watch from /list
  /signout — disconnect resy

or just text what you want, e.g.:
  "watch I Sodi Saturday June 14 6-9:30 for 3"`;

async function handleMessage(chatId: string, from: string, service: string, text: string): Promise<void> {
  await upsertChat(chatId, from, service);

  const cmd = text.trim();
  const lower = cmd.toLowerCase();

  // /help
  if (lower === '/help' || lower === 'help') {
    await sendMessage(chatId, HELP);
    return;
  }

  // /connect <phone>
  if (lower.startsWith('/connect')) {
    const phone = cmd.split(/\s+/)[1];
    if (!phone || !phone.match(/^\+\d{6,}$/)) {
      await sendMessage(chatId, 'usage: /connect +15551234567');
      return;
    }
    const result = await sendOTP(phone);
    if (result === 'sms') {
      await db.from('sniper_pending_otp').upsert({ chat_id: chatId, phone }, { onConflict: 'chat_id' });
      await sendMessage(chatId, `code sent to ${phone}. reply: /code 123456`);
    } else if (result === 'rate_limited') {
      await sendMessage(chatId, 'resy rate-limited that number. wait 10 min and try again.');
    } else {
      await sendMessage(chatId, 'failed to send code. check the number format.');
    }
    return;
  }

  // /code <code>
  if (lower.startsWith('/code')) {
    const code = cmd.split(/\s+/)[1];
    if (!code) { await sendMessage(chatId, 'usage: /code 123456'); return; }
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', chatId).maybeSingle();
    if (!pending) { await sendMessage(chatId, 'no pending /connect — run /connect first'); return; }
    const result = await verifyOTP(pending.phone, code);
    if (result.kind === 'token') {
      await setCredential(chatId, result.token, pending.phone);
      await db.from('sniper_pending_otp').delete().eq('chat_id', chatId);
      await sendMessage(chatId, "connected. you're ready. text me a request or /help.");
    } else if (result.kind === 'challenge') {
      await db.from('sniper_pending_otp').update({
        claim_token: result.challenge.claimToken,
        challenge_id: result.challenge.challengeId,
        required_fields: result.challenge.requiredFields,
      }).eq('chat_id', chatId);
      const needs = result.challenge.requiredFields.map(f => f.name).join(', ');
      await sendMessage(chatId, `code accepted. need: ${needs}. reply: /email you@example.com`);
    } else {
      await sendMessage(chatId, `verify failed: ${result.reason}. try /connect again.`);
    }
    return;
  }

  // /email <email>
  if (lower.startsWith('/email')) {
    const email = cmd.split(/\s+/)[1];
    if (!email) { await sendMessage(chatId, 'usage: /email you@example.com'); return; }
    const { data: pending } = await db.from('sniper_pending_otp').select('*').eq('chat_id', chatId).maybeSingle();
    if (!pending?.claim_token) { await sendMessage(chatId, 'no pending challenge — run /connect then /code first'); return; }
    const challenge: Challenge = {
      claimToken: pending.claim_token,
      challengeId: pending.challenge_id || '',
      mobileNumber: pending.phone,
      requiredFields: pending.required_fields || [],
    };
    const token = await completeChallenge(challenge, { em_address: email });
    if (!token) { await sendMessage(chatId, 'challenge failed. try /connect again from scratch.'); return; }
    await setCredential(chatId, token, pending.phone);
    await db.from('sniper_pending_otp').delete().eq('chat_id', chatId);
    await sendMessage(chatId, "connected. you're ready. text me a request or /help.");
    return;
  }

  // /signout
  if (lower === '/signout') {
    await clearCredential(chatId);
    await sendMessage(chatId, 'disconnected. /connect to reconnect.');
    return;
  }

  // /list
  if (lower === '/list') {
    const watches = await listActiveWatches(chatId);
    if (!watches.length) { await sendMessage(chatId, 'no active watches.'); return; }
    const lines = watches.map((w, i) => {
      const dr = w.date_start === w.date_end ? w.date_start : `${w.date_start}…${w.date_end}`;
      return `${i + 1}. ${w.venue_name} — ${dr}, ${w.time_start.slice(0, 5)}-${w.time_end.slice(0, 5)}, party ${w.party_size}`;
    });
    await sendMessage(chatId, lines.join('\n'));
    return;
  }

  // /cancel <n>
  if (lower.startsWith('/cancel')) {
    const n = parseInt(cmd.split(/\s+/)[1] || '0', 10);
    const watches = await listActiveWatches(chatId);
    const target = watches[n - 1];
    if (!target) { await sendMessage(chatId, 'no watch at that number. /list to see them.'); return; }
    await cancelWatch(target.id);
    await sendMessage(chatId, `cancelled: ${target.venue_name}`);
    return;
  }

  // Auth gate for everything else
  const token = await getCredential(chatId);
  if (!token) {
    await sendMessage(chatId, "you're not connected yet. start with: /connect +15551234567");
    return;
  }

  // Natural-language watch request → parse via Claude
  const todayIso = new Date().toISOString().slice(0, 10);
  const parsed = await parseRequest(text, todayIso);
  if ('error' in parsed) {
    await sendMessage(chatId, `couldn't parse that: ${parsed.error}\n\ntry: "watch I Sodi Sat Jun 14 6-9:30 for 3"`);
    return;
  }

  // Resolve venue
  let venues;
  try {
    venues = await searchVenues(token, parsed.venue_name);
  } catch (e) {
    await sendMessage(chatId, `resy error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!venues.length) {
    await sendMessage(chatId, `couldn't find "${parsed.venue_name}" on resy. try the exact name.`);
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
  const mode = parsed.auto_book ? "will auto-book when found" : "will text you the link, won't book";
  await sendMessage(chatId, `watching ${venue.name} — ${dr}, ${parsed.time_start}-${parsed.time_end}, party ${parsed.party_size}. ${mode}.`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (req.headers.get('x-sniper-secret') !== env.webhookSecret) {
    return new Response('Forbidden', { status: 403 });
  }

  let event: WebhookEvent;
  try {
    event = await req.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  if (event.event_type !== 'message.received') return new Response('OK');
  const d = event.data;
  if (!d?.chat_id || !d?.from || !d?.message) return new Response('OK');
  if (d.is_from_me) return new Response('OK');
  if (d.recipient_phone && !env.linqBotNumbers.includes(d.recipient_phone)) return new Response('OK');
  if (!isOwner(d.from)) {
    console.log(`[inbound] refusing message from non-owner: ${d.from}`);
    return new Response('OK');
  }

  const text = extractText(d.message.parts);
  if (!text) return new Response('OK');

  try {
    await handleMessage(d.chat_id, d.from, d.service || 'iMessage', text);
  } catch (e) {
    console.error('[inbound] handler error', e);
    try { await sendMessage(d.chat_id, `error: ${e instanceof Error ? e.message : String(e)}`); } catch {}
  }
  return new Response('OK');
});
