// Claude turns a natural-language request into a structured watch.

import { env } from './env.ts';

export interface ParsedWatch {
  venue_name: string;
  date_start: string; // YYYY-MM-DD
  date_end: string;   // YYYY-MM-DD (same as start for single-date asks)
  party_size: number;
  time_start: string; // HH:MM (24h)
  time_end: string;   // HH:MM (24h)
  auto_book: boolean; // default true; false if user said "no book", "don't book", "just ping me", "link only", etc.
}

const SYS = `You parse natural-language reservation requests into structured JSON.

The user is asking the bot to WATCH a Resy restaurant for an open slot. Today's date is provided.

Return ONLY a JSON object, no prose, with these fields:
- venue_name (string) — the restaurant name exactly as said
- date_start (YYYY-MM-DD)
- date_end (YYYY-MM-DD) — same as date_start unless the user gave a range like "any Saturday in June" → first Saturday to last Saturday
- party_size (integer)
- time_start (HH:MM 24h)
- time_end (HH:MM 24h)
- auto_book (boolean) — true UNLESS the user said something like "no book", "don't book", "just ping", "link only", "ask me first". Default true.

Reasonable defaults if unspecified:
- party_size: 2
- time_start: "18:00", time_end: "21:30"
- auto_book: true

If you can't parse, return: { "error": "explain why" }`;

export async function parseRequest(text: string, todayIso: string): Promise<ParsedWatch | { error: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYS,
      messages: [{ role: 'user', content: `Today is ${todayIso}.\n\nRequest: ${text}` }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    return { error: `Parse failed (${res.status}): ${body.slice(0, 120)}` };
  }
  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  const raw = data.content?.find(c => c.type === 'text')?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { error: 'No JSON in model response' };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { error: 'Invalid JSON from model' };
  }
}
