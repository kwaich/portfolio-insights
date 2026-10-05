import { format, startOfYear, subDays, subMonths, subYears } from 'date-fns';

export type Period = '1M' | '3M' | 'YTD' | '1Y' | 'ALL' | 'CUSTOM';

const day = (d: Date) => format(d, 'yyyy-MM-dd');

/**
 * Engine range for a period. `start` is the valuation date of the opening snapshot,
 * i.e. the day before the first day whose returns count; null = since inception.
 * Returns undefined for an incomplete custom range.
 */
export function periodRange(
  period: Period,
  today: Date,
  custom?: { from?: Date; to?: Date },
): { start: string | null; end: string } | undefined {
  const end = day(today);
  switch (period) {
    case '1M':
      return { start: day(subMonths(today, 1)), end };
    case '3M':
      return { start: day(subMonths(today, 3)), end };
    case 'YTD':
      return { start: day(subDays(startOfYear(today), 1)), end };
    case '1Y':
      return { start: day(subYears(today, 1)), end };
    case 'ALL':
      return { start: null, end };
    case 'CUSTOM':
      return custom?.from && custom.to ? { start: day(subDays(custom.from, 1)), end: day(custom.to) } : undefined;
  }
}
