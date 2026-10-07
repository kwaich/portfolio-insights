import type { Asset, HostAPI, Quote, UnlistenFn } from '@wealthfolio/addon-sdk';
import { format } from 'date-fns';
import { addDays, daysBetween } from './attribution/series';
import type { AttributionInput, EngineActivity, PricePoint } from './attribution/types';

const FX_CHUNK = 500;
const SYNC_TIMEOUT_MS = 120_000;
const MORNINGSTAR_ID = /^0P[0-9A-Z]{8}$/;

// Activities carry a timestamp: take the user's local calendar day. Quote timestamps
// are already exchange days, so take the date part as is.
const localDay = (d: Date | string) => format(new Date(d), 'yyyy-MM-dd');
const isCashAsset = (id?: string | null) => !id || id.startsWith('$CASH');

interface LoadedInput {
  input: AttributionInput;
  /** HOLDINGS-mode accounts have no trade history, so they are left out. */
  excludedAccounts: string[];
  /** Accounts the report covers. */
  accountIds: string[];
  warnings: string[];
  /** Display label per asset id. */
  names: Record<string, string>;
  /** Wealthfolio's TWR over the same accounts and dates. */
  twr: number | null;
}

export type BaseData = Awaited<ReturnType<typeof loadBase>>;

/** Everything that doesn't depend on the chosen period or account. */
export async function loadBase(api: HostAPI) {
  const [settings, accounts, activities] = await Promise.all([api.settings.get(), api.accounts.getAll(), api.activities.getAll()]);
  const assetIds = [...new Set(activities.flatMap((a) => (isCashAsset(a.assetId) ? [] : [a.assetId])))];
  const multipliers: Record<string, string> = {};
  const profileErrors: string[] = [];
  await Promise.all(
    assetIds.map((id) =>
      api.assets.getProfile(id).then(
        (asset) => void (multipliers[id] = contractMultiplier(asset)),
        (e) => void profileErrors.push(`Asset profile for ${id} unavailable (${e}); valued at 1 unit per contract`),
      ),
    ),
  );
  return { settings, accounts, activities, multipliers, profileErrors };
}

/** Mirrors Wealthfolio's `contract_multiplier_from_asset_metadata` (core/src/assets/assets_model.rs). */
function contractMultiplier(asset: Asset): string {
  const isOption = asset.instrumentType === 'OPTION';
  const m = asset.metadata ?? {};
  const option = m.option as { multiplier?: unknown } | undefined;
  const explicit = isOption && option?.multiplier != null ? option.multiplier : m.contractMultiplier;
  const n = Number(explicit);
  return explicit != null && n > 0 ? String(explicit) : isOption ? '100' : '1';
}

/** `start: null` means since inception (the day before the first activity). */
export async function loadAttributionInput(
  api: HostAPI,
  base: BaseData,
  opts: { accountId?: string; start: string | null; end: string },
  getHistory: (assetId: string) => Promise<Quote[]>,
): Promise<LoadedInput> {
  const { settings, accounts } = base;
  const rawActivities = opts.accountId ? base.activities.filter((a) => a.accountId === opts.accountId) : base.activities;
  const baseCurrency = settings.baseCurrency;
  const excluded = accounts.filter((a) => a.trackingMode === 'HOLDINGS' && (!opts.accountId || a.id === opts.accountId));
  const excludedIds = new Set(excluded.map((a) => a.id));
  const accountIds = accounts.filter((a) => (!opts.accountId || a.id === opts.accountId) && !excludedIds.has(a.id)).map((a) => a.id);

  const activities: EngineActivity[] = rawActivities
    .filter((a) => !excludedIds.has(a.accountId) && (a.status == null || a.status === 'POSTED'))
    .map((a) => ({
      date: localDay(a.date),
      type: a.activityType,
      subtype: a.subtype,
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
  for (const a of rawActivities) {
    if (isCashAsset(a.assetId)) continue;
    // Funds often have a Morningstar id (e.g. 0P0001AF7U) as their symbol; their name reads better.
    const symbol = MORNINGSTAR_ID.test(a.assetSymbol) ? '' : a.assetSymbol;
    names[a.assetId] = symbol || a.assetName || a.assetSymbol || a.assetId;
  }

  const firstDay = activities.reduce((m, a) => (a.date < m ? a.date : m), opts.end);
  const start = opts.start ?? addDays(firstDay, -1);

  // Started now so it overlaps the quote and FX requests; loadTwr never rejects.
  const twr = loadTwr(api, accountIds, start, opts.end);

  const days = daysBetween(start, opts.end);
  const warnings = new Set<string>(base.profileErrors);
  const fxToBase: Record<string, PricePoint[]> = {};
  const fetchRates = async (currencies: Set<string>) => {
    currencies.delete(baseCurrency);
    const pairs = [...currencies].flatMap((c) => days.map((date) => ({ fromCurrency: c, toCurrency: baseCurrency, date })));
    const chunks = [];
    for (let i = 0; i < pairs.length; i += FX_CHUNK) chunks.push(api.exchangeRates.getRatesForDates(pairs.slice(i, i + FX_CHUNK)));
    for (const r of (await Promise.all(chunks)).flat()) {
      if (r.rate == null) warnings.add(`FX ${r.fromCurrency}/${r.toCurrency}: ${r.error ?? 'no rate'}`);
      else (fxToBase[r.fromCurrency] ??= []).push({ date: r.date, value: r.rate });
    }
  };

  const assetIds = [...new Set(activities.flatMap((a) => (a.assetId ? [a.assetId] : [])))];
  const activityCurrencies = new Set(activities.map((a) => a.currency));
  const [histories] = await Promise.all([Promise.all(assetIds.map(getHistory)), fetchRates(new Set(activityCurrencies))]);
  const quotes: AttributionInput['quotes'] = {};
  assetIds.forEach((id, i) => {
    const qs = histories[i];
    if (qs.length === 0) return;
    quotes[id] = {
      currency: qs[qs.length - 1].currency,
      points: qs.map((q) => ({ date: q.timestamp.slice(0, 10), value: q.close })).filter((p) => p.date <= opts.end),
    };
  });
  // Quote currencies nobody traded in (rare) are only known now.
  await fetchRates(
    new Set(
      Object.values(quotes)
        .map((q) => q.currency)
        .filter((c) => !activityCurrencies.has(c)),
    ),
  );

  return {
    input: { baseCurrency, start, end: opts.end, activities, quotes, fxToBase, multipliers: base.multipliers },
    excludedAccounts: excluded.map((a) => a.name),
    accountIds,
    warnings: [...warnings],
    names,
    twr: await twr,
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
export async function resyncPrices(api: HostAPI, assetId: string): Promise<void> {
  let unlisten: UnlistenFn[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Wealthfolio did not finish the price sync in time')), SYNC_TIMEOUT_MS);
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
