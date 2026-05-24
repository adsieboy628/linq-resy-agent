// Twilio Programmable Messaging — send SMS to the owner.
// Webhook payload (inbound) is parsed in sniper-inbound.

import { env } from './env.ts';

const BASE = 'https://api.twilio.com/2010-04-01';

export async function sendSMS(to: string, text: string): Promise<void> {
  const url = `${BASE}/Accounts/${env.twilioAccountSid}/Messages.json`;
  const auth = btoa(`${env.twilioAccountSid}:${env.twilioAuthToken}`);
  const body = new URLSearchParams({
    From: env.twilioFromNumber,
    To: to,
    Body: text,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[twilio] send error ${res.status}: ${errText.slice(0, 200)}`);
    throw new Error(`Twilio send ${res.status}`);
  }
}
