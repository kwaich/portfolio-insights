import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AnimatedToggleGroup,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePickerWithRange,
  Page,
  PageContent,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@wealthfolio/ui';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  ReferenceLine,
  XAxis,
  YAxis,
  type ChartConfig,
} from '@wealthfolio/ui/chart';
import { format, parseISO } from 'date-fns';
import type Decimal from 'decimal.js';
import { AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { attribute } from '../lib/attribution/attribute';
import type { Components, LineResult } from '../lib/attribution/types';
import { loadAttributionInput, loadTwr, resyncPrices } from '../lib/load';
import { periodRange, type Period } from '../lib/period';

const PREFS_KEY = 'ui.prefs';
const ALL = 'all';

interface Prefs {
  period: Period;
  accountId: string;
  from?: string;
  to?: string;
}
const DEFAULT_PREFS: Prefs = { period: 'YTD', accountId: ALL };

const PERIODS: { value: Period; label: string }[] = [
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: 'YTD', label: 'YTD' },
  { value: '1Y', label: '1Y' },
  { value: 'ALL', label: 'Since inception' },
  { value: 'CUSTOM', label: 'Custom' },
];

type SortKey = 'name' | 'startValue' | 'endValue' | 'netFlows' | 'income' | 'priceEffect' | 'fxEffect' | 'gain' | 'contributionPp';
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Holding' },
  { key: 'startValue', label: 'Start value' },
  { key: 'endValue', label: 'End value' },
  { key: 'netFlows', label: 'Net flows' },
  { key: 'income', label: 'Income' },
  { key: 'priceEffect', label: 'Price effect' },
  { key: 'fxEffect', label: 'FX effect' },
  { key: 'gain', label: 'Total gain' },
  { key: 'contributionPp', label: 'Contribution' },
];

const chartConfig = {
  price: { label: 'Price', color: 'var(--chart-1)' },
  fx: { label: 'FX', color: 'var(--chart-2)' },
  income: { label: 'Income', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const pct = new Intl.NumberFormat(undefined, {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
/** `n` is in percent (pp); `empty` when it can't be computed. */
const fmtPct = (n: number | null | undefined, empty = 'n/a') => (n == null ? empty : pct.format(n / 100));
// Colour by the value as shown (2 dp), so a figure that rounds to zero stays uncoloured.
const signClass = (d: Decimal) => {
  const r = d.toDecimalPlaces(2);
  return r.gt(0) ? 'text-success' : r.lt(0) ? 'text-destructive' : '';
};

function usePrefs(ctx: AddonContext) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    ctx.api.storage
      .get(PREFS_KEY)
      .then((v) => setPrefs(v ? { ...DEFAULT_PREFS, ...(JSON.parse(v) as Partial<Prefs>) } : DEFAULT_PREFS))
      .catch((e) => {
        ctx.api.logger.warn(`Could not read saved preferences: ${String(e)}`);
        setPrefs(DEFAULT_PREFS);
      });
  }, [ctx]);
  const update = (patch: Partial<Prefs>) => {
    const next = { ...(prefs ?? DEFAULT_PREFS), ...patch };
    setPrefs(next);
    ctx.api.storage.set(PREFS_KEY, JSON.stringify(next)).catch((e) => ctx.api.logger.warn(`Could not save preferences: ${String(e)}`));
  };
  return [prefs, update] as const;
}

export function AttributionPage({ ctx }: { ctx: AddonContext }) {
  const [prefs, updatePrefs] = usePrefs(ctx);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'contributionPp', desc: true });
  const today = useMemo(() => new Date(), []);

  const accounts = useQuery({ queryKey: ['portfolio-insights', 'accounts'], queryFn: () => ctx.api.accounts.getAll() });

  const accountId = prefs && prefs.accountId !== ALL ? prefs.accountId : undefined;
  const custom = { from: prefs?.from ? parseISO(prefs.from) : undefined, to: prefs?.to ? parseISO(prefs.to) : undefined };
  const range = prefs ? periodRange(prefs.period, today, custom) : undefined;

  const reportKey = ['portfolio-insights', 'attribution', accountId ?? ALL, range?.start ?? 'inception', range?.end];
  const report = useQuery({
    queryKey: reportKey,
    enabled: !!range,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const loaded = await loadAttributionInput(ctx.api, { accountId, start: range!.start, end: range!.end });
      const result = attribute(loaded.input);
      const twr = await loadTwr(ctx.api, loaded.accountIds, loaded.input.start, loaded.input.end);
      return { ...loaded, result, twr };
    },
  });

  const queryClient = useQueryClient();
  const resync = useMutation({
    mutationFn: (assetId: string) => resyncPrices(ctx.api, assetId),
    onSuccess: async (_, assetId) => {
      // Resolves once active report queries have refetched, so the cache holds the new gaps.
      await queryClient.invalidateQueries({ queryKey: ['portfolio-insights', 'attribution'] });
      const fresh = queryClient.getQueryData<typeof report.data>(reportKey);
      const line = fresh?.result.lines.find((l) => l.kind === 'asset' && l.id === assetId);
      const name = fresh?.names[assetId] ?? assetId;
      if (line?.gaps.length) {
        const gaps = line.gaps.map((g) => `${g.from} to ${g.to}`).join(', ');
        ctx.api.toast.warning(`${name}: still no prices from ${gaps} after re-sync. The last known price is used.`);
      } else {
        ctx.api.toast.success(`${name}: prices updated.`);
      }
    },
    onError: (e) => ctx.api.toast.error(`Price re-sync failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const data = report.data;
  const nameOf = (l: LineResult) => (l.kind === 'cash' ? `Cash ${l.id}` : (data?.names[l.id] ?? l.id));

  const rows = useMemo(() => {
    if (!data) return [];
    const value = (l: LineResult) => (sort.key === 'name' ? nameOf(l) : (l[sort.key]?.toNumber() ?? 0));
    return [...data.result.lines].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const c = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [data, sort]);

  const ccy = data?.result.baseCurrency ?? 'USD';
  const money = useMemo(() => new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy }), [ccy]);
  const signed = useMemo(() => new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, signDisplay: 'exceptZero' }), [ccy]);

  const notices = data
    ? [
        ...data.excludedAccounts.map((n) => `Account "${n}" uses holdings tracking (no trade history) and is excluded.`),
        ...data.warnings,
        ...data.result.warnings,
        ...Object.entries(data.result.fxGaps).flatMap(([c, gs]) =>
          gs.map((g) => `${c} FX: no rate from ${g.from} to ${g.to} (${g.days} days).`),
        ),
      ]
    : [];
  const gapLines = data ? data.result.lines.filter((l) => l.kind === 'asset' && l.gaps.length > 0) : [];
  const unreconciled = data ? data.result.lines.filter((l) => !l.reconciled) : [];

  return (
    <Page>
      <PageHeader heading="Portfolio Insights" text="FX attribution and contribution analysis" />
      <PageContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <AnimatedToggleGroup
            aria-label="Period"
            items={PERIODS}
            value={prefs?.period ?? null}
            onValueChange={(period) => updatePrefs({ period })}
            size="sm"
          />
          {prefs?.period === 'CUSTOM' && (
            <DatePickerWithRange
              date={custom}
              onDateChange={(r) =>
                updatePrefs({
                  from: r?.from ? format(r.from, 'yyyy-MM-dd') : undefined,
                  to: r?.to ? format(r.to, 'yyyy-MM-dd') : undefined,
                })
              }
            />
          )}
          <Select value={prefs?.accountId ?? ALL} onValueChange={(accountId) => updatePrefs({ accountId })}>
            <SelectTrigger className="w-[220px]" aria-label="Account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All accounts</SelectItem>
              {accounts.data?.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!range && prefs && <p className="text-muted-foreground text-sm">Pick a start and end date.</p>}
        {report.isLoading && <Skeleton className="h-96 w-full" />}
        {report.error && (
          <Alert variant="destructive">
            <AlertTitle>Could not build the report</AlertTitle>
            <AlertDescription>{String(report.error instanceof Error ? report.error.message : report.error)}</AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            {(unreconciled.length > 0 || !data.result.total.reconciled) && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Reconciliation failed</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {unreconciled.map((l) => (
                      <li key={l.key}>
                        {nameOf(l)}: price + FX + income is off by {money.format(l.residual.toNumber())}
                      </li>
                    ))}
                    {!data.result.total.reconciled && (
                      <li>
                        Portfolio total is off from (end − start − external flows) by {money.format(data.result.total.residual.toNumber())}
                      </li>
                    )}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {gapLines.length > 0 && (
              <Alert variant="warning">
                <details>
                  <summary className="cursor-pointer">
                    <AlertTitle className="inline">
                      Missing prices ({gapLines.length} {gapLines.length === 1 ? 'holding' : 'holdings'})
                    </AlertTitle>
                  </summary>
                  <AlertDescription className="mt-2">
                    <ul className="space-y-2">
                      {gapLines.map((l) => (
                        <li key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>
                            {nameOf(l)}: {l.gaps.map((g) => `no price from ${g.from} to ${g.to} (${g.days} days)`).join('; ')}. The last
                            known price was used for those days.
                          </span>
                          <Button size="sm" variant="outline" disabled={resync.isPending} onClick={() => resync.mutate(l.id)}>
                            {resync.isPending && resync.variables === l.id ? 'Re-syncing…' : 'Re-sync prices'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </details>
              </Alert>
            )}
            {notices.length > 0 && (
              <Alert variant="warning">
                <AlertTitle>Data notes</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {notices.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <Summary total={data.result.total} twr={data.twr} signed={signed} start={data.input.start} end={data.input.end} />

            {rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">No holdings in this period.</p>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Contribution by holding (%)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ContributionChart lines={rows} nameOf={nameOf} />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="overflow-x-auto p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {COLUMNS.map((c) => (
                            <TableHead
                              key={c.key}
                              className={c.key === 'name' ? '' : 'text-right'}
                              aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                            >
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 hover:underline"
                                onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== 'name' }))}
                              >
                                {c.label}
                                {sort.key === c.key && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                              </button>
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((l) => (
                          <TableRow key={l.key}>
                            <TableCell className="font-medium">
                              <span className="inline-flex items-center gap-1">
                                {nameOf(l)}
                                {!l.reconciled && (
                                  <AlertTriangle
                                    className="text-destructive h-4 w-4"
                                    aria-label={`Does not reconcile (off by ${money.format(l.residual.toNumber())})`}
                                  />
                                )}
                              </span>
                              {l.kind === 'asset' && l.currency !== ccy && (
                                <span className="text-muted-foreground ml-1 text-xs">{l.currency}</span>
                              )}
                            </TableCell>
                            <ValueCells c={l} money={money} signed={signed} />
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow className="font-semibold">
                          <TableCell>Total</TableCell>
                          <ValueCells c={data.result.total} money={money} signed={signed} />
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </>
        )}
      </PageContent>
    </Page>
  );
}

function ValueCells({ c, money, signed }: { c: Components; money: Intl.NumberFormat; signed: Intl.NumberFormat }) {
  const cell = (d: Decimal, f: Intl.NumberFormat, colored = false, pp?: Decimal | null) => (
    <TableCell className={`text-right tabular-nums ${colored ? signClass(d) : ''}`}>
      {f.format(d.toNumber())}
      {pp !== undefined && <div className="text-xs">{fmtPct(pp?.toNumber(), '–')}</div>}
    </TableCell>
  );
  return (
    <>
      {cell(c.startValue, money)}
      {cell(c.endValue, money)}
      {cell(c.netFlows, signed)}
      {cell(c.income, signed, true)}
      {cell(c.priceEffect, signed, true, c.pricePp)}
      {cell(c.fxEffect, signed, true, c.fxPp)}
      {cell(c.gain, signed, true)}
      <TableCell className={`text-right tabular-nums ${c.contributionPp ? signClass(c.contributionPp) : ''}`}>
        {fmtPct(c.contributionPp?.toNumber(), '–')}
      </TableCell>
    </>
  );
}

function Summary({
  total,
  twr,
  signed,
  start,
  end,
}: {
  total: Components;
  twr: number | null;
  signed: Intl.NumberFormat;
  start: string;
  end: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <p className="text-lg">
          {total.fxPp
            ? `Currency moves contributed ${fmtPct(total.fxPp.toNumber())} this period.`
            : 'No capital was invested during this period, so contributions cannot be computed.'}
        </p>
        <div className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <span>
            {start} → {end}
          </span>
          <span>
            Total gain{' '}
            <span className={`text-foreground font-medium ${signClass(total.gain)}`}>{signed.format(total.gain.toNumber())}</span>
          </span>
          <span>
            Simple return on average capital <span className="text-foreground font-medium">{fmtPct(total.contributionPp?.toNumber())}</span>
          </span>
          <span>
            Wealthfolio TWR <span className="text-foreground font-medium">{fmtPct(twr == null ? null : twr * 100)}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ContributionChart({ lines, nameOf }: { lines: LineResult[]; nameOf: (l: LineResult) => string }) {
  const data = [...lines]
    .sort((a, b) => (b.contributionPp?.toNumber() ?? 0) - (a.contributionPp?.toNumber() ?? 0))
    .map((l) => ({
      name: nameOf(l),
      price: l.pricePp?.toNumber() ?? 0,
      fx: l.fxPp?.toNumber() ?? 0,
      income: l.incomePp?.toNumber() ?? 0,
    }));
  return (
    <ChartContainer config={chartConfig} className="w-full" style={{ height: Math.max(160, data.length * 32 + 60) }}>
      <BarChart data={data} layout="vertical" stackOffset="sign" margin={{ left: 8, right: 16 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
        <YAxis
          type="category"
          dataKey="name"
          width={190}
          tickLine={false}
          axisLine={false}
          // A plain <text> instead of recharts' default tick, which wraps long labels onto two lines.
          tick={({ x, y, payload }: { x: number | string; y: number | string; payload: { value: string } }) => (
            <text x={x} y={y} dy={4} textAnchor="end" fontSize={12}>
              <title>{payload.value}</title>
              {payload.value.length > 20 ? `${payload.value.slice(0, 19)}…` : payload.value}
            </text>
          )}
        />
        <ReferenceLine x={0} stroke="var(--border)" />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(v, name) => (
                <div className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{chartConfig[name as keyof typeof chartConfig]?.label ?? name}</span>
                  <span className="font-mono tabular-nums">{Number(v).toFixed(2)}%</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="price" stackId="c" fill="var(--color-price)" />
        <Bar dataKey="fx" stackId="c" fill="var(--color-fx)" />
        <Bar dataKey="income" stackId="c" fill="var(--color-income)" />
      </BarChart>
    </ChartContainer>
  );
}
