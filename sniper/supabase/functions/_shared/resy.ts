// Resy API client (Deno). Adapted from ../../../../src/bookings/client.ts (MIT, same repo).

import { env } from './env.ts';

const BASE = 'https://api.resy.com';
const DEFAULT_LAT = 40.7128;
const DEFAULT_LNG = -73.9876;

export class ResyAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ResyAuthError'; }
}

export interface Venue {
  venue_id: number;
  name: string;
  neighborhood?: string;
  url: string;
}

export interface Slot {
  config_token: string;
  date: string;
  time: string;
  party_size: number;
  type: string;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'authorization': `ResyAPI api_key="${env.resyApiKey}"`,
    'x-resy-auth-token': token,
    'x-resy-universal-auth': token,
    'origin': 'https://resy.com',
    'referer': 'https://resy.com/',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...authHeaders(token), ...(init.headers as Record<string, string> || {}) };
  if (method !== 'GET' && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 419 || (res.status === 500 && /unauthorized|auth|token/i.test(body))) {
      throw new ResyAuthError('Resy session expired. Reply /connect to reconnect.');
    }
    throw new Error(`Resy ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export async function searchVenues(token: string, query: string, lat = DEFAULT_LAT, lng = DEFAULT_LNG): Promise<Venue[]> {
  const res = await call(token, '/3/venuesearch/search', {
    method: 'POST',
    body: JSON.stringify({ geo: { latitude: lat, longitude: lng }, query, types: ['venue'] }),
  });
  const data = await res.json() as {
    search: { hits: Array<{ id: { resy: number }; name: string; location: { locality: string; neighborhood?: string }; url_slug: string }> };
  };
  return (data.search?.hits || []).map(hit => {
    const citySlug = (hit.location.locality || 'new-york').toLowerCase().replace(/\s+/g, '-');
    return {
      venue_id: hit.id.resy,
      name: hit.name,
      neighborhood: hit.location.neighborhood,
      url: `https://resy.com/cities/${citySlug}/${hit.url_slug}`,
    };
  });
}

export interface BookingConfirmation {
  resy_token: string;
  reservation_id: number;
  venue_name: string;
  venue_url: string;
  date: string;
  time: string;
  party_size: number;
  type: string;
}

export async function bookFromConfigToken(token: string, configToken: string, day: string, partySize: number): Promise<BookingConfirmation> {
  // 1. /3/details — exchange config_token for book_token
  const detailsRes = await call(token, `/3/details?${new URLSearchParams({ config_id: configToken, day, party_size: partySize.toString() })}`, { method: 'GET' });
  const details = await detailsRes.json() as {
    book_token: { value: string };
    venue: { name: string; venue_url_slug?: string; location?: { url_slug?: string } };
    config: { type: string };
  };
  const bookToken = details.book_token.value;
  const venueName = details.venue?.name || 'Restaurant';
  const slotType = details.config?.type || 'Dining Room';
  const citySlug = details.venue?.location?.url_slug || 'new-york-ny';
  const venueSlug = details.venue?.venue_url_slug || '';
  const venueUrl = venueSlug ? `https://resy.com/cities/${citySlug}/${venueSlug}` : 'https://resy.com';

  // 2. /2/user — default payment method
  const userRes = await call(token, '/2/user', { method: 'GET' });
  const userData = await userRes.json() as { payment_methods: Array<{ id: number; is_default: boolean }> };
  const pm = userData.payment_methods?.find(p => p.is_default) || userData.payment_methods?.[0];
  if (!pm) throw new Error('No payment method on file. Add one at resy.com/account before booking.');

  // 3. /3/book
  const bookBody = new URLSearchParams({
    book_token: bookToken,
    struct_payment_method: JSON.stringify({ id: pm.id }),
    source_id: 'resy.com-venue-details',
  });
  const bookRes = await call(token, '/3/book', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bookBody.toString(),
  });
  const booked = await bookRes.json() as { resy_token: string; reservation_id: number; time_slot: string; num_seats: number };

  return {
    resy_token: booked.resy_token,
    reservation_id: booked.reservation_id,
    venue_name: venueName,
    venue_url: venueUrl,
    date: day,
    time: booked.time_slot || day,
    party_size: booked.num_seats || partySize,
    type: slotType,
  };
}

export async function findSlots(token: string, venueId: number, day: string, partySize: number, lat = DEFAULT_LAT, lng = DEFAULT_LNG): Promise<Slot[]> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    long: lng.toString(),
    day,
    party_size: partySize.toString(),
    venue_id: venueId.toString(),
  });
  const res = await call(token, `/4/find?${params}`, { method: 'GET' });
  const data = await res.json() as {
    results: { venues: Array<{ slots: Array<{ config: { token: string; type: string }; date: { start: string } }> }> };
  };
  const slots = data.results?.venues?.[0]?.slots || [];
  return slots.map(s => {
    const d = new Date(s.date.start);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return {
      config_token: s.config.token,
      date: day,
      time: `${hh}:${mm}`,
      party_size: partySize,
      type: s.config.type || 'Dining Room',
    };
  });
}
