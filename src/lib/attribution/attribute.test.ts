import { describe, expect, it } from 'vitest';
import { attribute } from './attribute';
import { fillDaily, daysBetween } from './series';
import type { AttributionInput, AttributionResult, EngineActivity } from './types';

const D0 = '2026-01-05';
const D1 = '2026-01-06';
const D2 = '2026-01-07';

const act = (a: Partial<EngineActivity> & Pick<EngineActivity, 'date' | 'type'>): EngineActivity => ({ currency: 'SGD', ...a });
const quotes = (currency: string, ...closes: [string, number][]) => ({ currency, points: closes.map(([date, value]) => ({ date, value })) });

function run(input: Partial<AttributionInput> & Pick<AttributionInput, 'activities'>): AttributionResult {
  const r = attribute({ baseCurrency: 'SGD', start: D0, end: D1, quotes: {}, fxToBase: {}, ...input });
  // Reconciliation must hold in every scenario.
  for (const l of r.lines) expect(l.reconciled, `${l.key} residual ${l.residual}`).toBe(true);
  expect(r.total.reconciled, `total residual ${r.total.residual}`).toBe(true);
  // Contributions sum to the portfolio total.
  if (r.total.contributionPp) {
    const s = r.lines.reduce((a, l) => a + l.contributionPp!.toNumber(), 0);
    expect(s).toBeCloseTo(r.total.contributionPp.toNumber(), 10);
  }
  return r;
}
const line = (r: AttributionResult, key: string) => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}: ${r.lines.map((x) => x.key)}`);
  return l;
};

describe('worked examples', () => {
  it('1: USD stock, price up and USD down', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '1000', currency: 'USD' }),
        act({ date: D0, type: 'BUY', assetId: 'AAPL', quantity: '10', unitPrice: '100', currency: 'USD' }),
      ],
      quotes: { AAPL: quotes('USD', [D0, 100], [D1, 110]) },
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.3 }] },
    });
    const a = line(r, 'asset:AAPL');
    expect(a.gain.toNumber()).toBe(80);
    expect(a.priceEffect.toNumber()).toBe(130);
    expect(a.fxEffect.toNumber()).toBe(-50);
    expect(r.lines).toHaveLength(1); // USD cash is 0 throughout, so no line
  });

  it('2: contributions on SGD 10,000, no flows', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '10000' }),
        act({ date: D0, type: 'BUY', assetId: 'A', quantity: '60', unitPrice: '100' }),
        act({ date: D0, type: 'BUY', assetId: 'B', quantity: '100', unitPrice: '40' }),
      ],
      quotes: { A: quotes('SGD', [D0, 100], [D1, 105]), B: quotes('SGD', [D0, 40], [D1, 36]) },
    });
    expect(r.averageCapital.toNumber()).toBe(10000);
    expect(line(r, 'asset:A').contributionPp!.toNumber()).toBe(3);
    expect(line(r, 'asset:B').contributionPp!.toNumber()).toBe(-4);
    expect(r.total.contributionPp!.toNumber()).toBe(-1);
    expect(r.total.externalFlows.toNumber()).toBe(0);
  });
});

describe('edge cases', () => {
  it('mid-period buy changes quantity from the next day; flows recorded', () => {
    const r = run({
      end: D2,
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '2100' }),
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100' }),
        act({ date: D1, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '110' }),
      ],
      quotes: { X: quotes('SGD', [D0, 100], [D1, 110], [D2, 120]) },
    });
    const x = line(r, 'asset:X');
    expect(x.priceEffect.toNumber()).toBe(300); // 10×10 on D1, then 20×10 on D2
    expect(x.netFlows.toNumber()).toBe(1100);
    expect(x.startValue.toNumber()).toBe(1000);
    expect(x.endValue.toNumber()).toBe(2400);
    expect(x.gain.toNumber()).toBe(300);
    // Start-of-day capital: D1 = 2100 (1000 stock + 1100 cash), D2 = 2200 + 0 cash.
    expect(r.averageCapital.toNumber()).toBe(2150);
  });

  it('buy above the close puts the execution loss in the price effect', () => {
    const r = run({
      activities: [act({ date: D1, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '101', fee: '1' })],
      quotes: { X: quotes('SGD', [D0, 100], [D1, 100]) },
    });
    expect(line(r, 'asset:X').priceEffect.toNumber()).toBe(-11);
  });

  it('dividend is income on the holding, converted at the payment-date FX rate', () => {
    const r = run({
      end: D2,
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100', currency: 'USD' }),
        act({ date: D1, type: 'DIVIDEND', assetId: 'X', amount: '5', currency: 'USD' }),
      ],
      quotes: { X: quotes('USD', [D0, 100]) },
      fxToBase: { USD: [{ date: D0, value: 1.3 }, { date: D1, value: 1.4 }, { date: D2, value: 1.5 }] },
    });
    const x = line(r, 'asset:X');
    expect(x.income.toNumber()).toBe(7); // 5 × 1.4
    expect(x.priceEffect.toNumber()).toBe(0);
    expect(x.fxEffect.toNumber()).toBe(200); // 10×100×(1.5−1.3)
    expect(x.gain.toNumber()).toBe(207);
    // The USD 5 sits in USD cash from D2 and gains 5×0.1 FX.
    expect(line(r, 'cash:USD').fxEffect.toNumber()).toBeCloseTo(0.5 - 1000 * 0.2, 10);
  });

  it('split: pre-split quantities are scaled to the split-adjusted price basis', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100' }),
        act({ date: D1, type: 'SPLIT', assetId: 'X', amount: '2' }),
      ],
      // Adjusted closes: D0 shown as 50 after the 2:1 split.
      quotes: { X: quotes('SGD', [D0, 50], [D1, 55]) },
    });
    const x = line(r, 'asset:X');
    expect(x.startValue.toNumber()).toBe(1000);
    expect(x.endValue.toNumber()).toBe(1100);
    expect(x.priceEffect.toNumber()).toBe(100);
  });

  it('a fully sold holding still shows its realized gain', () => {
    const r = run({
      end: D2,
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100' }),
        act({ date: D1, type: 'SELL', assetId: 'X', quantity: '10', unitPrice: '112', fee: '1' }),
      ],
      quotes: { X: quotes('SGD', [D0, 100], [D1, 110], [D2, 120]) },
    });
    const x = line(r, 'asset:X');
    expect(x.endValue.toNumber()).toBe(0);
    expect(x.netFlows.toNumber()).toBe(-1119);
    expect(x.priceEffect.toNumber()).toBe(119); // 100 on D1 + 19 sold above close net of fee
    expect(x.gain.toNumber()).toBe(119);
  });

  it('base-currency holding has exactly zero FX effect', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'D05', quantity: '100', unitPrice: '40' }),
        act({ date: D0, type: 'BUY', assetId: 'US', quantity: '1', unitPrice: '10', currency: 'USD' }),
      ],
      quotes: { D05: quotes('SGD', [D0, 40], [D1, 41]), US: quotes('USD', [D0, 10], [D1, 10]) },
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.3 }] },
    });
    expect(line(r, 'asset:D05').fxEffect.isZero()).toBe(true);
    expect(line(r, 'asset:US').fxEffect.toNumber()).toBeCloseTo(-0.5, 10);
  });

  it('foreign cash gets an FX-only line', () => {
    const r = run({
      activities: [act({ date: D0, type: 'DEPOSIT', amount: '1000', currency: 'USD' })],
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.3 }] },
    });
    const c = line(r, 'cash:USD');
    expect(c.fxEffect.toNumber()).toBe(-50);
    expect(c.priceEffect.isZero()).toBe(true);
    expect(c.gain.toNumber()).toBe(-50);
  });

  it('since-inception: buy inside the period counts as a flow with zero start value', () => {
    const r = run({
      start: '2026-01-04',
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '1000', currency: 'USD' }),
        act({ date: D0, type: 'BUY', assetId: 'AAPL', quantity: '10', unitPrice: '100', currency: 'USD' }),
      ],
      quotes: { AAPL: quotes('USD', [D0, 100], [D1, 110]) },
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.3 }] },
    });
    const a = line(r, 'asset:AAPL');
    expect(a.startValue.toNumber()).toBe(0);
    expect(a.netFlows.toNumber()).toBe(1350);
    expect(a.gain.toNumber()).toBe(80);
    expect(r.total.externalFlows.toNumber()).toBe(1350);
  });
});

describe('splits (match Wealthfolio)', () => {
  const holdSplit = (split: Partial<EngineActivity>, closes: [string, number][], extra: EngineActivity[] = []) =>
    run({
      end: D2,
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100' }),
        act({ date: D1, type: 'SPLIT', assetId: 'X', ...split }),
        ...extra,
      ],
      quotes: { X: quotes('SGD', ...closes) },
    });

  it('falls back to quantity for the ratio when amount is empty', () => {
    const x = line(holdSplit({ quantity: '2' }, [[D0, 50], [D1, 50], [D2, 55]]), 'asset:X');
    expect(x.endValue.toNumber()).toBe(1100);
    expect(x.priceEffect.toNumber()).toBe(100);
  });

  it('handles unadjusted quotes (price halves on the split date)', () => {
    const x = line(holdSplit({ amount: '2' }, [[D0, 100], [D1, 50], [D2, 55]]), 'asset:X');
    expect(x.startValue.toNumber()).toBe(1000);
    expect(x.priceEffect.toNumber()).toBe(100); // no fake −50% drop on the split date
    expect(x.endValue.toNumber()).toBe(1100);
  });

  it('counts the same split recorded twice (e.g. in two accounts) once', () => {
    const r = holdSplit({ amount: '2' }, [[D0, 50], [D1, 50], [D2, 55]], [
      act({ date: D1, type: 'SPLIT', assetId: 'X', amount: '2' }),
    ]);
    expect(line(r, 'asset:X').endValue.toNumber()).toBe(1100);
  });
});

describe('cash booking (matches Wealthfolio)', () => {
  it('a USD buy with an fxRate in an SGD account settles from SGD cash, not USD', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '1350', accountCurrency: 'SGD' }),
        act({
          date: D0, type: 'BUY', assetId: 'BLOK', quantity: '10', unitPrice: '100', amount: '1000',
          currency: 'USD', accountCurrency: 'SGD', fxRate: '1.35',
        }),
      ],
      quotes: { BLOK: quotes('USD', [D0, 100], [D1, 110]) },
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.3 }] },
    });
    expect(r.lines.map((l) => l.key)).toEqual(['asset:BLOK']); // SGD cash is 0, no USD cash line
    expect(line(r, 'asset:BLOK').fxEffect.toNumber()).toBe(-50);
    expect(r.total.gain.toNumber()).toBe(80);
  });

  it('a mid-period converted buy at a different rate puts the rate difference in the price effect', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'DEPOSIT', amount: '1400', accountCurrency: 'SGD' }),
        act({
          date: D1, type: 'BUY', assetId: 'BLOK', quantity: '10', unitPrice: '100', amount: '1000',
          currency: 'USD', accountCurrency: 'SGD', fxRate: '1.36',
        }),
      ],
      quotes: { BLOK: quotes('USD', [D0, 100], [D1, 100]) },
      fxToBase: { USD: [{ date: D0, value: 1.35 }, { date: D1, value: 1.35 }] },
    });
    const b = line(r, 'asset:BLOK');
    expect(b.netFlows.toNumber()).toBe(1360); // what left SGD cash
    expect(b.priceEffect.toNumber()).toBe(-10); // worth 1350 at market, paid 1360
    expect(line(r, 'cash:SGD').endValue.toNumber()).toBe(40);
  });

  it('amount is the final cash: dividend amount is already net of tax', () => {
    const r = run({
      activities: [
        act({ date: D0, type: 'BUY', assetId: 'X', quantity: '10', unitPrice: '100' }),
        act({ date: D1, type: 'DIVIDEND', assetId: 'X', amount: '8.5', tax: '1.5' }),
        act({ date: D1, type: 'WITHDRAWAL', amount: '100', fee: '2' }),
      ],
      quotes: { X: quotes('SGD', [D0, 100], [D1, 100]) },
    });
    expect(line(r, 'asset:X').income.toNumber()).toBe(8.5);
    expect(r.total.externalFlows.toNumber()).toBe(-100);
  });
});

describe('price gaps', () => {
  const S = '2026-01-01';
  const E = '2026-01-20';

  it('ignores a gap before the holding was bought (quotes start at first purchase)', () => {
    const r = run({
      start: S,
      end: E,
      activities: [act({ date: '2026-01-15', type: 'BUY', assetId: 'BLOK', quantity: '10', unitPrice: '30' })],
      quotes: { BLOK: quotes('SGD', ['2026-01-15', 30], ['2026-01-16', 31], ['2026-01-19', 32], ['2026-01-20', 32]) },
    });
    expect(line(r, 'asset:BLOK').gaps).toEqual([]);
  });

  it('flags a gap while the holding is held', () => {
    const r = run({
      start: S,
      end: E,
      activities: [act({ date: S, type: 'BUY', assetId: 'BLOK', quantity: '10', unitPrice: '30' })],
      quotes: { BLOK: quotes('SGD', [S, 30], ['2026-01-15', 31], ['2026-01-19', 32], ['2026-01-20', 32]) },
    });
    expect(line(r, 'asset:BLOK').gaps).toEqual([{ from: S, to: '2026-01-15', days: 14 }]);
  });
});

describe('fillDaily', () => {
  it('forward-fills weekends and flags gaps longer than 5 days', () => {
    const days = daysBetween('2026-01-01', '2026-01-20');
    const r = fillDaily(
      [
        { date: '2026-01-02', value: 1 },
        { date: '2026-01-05', value: 2 }, // weekend: 3 days, fine
        { date: '2026-01-12', value: 3 }, // 7 days: gap
      ],
      days,
    )!;
    expect(r.values[0].toNumber()).toBe(1); // backfilled before first quote
    expect(r.values[days.indexOf('2026-01-10')].toNumber()).toBe(2);
    expect(r.gaps).toEqual([
      { from: '2026-01-05', to: '2026-01-12', days: 7 },
      { from: '2026-01-12', to: '2026-01-20', days: 8 }, // stale to period end
    ]);
  });
});
