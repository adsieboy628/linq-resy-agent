// Resy SMS OTP (Deno). Adapted from ../../../../src/bookings/client.ts (MIT).

import { env } from './env.ts';

const BASE = 'https://api.resy.com';

function preAuth(): Record<string, string> {
  return {
    'authorization': `ResyAPI api_key="${env.resyApiKey}"`,
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://resy.com',
    'referer': 'https://resy.com/',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

export interface Challenge {
  claimToken: string;
  challengeId: string;
  mobileNumber: string;
  requiredFields: Array<{ name: string; type: string; message: string }>;
}

export async function sendOTP(phone: string): Promise<'sms' | 'rate_limited' | 'failed'> {
  const res = await fetch(`${BASE}/3/auth/mobile`, {
    method: 'POST',
    headers: preAuth(),
    body: new URLSearchParams({ mobile_number: phone, method: 'sms' }).toString(),
  });
  if (res.ok) {
    const data = await res.json() as { sent?: boolean };
    if (data.sent) return 'sms';
  }
  if (res.status === 429) return 'rate_limited';
  return 'failed';
}

export type VerifyResult =
  | { kind: 'token'; token: string }
  | { kind: 'challenge'; challenge: Challenge }
  | { kind: 'error'; reason: string };

export async function verifyOTP(phone: string, code: string): Promise<VerifyResult> {
  const res = await fetch(`${BASE}/3/auth/mobile`, {
    method: 'POST',
    headers: preAuth(),
    body: new URLSearchParams({ mobile_number: phone, code }).toString(),
  });
  if (!res.ok) return { kind: 'error', reason: `Verify failed (${res.status})` };
  // deno-lint-ignore no-explicit-any
  const data = await res.json() as Record<string, any>;
  const direct = data.token || data.auth_token || data.access_token;
  if (direct) return { kind: 'token', token: direct };

  const claimToken = data.mobile_claim?.claim_token;
  const challengeId = data.challenge?.challenge_id;
  if (!claimToken) return { kind: 'error', reason: 'No token or claim in response' };

  if (!challengeId) {
    for (const ep of ['/3/auth/mobile/claim', '/3/auth/claim']) {
      const ex = await fetch(`${BASE}${ep}`, {
        method: 'POST',
        headers: preAuth(),
        body: new URLSearchParams({ mobile_number: phone, claim_token: claimToken }).toString(),
      });
      if (ex.ok) {
        // deno-lint-ignore no-explicit-any
        const ed = await ex.json().catch(() => ({})) as Record<string, any>;
        const t = ed.token || ed.auth_token || ed.access_token;
        if (t) return { kind: 'token', token: t };
      }
    }
    return {
      kind: 'challenge',
      challenge: {
        claimToken,
        challengeId: '',
        mobileNumber: phone,
        requiredFields: [{ name: 'em_address', type: 'email', message: 'Email on your Resy account' }],
      },
    };
  }

  return {
    kind: 'challenge',
    challenge: {
      claimToken,
      challengeId,
      mobileNumber: phone,
      requiredFields: data.challenge?.properties || [],
    },
  };
}

export async function completeChallenge(challenge: Challenge, fields: Record<string, string>): Promise<string | null> {
  const body = {
    mobile_number: challenge.mobileNumber,
    claim_token: challenge.claimToken,
    challenge_id: challenge.challengeId,
    ...fields,
  };
  const res = await fetch(`${BASE}/3/auth/challenge`, {
    method: 'POST',
    headers: preAuth(),
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) return null;
  // deno-lint-ignore no-explicit-any
  const data = await res.json().catch(() => ({})) as Record<string, any>;
  return data.token || data.auth_token || data.access_token || null;
}
