import { createClient } from 'jsr:@supabase/supabase-js@2';
import { env } from './env.ts';
import { encrypt, decrypt } from './encryption.ts';

export const db = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { persistSession: false },
});

export async function upsertChat(chatId: string, phone: string | null, service: string | null) {
  await db.from('sniper_chats').upsert({
    chat_id: chatId,
    phone,
    service,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });
}

export async function getCredential(chatId: string): Promise<string | null> {
  const { data } = await db.from('sniper_credentials').select('encrypted_token, iv, tag').eq('chat_id', chatId).maybeSingle();
  if (!data) return null;
  try {
    const token = await decrypt(data.encrypted_token, data.iv, data.tag);
    await db.from('sniper_credentials').update({ last_used_at: new Date().toISOString() }).eq('chat_id', chatId);
    return token;
  } catch {
    return null;
  }
}

export async function setCredential(chatId: string, token: string, phone: string) {
  const e = await encrypt(token);
  await db.from('sniper_credentials').upsert({
    chat_id: chatId,
    encrypted_token: e.ciphertext,
    iv: e.iv,
    tag: e.tag,
    phone,
    connected_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });
}

export async function clearCredential(chatId: string) {
  await db.from('sniper_credentials').delete().eq('chat_id', chatId);
}

export interface Watch {
  id: string;
  chat_id: string;
  raw_request: string;
  venue_name: string;
  venue_id: number;
  venue_url: string | null;
  date_start: string;
  date_end: string;
  party_size: number;
  time_start: string;
  time_end: string;
  auto_book: boolean;
  status: 'active' | 'matched' | 'booked' | 'cancelled' | 'expired';
  last_polled_at: string | null;
}

export async function createWatch(w: Omit<Watch, 'id' | 'status' | 'last_polled_at'>) {
  const { data, error } = await db.from('sniper_watches').insert({ ...w, status: 'active' }).select().single();
  if (error) throw error;
  return data as Watch;
}

export async function markWatchBooked(id: string, resyToken: string) {
  await db.from('sniper_watches').update({
    status: 'booked',
    booked_at: new Date().toISOString(),
    resy_token: resyToken,
  }).eq('id', id);
}

export async function markWatchMatched(id: string) {
  await db.from('sniper_watches').update({
    status: 'matched',
    matched_at: new Date().toISOString(),
  }).eq('id', id);
}

export async function recordBookOutcome(alertId: string, outcome: 'booked' | 'book_failed', resyToken: string | null, failureReason: string | null) {
  await db.from('sniper_alerts').update({
    outcome,
    resy_token: resyToken,
    failure_reason: failureReason,
  }).eq('id', alertId);
}

export async function listActiveWatches(chatId?: string): Promise<Watch[]> {
  let q = db.from('sniper_watches').select('*').eq('status', 'active');
  if (chatId) q = q.eq('chat_id', chatId);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as Watch[];
}

export async function cancelWatch(id: string) {
  await db.from('sniper_watches').update({ status: 'cancelled' }).eq('id', id);
}

export async function markPolled(id: string) {
  await db.from('sniper_watches').update({ last_polled_at: new Date().toISOString() }).eq('id', id);
}

export async function recordAlertIfNew(watchId: string, slotDate: string, slotTime: string, configToken: string, venueUrl: string): Promise<string | null> {
  const { data, error } = await db.from('sniper_alerts').insert({
    watch_id: watchId,
    slot_date: slotDate,
    slot_time: slotTime,
    config_token: configToken,
    venue_url: venueUrl,
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data.id;
}
