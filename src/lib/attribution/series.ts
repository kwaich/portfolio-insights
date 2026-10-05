import Decimal from 'decimal.js';
import type { Gap, PricePoint } from './types';

const DAY_MS = 86_400_000;
export const MAX_GAP_DAYS = 5;

/** Calendar days from `a` to `b` (both YYYY-MM-DD). */
export const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10);

/** Every calendar day from start to end, inclusive. */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Forward-fill sparse observations onto `days`. Days before the first observation
 * take the first observation (backfill). Any stretch longer than MAX_GAP_DAYS without a
 * fresh observation, including the run-up to the first one, is reported as a gap.
 * Returns null when there are no observations at all.
 */
export function fillDaily(points: PricePoint[], days: string[]): { values: Decimal[]; gaps: Gap[] } | null {
  const sorted = [...points].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  if (sorted.length === 0) return null;
  const start = days[0];
  const end = days[days.length - 1];

  const values: Decimal[] = [];
  let j = -1;
  for (const day of days) {
    while (j + 1 < sorted.length && sorted[j + 1].date <= day) j++;
    values.push(new Decimal(sorted[Math.max(j, 0)].value));
  }

  const gaps: Gap[] = [];
  let prev = sorted.filter((p) => p.date <= start).at(-1)?.date ?? start;
  const marks = [...sorted.filter((p) => p.date > start && p.date <= end).map((p) => p.date), end];
  for (const d of marks) {
    const n = diffDays(prev, d);
    if (n > MAX_GAP_DAYS) gaps.push({ from: prev, to: d, days: n });
    prev = d;
  }
  return { values, gaps };
}
