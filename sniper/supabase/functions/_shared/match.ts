import type { Slot } from './resy.ts';
import type { Watch } from './db.ts';

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function slotMatchesWatch(slot: Slot, watch: Watch): boolean {
  if (slot.date < watch.date_start || slot.date > watch.date_end) return false;
  const t = toMinutes(slot.time);
  if (t < toMinutes(watch.time_start) || t > toMinutes(watch.time_end)) return false;
  return true;
}

export function* daysInRange(startIso: string, endIso: string): Generator<string> {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}
