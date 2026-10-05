# Changelog

All notable changes to the portfolio-insights addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial addon structure and setup
- Attribution engine (`src/lib/attribution`): daily price/FX/income attribution, contribution in pp of average capital, reconciliation checks, quote-gap detection, with vitest unit tests
- Data loader mapping Wealthfolio activities, quotes and FX rates onto the engine
- "Re-sync prices" button on missing-price notes: asks Wealthfolio to re-download that holding's quote history (`market-data` and `events` permissions), then reloads the report
- Portfolio Insights page: period selector (1M, 3M, YTD, 1Y, since inception, custom), account filter, sortable attribution table with totals, contribution bar chart split into price/FX/income, reconciliation and data-gap alerts; last period/account remembered in addon storage

### Changed
- Funds whose symbol is a Morningstar id (e.g. `0P0001AF7U`) are shown by name; long chart labels are shortened
- Re-sync now shows a toast with the result: a warning if the gap is still there after re-downloading, otherwise a confirmation

### Deprecated

### Removed

### Fixed
- Splits follow Wealthfolio's rules: the ratio comes from `amount`, falling back to `quantity`; quotes that weren't split-adjusted by the provider are detected and adjusted; the same split recorded twice within a day (e.g. in two accounts) counts once
- Wealthfolio's TWR for several accounts now uses the host's account-scope filter (the legacy `TOTAL` id failed, so "All accounts" showed n/a)
- Cash now follows Wealthfolio's own booking rules: a foreign-currency BUY/SELL with an `fxRate` settles in the account currency (it used to create a negative foreign-cash balance), and `amount` is the final cash with fees/taxes already included (fees and taxes were subtracted twice for dividends, deposits and withdrawals)
- Price gaps are only flagged on days the holding is actually held (no more false alarms for holdings bought mid-period)

### Security

## [1.0.0] - {{currentDate}}

### Added
- Initial release of portfolio-insights addon
- Basic addon functionality and core features
- Integration with Wealthfolio addon SDK v3.9.0
- Sidebar navigation integration for easy access
- Responsive design for all screen sizes

### Features
- A Wealthfolio addon for portfolio-insights
- User-friendly interface
- Compatible with Wealthfolio platform

### Compatibility
- Requires Wealthfolio 3.9.0 or newer
