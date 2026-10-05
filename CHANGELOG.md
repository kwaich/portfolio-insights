# Changelog

All notable changes to the portfolio-insights addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-05

First release.

### Added
- Portfolio Insights page with per-holding FX attribution and contribution analysis
  - Period selector (1M, 3M, YTD, 1Y, since inception, custom) and account filter; the last choice is remembered in addon storage
  - Summary of currency effect, total gain, simple return on average capital, and Wealthfolio's TWR for comparison
  - Contribution chart split into price, FX and income; long fund names are shortened, with the full name on hover
  - Sortable table per holding and per cash currency, with totals
  - Contributions shown as % of average capital
- Attribution engine (`src/lib/attribution`): daily price/FX/income attribution in decimal maths, with vitest unit tests
  - Income converted at the payment-date FX rate; trades take effect from the next day
  - Foreign cash gets an FX-only line; sold holdings stay in the report
  - Cash booking and splits follow Wealthfolio's own engine (settlement via `fxRate`, `amount` as final cash, split ratio from `amount` or `quantity`, duplicate splits merged, unadjusted quotes detected)
- Reconciliation check per holding and for the total; failures are shown on the page
- Data checks: prices and FX rates are forward-filled, and gaps over 5 days while a holding is held are flagged
  - The "Missing prices" alert is collapsible and shows how many holdings are affected
  - "Re-sync prices" asks Wealthfolio to re-download a holding's quote history, reloads the report, and says whether the gap is still there
- Funds whose symbol is a Morningstar id (e.g. `0P0001AF7U`) are shown by name
- Holdings-mode accounts (no trade history) are excluded with a note

### Compatibility
- Requires Wealthfolio 3.9.0 or newer
- Permissions: accounts, settings, activities, quotes, currency rates, performance, market-data sync and portfolio update events; no network access
