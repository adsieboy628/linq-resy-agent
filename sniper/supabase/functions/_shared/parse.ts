// Claude turns natural-language requests into structured watch(es).
// Supports either ONE watch ("watch I Sodi Sat Jun 14 6-9:30 for 3")
// or MANY in one message ("Sat: I Sodi 6-9 for 3; Lilia 7-9; Don Angie 8").

import { env } from './env.ts';

export interface ParsedWatch {
  venue_name: string;
  date_start: string; // YYYY-MM-DD
  date_end: string;   // YYYY-MM-DD
  party_size: number;
  time_start: string; // HH:MM (24h)
  time_end: string;   // HH:MM (24h)
  auto_book: boolean; // default true
}

const SYS = `You parse natural-language Resy reservation requests into structured JSON.

Today's date is provided. The user may request ONE watch or MANY in a single message (separated by commas, semicolons, newlines, or just listed). Common pattern when planning a trip:

  "Sat Jun 14: I Sodi 6-9 for 3, Lilia 7-9 for 2; Sun: Don Angie 8pm 4ppl"
  "watch I Sodi sat jun 14 6-9:30 for 3"
  "for nyc trip jun 14-17: carbone sat, lilia fri, i sodi any night 7-9 for 3"

When the user gives a shared context (date, party size, time range) before/after individual venue mentions, propagate it. When a venue has its own override, that wins.

Return ONLY a JSON array of watch objects. Even if there's just one, return [{ ... }].

Each watch object:
- venue_name (string) — restaurant name exactly as said
- date_start (YYYY-MM-DD)
- date_end (YYYY-MM-DD) — same as start unless a range is given ("any night Jun 14-17")
- party_size (integer)
- time_start (HH:MM 24h)
- time_end (HH:MM 24h)
- auto_book (boolean) — true UNLESS the user said "no book", "don't book", "just ping", "link only", "ask first". Default true.

Defaults if unspecified:
- party_size: 2
- time_start: "18:00", time_end: "21:30"
- auto_book: true

If you can't parse ANYTHING, return: { "error": "explain why" }
If you can parse some but not others, only include the ones you parsed.`;

export type ParseResult = ParsedWatch[] | { error: string };

export async function parseRequest(text: string, todayIso: string): Promise<ParseResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
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

  // Try array first, fall back to single object
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* fall through */ }
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed.error) return { error: parsed.error };
      if (parsed.venue_name) return [parsed]; // single watch as object
    } catch { /* fall through */ }
  }
  return { error: 'No parseable watches in model response' };
}
