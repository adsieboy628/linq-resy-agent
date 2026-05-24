import { env } from './env.ts';

const BASE = 'https://api.twilio.com/2010-04-01';

/** Send SMS via Twilio. No-op when Twilio isn't configured OR target isn't an E.164 phone. */
export async function sendSMS(to: string, text: string): Promise<void> {
  // Skip silently when Twilio not configured (e.g. web-app-only setup)
  if (!env.twilioAccountSid || !env.twilioAuthToken || !env.twilioFromNumber) {
    console.log(`[twilio] skipping send to ${to} — Twilio not configured`);
    return;
  }
  // Skip when target isn't a phone number (e.g. web:owner)
  if (!to.startsWith('+')) {
    console.log(`[twilio] skipping send to ${to} — not a phone number`);
    return;
  }
  const url = `${BASE}/Accounts/${env.twilioAccountSid}/Messages.json`;
  const auth = btoa(`${env.twilioAccountSid}:${env.twilioAuthToken}`);
  const body = new URLSearchParams({ From: env.twilioFromNumber, To: to, Body: text });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[twilio] send error ${res.status}: ${errText.slice(0, 200)}`);
    throw new Error(`Twilio send ${res.status}`);
  }
}
