Server workspace

This workspace contains all server-side code (CLI, simulation, services). Logs and data remain at the repository root (`/logs`, `/data`).

Build
- npm run build -w server

Run
- npm run simulate
- npm run quote-swap


CLI: pools-snapshot
- Purpose: fetch active Venus core markets via RPC and write a snapshot JSON to data/pools.json
- Usage:
  - npm run build -w server
  - node --enable-source-maps dist/index.js pools-snapshot
- Options:
  - --out <path>: custom output path (default: data/pools.json)
- Logging:
  - Emits structured JSON logs to stdout for each step:
    - { action: "snapshot.start", marketsPath, fetchedMarkets, filteredMarkets, excluded }
    - { action: "snapshot.write", tokenPath, assetSymbol, vTokenSymbol, vTokenAddress, underlyingAddress, priceUSD, point }
    - { action: "snapshot.write.extra", tokenPath, assetSymbol }
    - { action: "snapshot.done", marketsPath, marketsCount, updatedDailyFiles, durationMs }
- Env exclusions/inclusions:
  - SERVER_SNAPSHOT_EXCLUDE_SYMBOLS: list of symbols to skip (ex: "USDT, BUSD")
  - SERVER_SNAPSHOT_EXCLUDE_VTOKENS: list of vToken addresses to skip (lowercase)
  - SERVER_SNAPSHOT_EXCLUDE_UNDERLYINGS: list of underlying addresses to skip (lowercase)
  - SERVER_SNAPSHOT_EXTRA_TOKENS: list of extra token files to upsert daily even if not in RPC markets (default includes "pt-susde-26jun2025")

Historical APY averages are now computed from local token files by the snapshot step and stored alongside markets in `data/pools.json` as `avgSupplyApy{1m,3m,6m,1y}`. The token files have the following append-only format (sorted by timestamp):

  - `data/<symbol>.json`: `[{ timestamp, totalSupply, totalBorrow, totalSupplyUsd, totalBorrowUsd, apyBase, apyBaseBorrow }, ... ]`
  - No daily deduplication: every snapshot execution appends a new point, even multiple times per day.

Other modules (CLI check, simulation) consume these averages from the snapshot and combine them with live APY data without persisting external sources.

Notes:
- Only fully active markets are included (Comptroller `isListed` is true, `mintGuardianPaused` is false, and `borrowGuardianPaused` is false).
- Each market object now includes a `type` field: `stable` | `wrapped` | `token`.


