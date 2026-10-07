import type Decimal from 'decimal.js';

/** Dates are calendar days, YYYY-MM-DD. Money/quantity fields are decimal strings. */
export interface EngineActivity {
  date: string;
  /** BUY, SELL, SPLIT, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, CREDIT, ADJUSTMENT */
  type: string;
  /** ADJUSTMENT with OPTION_EXPIRY closes `quantity` of an option at zero. */
  subtype?: string | null;
  /** Omit for pure cash activities. */
  assetId?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  /** Final cash moved, fees and taxes already included (Wealthfolio semantics); for SPLIT the split ratio (2 = 2-for-1). */
  amount?: string | null;
  fee?: string | null;
  tax?: string | null;
  /** Currency of amount and unitPrice. */
  currency: string;
  /** With fxRate, a BUY/SELL in a foreign currency settles in this currency at amount × fxRate. */
  accountCurrency?: string;
  fxRate?: string | null;
}

export interface PricePoint {
  date: string;
  value: number | string;
}

export interface AttributionInput {
  baseCurrency: string;
  /** Valuation date of the starting snapshot (end of day). Effects are summed over start+1..end. */
  start: string;
  end: string;
  /** All activities up to `end`, including those before `start` (they build opening positions). */
  activities: EngineActivity[];
  /** Split-adjusted daily closes per asset, in the asset's quote currency. */
  quotes: Record<string, { currency: string; points: PricePoint[] }>;
  /** Units per contract per asset (options: usually 100); missing means 1. Quotes and unit prices are per unit. */
  multipliers?: Record<string, string>;
  /** Units of base currency per 1 unit of the keyed currency. The base currency itself is implied as 1. */
  fxToBase: Record<string, PricePoint[]>;
}

export interface Gap {
  from: string;
  to: string;
  days: number;
}

export interface Components {
  startValue: Decimal;
  endValue: Decimal;
  /** Buys − sells and transfers (asset lines); every non-income balance change (cash lines). */
  netFlows: Decimal;
  income: Decimal;
  priceEffect: Decimal;
  fxEffect: Decimal;
  gain: Decimal;
  /** Percentage points of average capital; null when average capital is zero. */
  contributionPp: Decimal | null;
  pricePp: Decimal | null;
  fxPp: Decimal | null;
  incomePp: Decimal | null;
  /** gain − (end − start − netFlows + income paid out of the line). Should be ~0. */
  residual: Decimal;
  reconciled: boolean;
}

export interface LineResult extends Components {
  key: string;
  kind: 'asset' | 'cash';
  /** Asset id for asset lines; currency code for cash lines. */
  id: string;
  currency: string;
  gaps: Gap[];
}

export interface AttributionResult {
  baseCurrency: string;
  start: string;
  end: string;
  lines: LineResult[];
  /** Totals; `residual` here is checked against external flows (deposits, withdrawals, transfers). */
  total: Components & { externalFlows: Decimal };
  /** Mean start-of-day portfolio value over the period. */
  averageCapital: Decimal;
  fxGaps: Record<string, Gap[]>;
  warnings: string[];
}
