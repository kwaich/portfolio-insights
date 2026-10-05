import Decimal from 'decimal.js';
import { daysBetween, diffDays, fillDaily } from './series';
import type { AttributionInput, AttributionResult, Components, EngineActivity, Gap, LineResult, PricePoint } from './types';

/** Max |residual| in base currency for a reconciliation to pass. */
export const TOLERANCE = new Decimal('0.01');

const ZERO = new Decimal(0);
const num = (v?: string | null) => new Decimal(v == null || v === '' ? 0 : v);
const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), ZERO);

interface Ev {
  date: string;
  /** Quantity change, in split-adjusted units (cash lines: currency units). */
  dq: Decimal;
  kind: 'flow' | 'income';
  /** Cash value in `ccy`; omitted = valued at that day's market price (security transfers). */
  amount?: Decimal;
  ccy: string;
  external?: boolean;
}

interface Line {
  kind: 'asset' | 'cash';
  id: string;
  currency: string;
  events: Ev[];
  tradePrices: PricePoint[];
}

const INBOUND = new Set(['DEPOSIT', 'TRANSFER_IN']);

/**
 * Daily price / FX / income attribution and contribution analysis.
 *
 * Per line and day t (start-of-day quantity q, local price P, FX to base X):
 *   price += q·(P(t) − P(t−1))·X(t)     fx += q·P(t−1)·(X(t) − X(t−1))
 * A trade on day t changes q from t+1. The gap between the trade's cash value and its
 * value at that day's close (execution price vs close, fees) also goes into the price
 * effect, so that price + fx + income reconciles exactly with values and flows.
 */
export function attribute(input: AttributionInput): AttributionResult {
  const { baseCurrency, start, end } = input;
  const days = daysBetween(start, end);
  const n = days.length;
  const warnings: string[] = [];
  const activities = input.activities.filter((a) => a.date <= end);

  // Quantities are expressed in post-split units: a raw quantity on date d is multiplied by
  // every split ratio dated after d. Splits are read as Wealthfolio reads them: ratio = amount,
  // else quantity; rows for one asset within a day of each other are one split (e.g. the same
  // split recorded in two accounts).
  const splits = new Map<string, { date: string; ratio: Decimal }[]>();
  for (const a of [...activities].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))) {
    if (a.type !== 'SPLIT' || !a.assetId) continue;
    const ratio = num(a.amount).gt(0) ? num(a.amount) : num(a.quantity).abs();
    if (ratio.lte(0)) {
      warnings.push(`Ignored split on ${a.date} for ${a.assetId}: no positive ratio`);
      continue;
    }
    const list = splits.get(a.assetId) ?? [];
    const last = list[list.length - 1];
    if (!last || diffDays(last.date, a.date) > 1) splits.set(a.assetId, [...list, { date: a.date, ratio }]);
  }
  const splitFactor = (assetId: string, date: string) =>
    (splits.get(assetId) ?? []).filter((s) => s.date > date).reduce((f, s) => f.times(s.ratio), new Decimal(1));

  const lines = new Map<string, Line>();
  const getLine = (kind: Line['kind'], id: string, currency: string) => {
    const key = `${kind}:${id}`;
    if (!lines.has(key)) lines.set(key, { kind, id, currency, events: [], tradePrices: [] });
    return lines.get(key)!;
  };

  const ignored = new Map<string, number>();
  for (const a of activities) bookActivity(a);

  // Cash follows Wealthfolio's portfolio engine: `amount` is the final cash (fees/taxes included);
  // only when it is missing do we derive it from quantity × price ± charges.
  function bookActivity(a: EngineActivity) {
    const ccy = a.currency;
    const add = (l: Line, ev: Omit<Ev, 'date' | 'ccy'> & { ccy?: string }) => l.events.push({ date: a.date, ccy, ...ev });
    const cash = (c = ccy) => getLine('cash', c, c);
    const asset = a.assetId ? getLine('asset', a.assetId, input.quotes[a.assetId]?.currency ?? ccy) : undefined;
    const q = num(a.quantity).abs();
    const p = num(a.unitPrice).abs();
    const hasAmount = a.amount != null && a.amount !== '';
    const amount = num(a.amount).abs();
    const costs = num(a.fee).plus(num(a.tax));
    const finalCash = (fallback: Decimal) => (hasAmount ? amount : fallback);

    switch (a.type) {
      case 'BUY':
      case 'SELL': {
        if (!asset) return void warnings.push(`${a.type} on ${a.date} has no asset; skipped`);
        const sign = a.type === 'BUY' ? 1 : -1;
        const f = splitFactor(asset.id, a.date);
        let value = finalCash(sign > 0 ? q.times(p).plus(costs) : q.times(p).minus(costs));
        let cashCcy = ccy;
        // A foreign-currency trade with an fxRate settles in the account currency.
        if (a.fxRate && a.accountCurrency && a.accountCurrency !== ccy) {
          value = value.times(num(a.fxRate));
          cashCcy = a.accountCurrency;
        }
        add(asset, { dq: q.times(f).times(sign), kind: 'flow', amount: value.times(sign), ccy: cashCcy });
        add(cash(cashCcy), { dq: value.times(-sign), kind: 'flow', amount: value.times(-sign), ccy: cashCcy });
        if (a.unitPrice) asset.tradePrices.push({ date: a.date, value: p.div(f).toString() });
        return;
      }
      case 'DIVIDEND':
      case 'INTEREST':
      case 'CREDIT':
      case 'FEE':
      case 'TAX': {
        const isCost = a.type === 'FEE' || a.type === 'TAX';
        const net = isCost ? (amount.isZero() ? costs : amount).neg() : finalCash(q.times(p).minus(costs));
        if (asset) {
          // Paid out of the holding into cash: income for the holding, an internal flow for cash.
          add(asset, { dq: ZERO, kind: 'income', amount: net });
          add(cash(), { dq: net, kind: 'flow', amount: net });
        } else {
          add(cash(), { dq: net, kind: 'income', amount: net });
        }
        return;
      }
      case 'DEPOSIT':
      case 'WITHDRAWAL':
      case 'TRANSFER_IN':
      case 'TRANSFER_OUT': {
        const sign = INBOUND.has(a.type) ? 1 : -1;
        if (asset && a.quantity) {
          add(asset, { dq: q.times(splitFactor(asset.id, a.date)).times(sign), kind: 'flow', external: true });
          return;
        }
        const value = amount.times(sign);
        add(cash(), { dq: value, kind: 'flow', amount: value, external: true });
        return;
      }
      case 'SPLIT':
        return;
      default:
        ignored.set(a.type, (ignored.get(a.type) ?? 0) + 1);
    }
  }
  for (const [type, count] of ignored) warnings.push(`Ignored ${count} ${type} activit${count === 1 ? 'y' : 'ies'}`);

  const ones = Array<Decimal>(n).fill(new Decimal(1));
  const fxCache = new Map<string, { values: Decimal[]; gaps: Gap[] }>([[baseCurrency, { values: ones, gaps: [] }]]);
  const fx = (ccy: string) => {
    if (!fxCache.has(ccy)) {
      const r = fillDaily(input.fxToBase[ccy] ?? [], days);
      if (!r) throw new Error(`No ${ccy}/${baseCurrency} exchange rate available`);
      fxCache.set(ccy, r);
    }
    return fxCache.get(ccy)!;
  };

  // ponytail: Decimal maths per line per calendar day; fine for a few years × tens of holdings.
  const capital = Array<Decimal>(n).fill(ZERO); // end-of-day portfolio value
  let externalFlows = ZERO;
  const raw: (Omit<LineResult, 'contributionPp' | 'pricePp' | 'fxPp' | 'incomePp'> & { paidOut: Decimal })[] = [];

  for (const [key, l] of lines) {
    const X = fx(l.currency).values;
    let P = ones;
    let gaps: Gap[] = [];
    if (l.kind === 'asset') {
      const quoted = fillDaily(splitAdjusted(input.quotes[l.id]?.points ?? [], splits.get(l.id) ?? []), days);
      const filled = quoted ?? fillDaily(l.tradePrices, days);
      if (!quoted && filled) warnings.push(`No quotes for ${l.id}; valued at its trade prices`);
      if (!filled) warnings.push(`No prices for ${l.id}; valued at 0`);
      P = filled?.values ?? Array<Decimal>(n).fill(ZERO);
      gaps = filled?.gaps ?? [];
    }

    let q = ZERO;
    const byDay = new Map<number, Ev[]>();
    for (const ev of l.events) {
      if (ev.date <= start) q = q.plus(ev.dq);
      else {
        const i = diffDays(start, ev.date);
        byDay.set(i, [...(byDay.get(i) ?? []), ev]);
      }
    }

    const held = Array<boolean>(n).fill(false); // end-of-day quantity ≠ 0
    held[0] = !q.isZero();
    const startValue = q.times(P[0]).times(X[0]);
    capital[0] = capital[0].plus(startValue);
    let priceEffect = ZERO,
      fxEffect = ZERO,
      netFlows = ZERO,
      income = ZERO,
      paidOut = ZERO;
    for (let i = 1; i < n; i++) {
      priceEffect = priceEffect.plus(q.times(P[i].minus(P[i - 1])).times(X[i]));
      fxEffect = fxEffect.plus(q.times(P[i - 1]).times(X[i].minus(X[i - 1])));
      for (const ev of byDay.get(i) ?? []) {
        const atClose = ev.dq.times(P[i]).times(X[i]);
        const v = ev.amount ? ev.amount.times(fx(ev.ccy).values[i]) : atClose;
        if (!ev.dq.isZero()) priceEffect = priceEffect.plus(atClose.minus(v));
        if (ev.kind === 'flow') netFlows = netFlows.plus(v);
        else {
          income = income.plus(v);
          if (ev.dq.isZero()) paidOut = paidOut.plus(v);
        }
        if (ev.external) externalFlows = externalFlows.plus(v);
        q = q.plus(ev.dq);
      }
      capital[i] = capital[i].plus(q.times(P[i]).times(X[i]));
      held[i] = !q.isZero();
    }
    // A stale price only matters on days the holding is actually held.
    gaps = gaps.filter((g) => {
      const from = Math.max(0, diffDays(start, g.from));
      return held.slice(from, diffDays(start, g.to)).some(Boolean);
    });

    const endValue = q.times(P[n - 1]).times(X[n - 1]);
    const gain = priceEffect.plus(fxEffect).plus(income);
    const residual = gain.minus(endValue.minus(startValue).minus(netFlows).plus(paidOut));
    if ([startValue, endValue, netFlows, income, gain].every((d) => d.isZero())) continue;
    raw.push({
      key,
      kind: l.kind,
      id: l.id,
      currency: l.currency,
      gaps,
      startValue,
      endValue,
      netFlows,
      income,
      priceEffect,
      fxEffect,
      gain,
      paidOut,
      residual,
      reconciled: residual.abs().lte(TOLERANCE),
    });
  }

  // Average capital = mean start-of-day value over days start+1..end.
  const averageCapital = n > 1 ? sum(capital.slice(0, n - 1)).div(n - 1) : ZERO;
  const pp = (x: Decimal) => (averageCapital.isZero() ? null : x.div(averageCapital).times(100));
  const withPp = <T extends { gain: Decimal; priceEffect: Decimal; fxEffect: Decimal; income: Decimal }>(c: T) => ({
    ...c,
    contributionPp: pp(c.gain),
    pricePp: pp(c.priceEffect),
    fxPp: pp(c.fxEffect),
    incomePp: pp(c.income),
  });

  const lineResults: LineResult[] = raw.map(({ paidOut: _, ...l }) => withPp(l));
  const totalOf = (k: keyof Pick<Components, 'startValue' | 'endValue' | 'netFlows' | 'income' | 'priceEffect' | 'fxEffect' | 'gain'>) =>
    sum(lineResults.map((l) => l[k]));
  const t = {
    startValue: totalOf('startValue'),
    endValue: totalOf('endValue'),
    netFlows: totalOf('netFlows'),
    income: totalOf('income'),
    priceEffect: totalOf('priceEffect'),
    fxEffect: totalOf('fxEffect'),
    gain: totalOf('gain'),
  };
  // Independent total check: internal flows (trades, dividends into cash) must cancel out,
  // leaving only external flows.
  const totalResidual = t.gain.minus(t.endValue.minus(t.startValue).minus(externalFlows));

  const keptCurrencies = new Set(lineResults.map((l) => l.currency));
  const fxGaps: Record<string, Gap[]> = {};
  for (const [ccy, { gaps }] of fxCache) if (gaps.length && keptCurrencies.has(ccy)) fxGaps[ccy] = gaps;

  return {
    baseCurrency,
    start,
    end,
    lines: lineResults,
    total: { ...withPp(t), externalFlows, residual: totalResidual, reconciled: totalResidual.abs().lte(TOLERANCE) },
    averageCapital,
    fxGaps,
    warnings,
  };
}

const relativeDistance = (v: Decimal, target: Decimal) => v.minus(target).abs().div(Decimal.max(target.abs(), 1));

/**
 * Put quotes on a split-adjusted basis. Like Wealthfolio, a split counts as already adjusted
 * by the provider when the close just before it is nearer the close just after it than
 * `ratio` times it; otherwise the earlier closes are divided by the ratio.
 */
export function splitAdjusted(points: PricePoint[], splits: { date: string; ratio: Decimal }[]): PricePoint[] {
  const unadjusted = splits.filter(({ date, ratio }) => {
    if (ratio.eq(1)) return false;
    const before = points
      .filter((p) => p.date < date)
      .sort((x, y) => (x.date < y.date ? -1 : 1))
      .at(-1);
    const after = points.filter((p) => p.date >= date).sort((x, y) => (x.date < y.date ? -1 : 1))[0];
    if (!before || !after || new Decimal(before.value).lte(0) || new Decimal(after.value).lte(0)) return false;
    const observed = new Decimal(before.value).div(after.value);
    return relativeDistance(observed, new Decimal(1)).gte(relativeDistance(observed, ratio));
  });
  if (unadjusted.length === 0) return points;
  return points.map((p) => {
    const factor = unadjusted.filter((sp) => p.date < sp.date).reduce((f, sp) => f.times(sp.ratio), new Decimal(1));
    return factor.eq(1) ? p : { ...p, value: new Decimal(p.value).div(factor).toString() };
  });
}
