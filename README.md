# Portfolio Insights

A [Wealthfolio](https://wealthfolio.app) addon that breaks each holding's return into price, currency (FX) and income effects, and shows how much each holding contributed to the portfolio's return.

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm run dev:server
# Run unit tests (vitest), the type checker and the format check
pnpm test
pnpm run type-check
pnpm run format:check

# Build for production
pnpm run build

# Package addon
pnpm run bundle
```

Wealthfolio 3.9 indexes private files below `assets/` and `dist/assets/` automatically. Use
`ctx.assets.getBlob(path)` or `ctx.assets.getUrl(path)` to load them in the sandbox; no manifest
asset list or permission is required. Blob URLs are valid only for the current addon lifetime.

The generated Vite config targets Chrome/Edge 107, Firefox 104, and Safari 16, matching Wealthfolio
3.9. The sandbox supports packaged images, fonts, media, CSS, and WebAssembly. Worker/service-worker
entry points, popups, direct network requests, and remote CSS imports are intentionally unavailable.

## Features

- **FX attribution:** each holding's gain is split, day by day, into a price effect, an FX effect and income (dividends and interest, converted at the payment-date rate). Holdings in your base currency have no FX effect. Foreign cash balances get an FX-only line.
- **Contribution analysis:** each holding's gain is shown in percentage points of average daily portfolio value, and the contributions add up to the portfolio total. That total ("simple return on average capital") is shown next to Wealthfolio's own TWR.
- **Reconciliation checks:** price + FX + income is checked against start value, end value and net flows for every holding and for the total. Any mismatch is shown on the page.
- **Data handling:** cash, splits and fees are handled the way Wealthfolio's own engine handles them. A foreign-currency trade with an FX rate settles in the account's currency. Splits are detected whether or not the stored prices were already split-adjusted. Missing prices are forward-filled over weekends and holidays. Gaps longer than 5 days on days the holding was actually held are flagged, with a **Re-sync prices** button that asks Wealthfolio to re-download that holding's price history. Holdings sold during the period still show their realised gain. Money maths uses `decimal.js`.
- **Page:** period selector (1M, 3M, YTD, 1Y, since inception, custom), account filter, a sortable table with a totals row (income, price and FX effects also shown as %), and a bar chart of contributions split into price, FX and income. The last period and account you chose are remembered.
- **Permissions:** read access to accounts, settings (base currency), activities, quote history, historical exchange rates and performance. Market-data sync and portfolio-update events are used only by the Re-sync prices button. No network access: the addon never contacts the internet itself.

Known limits: accounts that track holdings without transactions are excluded, because they have no trade history. FX rate gaps can't be detected, because Wealthfolio fills them in silently.

## License

MIT
