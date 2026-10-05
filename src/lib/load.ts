import type { HostAPI, UnlistenFn } from '@wealthfolio/addon-sdk';
import { format } from 'date-fns';
import { addDays, daysBetween } from './attribution/series';
import type { AttributionInput, EngineActivity, PricePoint } from './attribution/types';

const FX_CHUNK = 500;

// Activities carry a timestamp: take the user's local calendar day. Quote timestamps
// are already exchange days, so take the date part as is.
const localDay = (d: Date | string) => format(new Date(d), 'yyyy-MM-dd');
const isCashAsset = (id?: string | null) => !id || id.startsWith('$CASH');

export interface LoadedInput {
  input: AttributionInput;
  /** HOLDINGS-mode accounts have no trade history, so they are left out. */
  excludedAccounts: string[];
  /** Accounts the report covers. */
  accountIds: string[];
  warnings: string[];
  /** Display label per asset id. */
  names: Record<string, string>;
}

/** `start: null` means since inception (the day before the first activity). */
export async function loadAttributionInput(
  api: HostAPI,
  opts: { accountId?: string; start: string | null; end: string },
): Promise<LoadedInput> {
  const [settings, accounts, rawActivities] = await Promise.all([
    api.settings.get(),
    api.accounts.getAll(),
    api.activities.getAll(opts.accountId),
  ]);
  const baseCurrency = settings.baseCurrency;
  const excluded = accounts.filter((a) => a.trackingMode === 'HOLDINGS' && (!opts.accountId || a.id === opts.accountId));
  const excludedIds = new Set(excluded.map((a) => a.id));
  const accountIds = accounts
    .filter((a) => (!opts.accountId || a.id === opts.accountId) && !excludedIds.has(a.id))
    .map((a) => a.id);

  const activities: EngineActivity[] = rawActivities
    .filter((a) => !excludedIds.has(a.accountId) && (a.status == null || a.status === 'POSTED'))
    .map((a) => ({
      date: localDay(a.date),
      type: a.activityType,
      assetId: isCashAsset(a.assetId) ? null : a.assetId,
      quantity: a.quantity,
      unitPrice: a.unitPrice,
      amount: a.amount,
      fee: a.fee,
      tax: a.tax,
      currency: a.currency,
      accountCurrency: a.accountCurrency,
      fxRate: a.fxRate,
    }))
    .filter((a) => a.date <= opts.end);

  const names: Record<string, string> = {};
  for (const a of rawActivities) if (!isCashAsset(a.assetId)) names[a.assetId] = a.assetSymbol || a.assetName || a.assetId;

  const firstDay = activities.reduce((m, a) => (a.date < m ? a.date : m), opts.end);
  const start = opts.start ?? addDays(firstDay, -1);

  const assetIds = [...new Set(activities.flatMap((a) => (a.assetId ? [a.assetId] : [])))];
  const histories = await Promise.all(assetIds.map((id) => api.quotes.getHistory(id)));
  const quotes: AttributionInput['quotes'] = {};
  assetIds.forEach((id, i) => {
    const qs = histories[i];
    if (qs.length === 0) return;
    quotes[id] = {
      currency: qs[qs.length - 1].currency,
      points: qs.map((q) => ({ date: q.timestamp.slice(0, 10), value: q.close })).filter((p) => p.date <= opts.end),
    };
  });

  const currencies = new Set([...activities.map((a) => a.currency), ...Object.values(quotes).map((q) => q.currency)]);
  currencies.delete(baseCurrency);
  const days = daysBetween(start, opts.end);
  const pairs = [...currencies].flatMap((c) => days.map((date) => ({ fromCurrency: c, toCurrency: baseCurrency, date })));
  const fxToBase: Record<string, PricePoint[]> = {};
  const warnings = new Set<string>();
  for (let i = 0; i < pairs.length; i += FX_CHUNK) {
    for (const r of await api.exchangeRates.getRatesForDates(pairs.slice(i, i + FX_CHUNK))) {
      if (r.rate == null) warnings.add(`FX ${r.fromCurrency}/${r.toCurrency}: ${r.error ?? 'no rate'}`);
      else (fxToBase[r.fromCurrency] ??= []).push({ date: r.date, value: r.rate });
    }
  }

  return {
    input: { baseCurrency, start, end: opts.end, activities, quotes, fxToBase },
    excludedAccounts: excluded.map((a) => a.name),
    accountIds,
    warnings: [...warnings],
    names,
  };
}

/**
 * Wealthfolio's own TWR over the same accounts; null if the host can't compute it.
 * Several accounts need the host's account-scope `filter`, which the bridge forwards but the
 * SDK type doesn't declare (the old "TOTAL" pseudo-account id no longer works).
 */
export async function loadTwr(api: HostAPI, accountIds: string[], start: string, end: string): Promise<number | null> {
  if (accountIds.length === 0) return null;
  const args =
    accountIds.length === 1
      ? { itemType: 'account' as const, itemId: accountIds[0], startDate: start, endDate: end }
      : {
          itemType: 'account' as const,
          itemId: 'portfolio-insights:scope',
          startDate: start,
          endDate: end,
          filter: { type: 'accounts', accountIds },
        };
  try {
    const r = await api.performance.calculateSummary(args);
    return r.returns.twr ?? null;
  } catch (e) {
    api.logger.warn(`TWR unavailable for ${accountIds.join(', ')}: ${String(e)}`);
    return null;
  }
}

/**
 * Re-download an asset's quote history. `market.sync` only queues a background job on the
 * host, so wait for Wealthfolio's portfolio-update event before reporting completion.
 */
export async function resyncPrices(api: HostAPI, assetId: string, timeoutMs = 120_000): Promise<void> {
  let unlisten: UnlistenFn[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Wealthfolio did not finish the price sync in time')), timeoutMs);
      const settle = (fn: () => void) => () => {
        clearTimeout(timer);
        fn();
      };
      Promise.all([
        api.events.portfolio.onUpdateComplete(settle(resolve)),
        api.events.portfolio.onUpdateError<unknown>((e) => settle(() => reject(new Error(String(e.payload))))()),
      ])
        .then((u) => {
          unlisten = u;
          return api.market.sync([assetId], true);
        })
        .catch((e: unknown) => settle(() => reject(e))());
    });
  } finally {
    unlisten.forEach((u) => u());
  }
}
