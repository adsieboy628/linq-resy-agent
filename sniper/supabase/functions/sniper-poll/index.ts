// Cron-driven watcher. pg_cron POSTs here every minute (see migration).
// For each active watch: poll Resy for slots across the date range,
// match against prefs, dedupe, then auto-book or notify.

import { env } from '../_shared/env.ts';
import { listActiveWatches, markPolled, recordAlertIfNew, getCredential, markWatchBooked, markWatchMatched, recordBookOutcome, type Watch } from '../_shared/db.ts';
import { findSlots, bookFromConfigToken, ResyAuthError } from '../_shared/resy.ts';
import { sendSMS } from '../_shared/twilio.ts';
import { slotMatchesWatch, daysInRange } from '../_shared/match.ts';

async function pollWatch(w: Watch): Promise<void> {
  const token = await getCredential(w.chat_id);
  if (!token) {
    console.warn(`[poll] watch ${w.id} has no credential — skipping`);
    return;
  }

  // Cap range size to avoid thundering the API
  const days = Array.from(daysInRange(w.date_start, w.date_end)).slice(0, 14);

  for (const day of days) {
    let slots;
    try {
      slots = await findSlots(token, w.venue_id, day, w.party_size);
    } catch (e) {
      if (e instanceof ResyAuthError) {
        try { await sendSMS(w.chat_id, `${w.venue_name}: ${e.message}`); } catch {}
        return; // stop polling this watch this tick; will retry next tick
      }
      console.error(`[poll] ${w.venue_name} ${day} error:`, e instanceof Error ? e.message : String(e));
      continue;
    }

    for (const slot of slots) {
      if (!slotMatchesWatch(slot, w)) continue;

      const alertId = await recordAlertIfNew(w.id, slot.date, slot.time, slot.config_token, w.venue_url || 'https://resy.com');
      if (!alertId) continue; // already notified, skip

      const niceTime = slot.time;
      const niceDate = slot.date;
      const venueUrl = w.venue_url || 'https://resy.com';

      if (w.auto_book) {
        try {
          const conf = await bookFromConfigToken(token, slot.config_token, slot.date, slot.party_size);
          await recordBookOutcome(alertId, 'booked', conf.resy_token, null);
          await markWatchBooked(w.id, conf.resy_token);
          await sendSMS(
            w.chat_id,
            `BOOKED ${conf.venue_name} — ${niceDate} ${niceTime}, party ${conf.party_size}\n${conf.venue_url}`
          );
          return; // watch is done
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`[poll] book failed for ${w.venue_name} ${niceDate} ${niceTime}:`, reason);
          await recordBookOutcome(alertId, 'book_failed', null, reason);
          // Fall through: still notify the user so they can grab it manually
          await sendSMS(
            w.chat_id,
            `slot found but auto-book failed for ${w.venue_name} — ${niceDate} ${niceTime}\nreason: ${reason}\ntap to book manually: ${venueUrl}`
          );
        }
      } else {
        await sendSMS(
          w.chat_id,
          `${w.venue_name} — ${niceDate} ${niceTime}, party ${slot.party_size}\ntap to book: ${venueUrl}`
        );
      }
    }
  }

  // If we didn't auto-book/finish the watch, mark this tick and move on.
  // (markWatchBooked already updated status if we got there.)
  await markPolled(w.id);

  // Expire watches whose entire window has passed
  const today = new Date().toISOString().slice(0, 10);
  if (w.date_end < today) {
    try { await markWatchMatched(w.id); } catch {} // best-effort; keep loop moving
  }
}

Deno.serve(async (req) => {
  // Shared secret — accepts either x-sniper-secret header (from pg_cron via pg_net)
  // or ?secret=... query param (for manual testing).
  const url = new URL(req.url);
  const secret = req.headers.get('x-sniper-secret') || url.searchParams.get('secret');
  if (secret !== env.webhookSecret) {
    return new Response('Forbidden', { status: 403 });
  }

  const watches = await listActiveWatches();
  console.log(`[poll] tick — ${watches.length} active watches`);

  // Sequential is fine at this volume; keeps Resy rate calm.
  for (const w of watches) {
    try {
      await pollWatch(w);
    } catch (e) {
      console.error(`[poll] watch ${w.id} unhandled:`, e instanceof Error ? e.message : String(e));
    }
  }

  return new Response(JSON.stringify({ polled: watches.length }), {
    headers: { 'content-type': 'application/json' },
  });
});
