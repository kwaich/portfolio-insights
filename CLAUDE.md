# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [Wealthfolio](https://wealthfolio.app) addon (SDK 3.9) with one page: per-holding FX attribution (price / FX / income effects) and contribution analysis (pp of average capital). It builds to a single ES module (`dist/addon.js`) that the Wealthfolio host loads into a sandbox.

## Commands

```bash
pnpm install
pnpm build                        # vite build → dist/addon.js
pnpm dev                          # vite build --watch
pnpm dev:server                   # wealthfolio-addon dev (hot-reload into a running Wealthfolio)
pnpm type-check                   # tsc --noEmit (also what `pnpm lint` runs; there is no ESLint)
pnpm test                         # vitest run (src/**/*.test.ts)
pnpm bundle                       # clean + build + zip dist/<name>-<version>.zip for distribution
```

## Architecture

- **Entry point:** `src/addon.tsx` default-exports an `AddonEnableFunction`. The host calls it with an `AddonContext` (`ctx`) that exposes `ctx.api`, `ctx.router`, `ctx.assets`, `ctx.onDisable`, etc.
- **Host owns React.** The host mounts the route component itself (`createElement(Component, { location })`) without passing `ctx`, so `enable` stashes `ctx` in a module-level `addonCtx` and the route wrapper reads it. Never call `createRoot` yourself.
- **Data fetching:** wrap pages in `QueryClientProvider` using `ctx.api.query.getClient()` — the addon's isolated React Query cache, with invalidations bridged to the host.
- **Routing/navigation is declared in `manifest.json`** (`contributes.routes` / `contributes.links.sidebar`), so the sidebar renders without booting the addon. The `id` passed to `ctx.router.add` must match `contributes.routes[].id`; path is `/addons/<addon id>`.
- **Host-provided dependencies:** React, react-dom, `@wealthfolio/addon-sdk`, `@wealthfolio/ui` (incl. `/chart`), `@tanstack/react-query`, `date-fns`, `lucide-react`, `recharts` are supplied by the host at runtime. They must stay in three places in sync: `peerDependencies` in `package.json`, `hostDependencies` in `manifest.json`, and the `hostProvidedDependencies` externals list in `vite.config.ts`. Adding a new SDK subpath import requires adding it to the Vite externals list. Any other dependency gets bundled into `addon.js`.
- **UI:** use components from `@wealthfolio/ui` and Tailwind v4 classes (via `@tailwindcss/vite`).
- **Permissions:** declared in `manifest.json` (accounts.getAll, settings.get, activities.getAll, quotes.getHistory, currency.getRatesForDates, performance.calculateSummary, market-data.sync, events.onUpdateComplete/onUpdateError). Calling any other host API needs a new entry. The SDK's `dist/src/permissions.d.ts` / `PERMISSION_CATEGORIES` is the authority: only `ui, navigation, query, toast, logger, storage` are baseline (the online docs disagree).
- **Storage:** `ctx.api.storage` (key `ui.prefs`) holds UI preferences only (period, account, custom range). Never store financial data there. `localStorage` is unavailable in the sandbox.
- `src/{components,hooks,lib,pages,types}/index.ts` are empty barrel stubs from the template.

## Code layout

- `src/lib/attribution/` is a pure TypeScript engine with no SDK imports; all money maths uses `decimal.js` (bundled). `attribute.ts` is the engine, `series.ts` does daily forward-fill and gap detection (>5 days), and `types.ts` holds the input/output shapes.
- `src/lib/load.ts` maps SDK data (activities, quote history, `getRatesForDates`) onto engine input and fetches Wealthfolio's TWR. Several accounts are passed as `filter: { type: 'accounts', accountIds }`, which the bridge forwards but the SDK type omits; `TOTAL` is a dead legacy id. HOLDINGS-mode accounts are excluded.
- `src/lib/load.ts` also has `resyncPrices`: `market.sync` only queues a host job (despite the SDK doc), so it waits for `portfolio:update-complete` before resolving.
- `src/lib/period.ts` turns a period choice into an engine range; `start` is the opening valuation date (the day before the first counted day).
- `src/pages/attribution-page.tsx` is the UI: period/account controls, summary, stacked bar chart, sortable table, and reconciliation/data-gap alerts.

## Engine conventions (keep consistent; the tests depend on them)

- Daily per line: price = q(t-1)·ΔP·X(t), fx = q(t-1)·P(t-1)·ΔX. Trades change q from t+1. The difference between a trade's cash value and its value at that day's close (execution price, fees) goes into the price effect.
- Splits mirror Wealthfolio (`portfolio-engine/src/resolve.rs`): the ratio comes from `amount`, falling back to `quantity`; rows for one asset within a day of each other count as one split. Quantities are in post-split units. `splitAdjusted()` detects quotes the provider didn't adjust (the close before the split is nearer ratio × the close after it than to that close) and divides the earlier closes by the ratio.
- Average capital = mean start-of-day portfolio value, cash included. Contribution = gain / average capital.
- Cash booking mirrors Wealthfolio's engine (`crates/portfolio-engine/src/compile.rs`): `amount` is the final cash (fees/taxes included); a BUY/SELL with `fxRate` in a currency other than `accountCurrency` settles in the account currency at amount × fxRate. Everything else settles in the activity currency.
- Cash is a line per currency (FX-only). Dividends are income on the holding plus an internal flow into cash. Standalone FEE/TAX count as negative income.
- Reconciliation: per line gain = end − start − flows + income paid out; total gain = end − start − external flows. Failures must be shown in the UI, never hidden.

## Sandbox constraints (from README)

- Build target is Chrome/Edge 107, Firefox 104, Safari 16 (matches Wealthfolio 3.9).
- Supported: packaged images, fonts, media, CSS, WebAssembly. Files under `assets/` and `dist/assets/` are indexed automatically — load them with `ctx.assets.getBlob(path)` / `ctx.assets.getUrl(path)` (blob URLs only live for the addon's lifetime; no manifest entry needed).
- **Not available:** workers/service workers, popups, direct network requests, remote CSS imports. Get data through `ctx.api`, not `fetch`.

## Testing against a local Wealthfolio

- `~/Projects/wealthfolio` is a local dev checkout (frontend on :1420, `pnpm dev:server` registers this addon on :3001). Debug addon failures from the browser console of `http://localhost:1420/addons/portfolio-insights`.
- "Timed out rendering add-on route" with `Cannot read properties of null (reading 'useMemo')` means the host sandbox bundle has two Reacts. The usual cause is a `pnpm install` from `~/Projects`, whose parent workspace lists `wealthfolio/packages/*`. Fix it by running `pnpm install` inside `~/Projects/wealthfolio` and restarting its sandbox watcher. It is not an addon bug.

## Versioning

Bump `version` in both `package.json` and `manifest.json` together, and update `CHANGELOG.md` (Keep a Changelog format).
