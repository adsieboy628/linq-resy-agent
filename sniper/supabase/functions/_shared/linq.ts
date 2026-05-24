// Linq Blue V3 API. https://apidocs.linqapp.com

import { env } from './env.ts';

const BASE = 'https://api.linqapp.com/api/partner/v3';

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${BASE}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.linqApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { parts: [{ type: 'text', value: text }] } }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[linq] send error ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`Linq send ${res.status}`);
  }
}
