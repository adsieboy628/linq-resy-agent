import { env } from './env.ts';

export interface ParsedWatch {
  venue_name: string;
  date_start: string;
  date_end: string;
  party_size: number;
  time_start: string;
  time_end: string;
  auto_book: boolean;
}

const SYS = `You parse natural-language Resy reservation requests into structured JSON.

Today's date is provided. Single watch or many. Patterns:
  "Sat Jun 14: I Sodi 6-9 for 3, Lilia 7-9 for 2; Sun: Don Angie 8pm 4ppl"
  "watch I Sodi sat jun 14 6-9:30 for 3"

Shared context propagates; per-venue overrides win.

Return ONLY a JSON array. Even one watch: [{ ... }].

Fields: venue_name, date_start (YYYY-MM-DD), date_end, party_size (int), time_start (HH:MM 24h), time_end, auto_book (bool, true unless "no book"/"just ping"/"link only"/"ask first").

IMPORTANT: party_size must be an integer. If user says "3-4 people", pick the LARGER number (so we don't miss slots that need the full party). time_start/end must be HH:MM zero-padded.

ALWAYS include every field in every watch object — never omit fields and never return null. If the user gives only one date, set date_end equal to date_start.

Defaults: date_end = date_start, party 2, 18:00-21:30, auto_book true.

If nothing parseable, return { "error": "..." }.`;

export type ParseResult = ParsedWatch[] | { error: string };

// Haiku occasionally drops fields or emits null even though the prompt declares
// defaults. Every column in sniper_watches except notes/venue_id/venue_url is
// NOT NULL, so we enforce the prompt's contract in code before insert. If a
// watch is missing venue_name or date_start we can't recover and drop it; every
// other field gets the prompt's stated default.
// deno-lint-ignore no-explicit-any
function normalizeWatch(w: any): ParsedWatch | null {
  if (!w || typeof w !== 'object') return null;
  const venue_name = typeof w.venue_name === 'string' ? w.venue_name.trim() : '';
  const date_start = typeof w.date_start === 'string' ? w.date_start.trim() : '';
  if (!venue_name || !date_start) return null;
  const date_end = typeof w.date_end === 'string' && w.date_end.trim() ? w.date_end.trim() : date_start;
  const time_start = typeof w.time_start === 'string' && w.time_start.trim() ? w.time_start.trim() : '18:00';
  const time_end = typeof w.time_end === 'string' && w.time_end.trim() ? w.time_end.trim() : '21:30';
  const party_size = Number.isInteger(w.party_size) && w.party_size > 0 ? w.party_size : 2;
  const auto_book = typeof w.auto_book === 'boolean' ? w.auto_book : true;
  return { venue_name, date_start, date_end, party_size, time_start, time_end, auto_book };
}

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

  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalized = parsed.map(normalizeWatch).filter((w): w is ParsedWatch => w !== null);
        if (normalized.length > 0) return normalized;
      }
    } catch { /* fall through */ }
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed?.error) return { error: String(parsed.error) };
      const single = normalizeWatch(parsed);
      if (single) return [single];
    } catch { /* fall through */ }
  }
  return { error: 'No parseable watches in model response' };
}
