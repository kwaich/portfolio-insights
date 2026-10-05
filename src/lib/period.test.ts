import { describe, expect, it } from 'vitest';
import { periodRange } from './period';

const today = new Date(2026, 9, 5); // 5 Oct 2026, local time

describe('periodRange', () => {
  it('YTD opens on the last day of the previous year', () => {
    expect(periodRange('YTD', today)).toEqual({ start: '2025-12-31', end: '2026-10-05' });
  });
  it('custom range counts returns from its first day', () => {
    expect(periodRange('CUSTOM', today, { from: new Date(2026, 0, 1), to: new Date(2026, 2, 31) })).toEqual({
      start: '2025-12-31',
      end: '2026-03-31',
    });
    expect(periodRange('CUSTOM', today, { from: new Date(2026, 0, 1) })).toBeUndefined();
  });
  it('since inception leaves start to the loader', () => {
    expect(periodRange('ALL', today)).toEqual({ start: null, end: '2026-10-05' });
  });
});
