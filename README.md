# BitShares Historical Charts

Lightweight static web app to browse historical BitShares market data and liquidity-pool swaps. The app renders interactive charts (candles / OHLC, volume, price ranges) using data from Elasticsearch and uses a Graphene RPC helper for BitShares object lookups.

## Quick summary

- Static site (no build step). Open `index.html` (Pool price chart) or `books.html` (Order book history).
- Charts: klinecharts (loaded from CDN).
- Data sources:
  - Elasticsearch (configured in `main.js`)
  - BitShares node access via `graphene-rpc.js`
- Main JS files:
  - `index.html` -> `pools.js`, `main.js`
  - `books.html` -> `books.js`, `main.js`
  - `graphene-rpc.js` provides RPC helpers used by the pages
  - `search-engine.js` provides the asset/pool autocompletion used in the UI
- Styling: `main.css`

## Features

- View historical pool swap prices and volumes for a given pool ID (index.html).
- View historical mid-price/spread/depth candles derived from order books (books.html).
- Choose timeframe (1m, 5m, 15m, 1h, 1d, etc.) and load more historical data.
- Progress UI + error messages while Elasticsearch queries run.
- CSV export / local download hooks exist in the UI (if present in the codebase).
- No server-side code required other than access to Elasticsearch and a BitShares node.

## Files of interest

- `index.html` — Pool price chart UI (uses `pools.js` + `main.js`).
- `books.html` — Order book history UI (uses `books.js` + `main.js`).
- `main.js` — Shared UI utilities, chart initialization, progress overlay.
- `pools.js` — Queries Elasticsearch for pool swaps, parses results, converts to candles.
- `books.js` — Queries Elasticsearch for order-book history and converts trades to candles.
- `graphene-rpc.js` — Graphene/BitShares RPC helper (websocket handling, getObjects, etc.).
- `search-engine.js` — Autocomplete / suggestion engine used by forms.
- `main.css` — Styles.

## Getting started (local)

Because this is a static site you can run it with any static server or simply open the HTML files in a browser (some browsers require a server for XHR/Fetch requests).

## Usage (UI)

Pools (index.html)
- Enter Pool ID (e.g., `1.19.58`) in the Pool ID field.
- Choose timeframe (1m, 5m, 15m, 1h, 1d, ...).
- Click Update to fetch and render candles from Elasticsearch.
- "Load More" will extend the historical range.

Order book (books.html)
- Enter Asset A and Asset B (e.g., `BTS` and `USD`) and press Update.
- The page will resolve asset symbols to IDs using the Graphene RPC helper and query Elasticsearch for order-book-derived candles.

Common notes
- The app shows progress and error messages in the overlay. Check the browser console for debug output.
- If you see "No trading history found" or "Could not parse any valid trades", ensure:
  - The Elasticsearch index pattern matches the configured `ELASTICSEARCH_URL`.
  - The pool/asset IDs correspond to data indexed in ES.

## Development notes

- No package.json or build pipeline is required — editing HTML/CSS/JS files and reloading the browser is sufficient.
- Chart initialization uses klinecharts from CDN:
  ```html
  <script type="text/javascript" src="https://cdn.jsdelivr.net/npm/klinecharts/dist/klinecharts.min.js"></script>
  ```
- Key JS functions:
  - `getPoolSwaps` / `parseSwapHistory` (pools.js) — fetches and parses pool swap documents from ES.
  - `tradesToCandles` (main.js) — converts discrete trades into OHLC candles for klinecharts.
  - `GrapheneRPC` (graphene-rpc.js) — connection and helper methods to fetch object names/IDs and keep a ping/latency check.

## Deployment

- This is ideal for static hosting:
  - GitHub Pages: push to `gh-pages` branch or serve from `main` branch with the repository's settings.
  - Any static host (Netlify, Vercel as static site, S3 + CloudFront).
- Ensure Elasticsearch and BitShares node endpoints used by the client are reachable from your hosted domain, and configured with appropriate CORS headers.

## Contributing

- Open issues for bugs or feature requests.
- Fork and create a branch for your changes; this project uses plain HTML/JS so a small PR works well.

## License

The **Un**license.

## Maintainer / Contact

- Owner: squidKid-deluxe (GitHub)
