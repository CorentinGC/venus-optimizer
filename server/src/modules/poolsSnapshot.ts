import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchCoreMarketsRPC, type CoreMarket, fetchTokenPricesUSDByAddress, fetchSymbolPricesUSD } from '@services/venusApi.js';

export type PoolsSnapshotOptions = {
  /**
   * Destination file path for the aggregated snapshot.
   * Default: ../data/pools.json (repo root)
   */
  outPath?: string;
};

function resolveDefaultOutPath(): string {
  const cwd = process.cwd();
  const dir = process.env.SERVER_NEW_DATA_DIR || path.join(cwd, '..', 'data');
  return path.resolve(dir, 'pools.json');
}

async function ensureDirExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function parseListEnv(name: string, defaults: string[] = []): string[] {
  const raw = (process.env[name] ?? '').toString();
  const list = raw
    .split(/[;,\n\s]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
  return list.length ? list : defaults;
}

function toUpperSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.toUpperCase()));
}

function toLowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

export type PoolsSnapshot = {
  timestamp: string;
  network: 'bsc';
  comptroller: string;
  markets: Array<{
    assetSymbol: string;
    vTokenSymbol: string;
    vTokenAddress: string;
    underlyingAddress?: string;
    blocksPerYear: number;
    /** Type fonctionnel du token sous-jacent: stable, wrapped, ou token générique */
    type?: 'stable' | 'wrapped' | 'token';
    avgSupplyApy1m?: number;
    avgSupplyApy3m?: number;
    avgSupplyApy6m?: number;
    avgSupplyApy1y?: number;
  }>;
};

/**
 * Fetch supply-enabled Venus markets using RPC only and write a snapshot JSON file.
 * The file format is a single JSON object with metadata and the markets array:
 * { timestamp, network: 'bsc', comptroller, markets: [...] }
 */
export async function runPoolsSnapshot(options?: PoolsSnapshotOptions): Promise<{ marketsPath: string; marketsCount: number; updatedDailyFiles: number }> {
  const marketsPath = path.resolve(options?.outPath || resolveDefaultOutPath());
  await ensureDirExists(marketsPath);

  const t0 = Date.now();
  let markets = await fetchCoreMarketsRPC();

  // Exclusions via env (symbols, vToken addresses, underlying addresses)
  const excludeSymbols = toUpperSet(parseListEnv('SERVER_SNAPSHOT_EXCLUDE_SYMBOLS'));
  const excludeVTokenAddresses = toLowerSet(parseListEnv('SERVER_SNAPSHOT_EXCLUDE_VTOKENS'));
  const excludeUnderlyingAddresses = toLowerSet(parseListEnv('SERVER_SNAPSHOT_EXCLUDE_UNDERLYINGS'));

  const beforeCount = markets.length;
  markets = markets.filter((m) => {
    const sym = (m.assetSymbol || '').toUpperCase();
    const vAddr = (m.vTokenAddress || '').toLowerCase();
    const uAddr = (m.underlyingAddress || '').toLowerCase();
    if (excludeSymbols.has(sym)) return false;
    if (excludeVTokenAddresses.has(vAddr)) return false;
    if (uAddr && excludeUnderlyingAddresses.has(uAddr)) return false;
    return true;
  });

  // Start log
  console.log(
    JSON.stringify(
      {
        action: 'snapshot.start',
        module: 'poolsSnapshot',
        marketsPath,
        fetchedMarkets: beforeCount,
        filteredMarkets: markets.length,
        excluded: {
          symbols: Array.from(excludeSymbols),
          vTokens: Array.from(excludeVTokenAddresses),
          underlyings: Array.from(excludeUnderlyingAddresses),
        },
      },
      null,
      2,
    ),
  );

  // 1) Write general markets metadata (addresses, symbols, blocksPerYear)
  const snapshot: PoolsSnapshot = {
    timestamp: new Date().toISOString(),
    network: 'bsc',
    comptroller: (process.env.SERVER_CORE_COMPTROLLER_ADDRESS || '0xfd36e2c2a6789db23113685031d7f16329158384').trim().toLowerCase(),
    markets: markets.map((m) => ({
      assetSymbol: m.assetSymbol,
      vTokenSymbol: m.vTokenSymbol,
      vTokenAddress: m.vTokenAddress,
      underlyingAddress: m.underlyingAddress,
      blocksPerYear: m.blocksPerYear,
      type: (m as any).type,
    })),
  };
  await fs.writeFile(marketsPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8' });

  // 2) Append daily points per token (same shape as data/old/*)
  // Build price map: native BNB + ERC20 by underlying address
  const bnbPrice = (await fetchSymbolPricesUSD())['BNB'] ?? 0;
  const uniqueAddresses = Array.from(
    new Set(
      markets
        .map((m) => (m.underlyingAddress ? m.underlyingAddress.toLowerCase() : undefined))
        .filter(Boolean) as string[],
    ),
  );
  const addressToPrice = await fetchTokenPricesUSDByAddress(uniqueAddresses);

  let updatedDailyFiles = 0;
  const outDir = path.dirname(marketsPath);

  async function upsertDailyPoint(filePath: string, point: {
    timestamp: string;
    totalSupply: number;
    totalBorrow: number;
    totalSupplyUsd: number;
    totalBorrowUsd: number;
    apyBase: number;
    apyBaseBorrow: number;
  }): Promise<void> {
    await ensureDirExists(filePath);
    // Upsert by day (keep a single entry per UTC day)
    let arr: any[] = [];
    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // ignore missing/invalid file
    }
    // Append a new point every run (no daily dedup)
    arr.push(point);
    arr.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    await fs.writeFile(filePath, JSON.stringify(arr, null, 2), { encoding: 'utf8' });
  }

  for (const m of markets) {
    try {
      const symbol = String(m.assetSymbol || 'UNKNOWN').toLowerCase();
      const tokenPath = path.resolve(outDir, 'pools', `${symbol}.json`);

      const priceUSD = m.underlyingAddress ? (addressToPrice[m.underlyingAddress.toLowerCase()] ?? 0) : bnbPrice;
      const totalSupplyUsd = Number.isFinite(m.totalSupplyUnderlying) ? m.totalSupplyUnderlying * (priceUSD || 0) : 0;
      const totalBorrowUsd = Number.isFinite(m.totalBorrowsUnderlying) ? m.totalBorrowsUnderlying * (priceUSD || 0) : 0;

      const point = {
        timestamp: new Date().toISOString(),
        totalSupply: Number(m.totalSupplyUnderlying ?? 0),
        totalBorrow: Number(m.totalBorrowsUnderlying ?? 0),
        totalSupplyUsd: Number(totalSupplyUsd),
        totalBorrowUsd: Number(totalBorrowUsd),
        apyBase: Number(m.supplyApyPercent) / 100,
        apyBaseBorrow: Number(m.borrowApyPercent) / 100,
      };

      await upsertDailyPoint(tokenPath, point);
      updatedDailyFiles += 1;

      // Per-market log with file path and pool info
      console.log(
        JSON.stringify(
          {
            action: 'snapshot.write',
            module: 'poolsSnapshot',
            tokenPath,
            assetSymbol: m.assetSymbol,
            vTokenSymbol: m.vTokenSymbol,
            vTokenAddress: m.vTokenAddress,
            underlyingAddress: m.underlyingAddress,
            blocksPerYear: m.blocksPerYear,
            priceUSD,
            point,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            action: 'snapshot.error.market',
            module: 'poolsSnapshot',
            assetSymbol: m.assetSymbol,
            vTokenSymbol: m.vTokenSymbol,
            vTokenAddress: m.vTokenAddress,
            error: (error as Error)?.message ?? String(error),
          },
          null,
          2,
        ),
      );
    }
  }

  // Extra tokens: always upsert a daily point even if not part of core markets
  const extraTokens = parseListEnv('SERVER_SNAPSHOT_EXTRA_TOKENS', ['pt-susde-26jun2025']).map((s) => s.toLowerCase());
  for (const sym of extraTokens) {
    try {
      const tokenPath = path.resolve(outDir, 'pools', `${sym}.json`);
      const point = {
        timestamp: new Date().toISOString(),
        totalSupply: 0,
        totalBorrow: 0,
        totalSupplyUsd: 0,
        totalBorrowUsd: 0,
        apyBase: 0,
        apyBaseBorrow: 0,
      };
      await upsertDailyPoint(tokenPath, point);
      updatedDailyFiles += 1;
      console.log(
        JSON.stringify(
          {
            action: 'snapshot.write.extra',
            module: 'poolsSnapshot',
            tokenPath,
            assetSymbol: sym,
            note: 'extra token (not scanned via RPC)',
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            action: 'snapshot.error.extra',
            module: 'poolsSnapshot',
            assetSymbol: sym,
            error: (error as Error)?.message ?? String(error),
          },
          null,
          2,
        ),
      );
    }
  }

  // 3) Compute historical averages from local daily files and update snapshot
  async function readJsonArray(filePath: string): Promise<any[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function computeAverage(values: number[]): number | undefined {
    if (!values.length) return undefined;
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    return Number.isFinite(avg) ? avg : undefined;
  }

  function averagesFromPoints(points: Array<{ timestamp?: string; apyBase?: number | null }>): {
    avg1m?: number; avg3m?: number; avg6m?: number; avg1y?: number;
  } {
    const now = Date.now();
    const dayMs = 86400000;
    const ranges = [
      { key: 'avg1m' as const, ms: 30 * dayMs },
      { key: 'avg3m' as const, ms: 90 * dayMs },
      { key: 'avg6m' as const, ms: 180 * dayMs },
      { key: 'avg1y' as const, ms: 365 * dayMs },
    ];
    const res: any = {};
    for (const r of ranges) {
      const cutoff = now - r.ms;
      const vals: number[] = [];
      for (const p of points) {
        const ts = p?.timestamp ? Date.parse(String(p.timestamp)) : NaN;
        const apyBase = typeof p?.apyBase === 'number' ? p.apyBase : null;
        if (Number.isFinite(ts) && ts >= cutoff && apyBase != null && Number.isFinite(apyBase)) {
          vals.push(apyBase * 100); // convert decimal to percent
        }
      }
      const avg = computeAverage(vals);
      if (typeof avg === 'number') res[r.key] = avg;
    }
    return res;
  }

  const marketsWithAverages = [] as typeof snapshot.markets;
  for (const m of markets) {
    const symbolLower = String(m.assetSymbol || 'UNKNOWN').toLowerCase();
    // New layout
    const fileNew = path.resolve(outDir, 'pools', `${symbolLower}.json`);
    const fileNewOld = path.resolve(outDir, 'pools', 'old', `${symbolLower}.json`);
    // Back-compat old layout
    const fileLegacy = path.resolve(outDir, `${symbolLower}.json`);
    const fileLegacyOld = path.resolve(outDir, 'old', `${symbolLower}.json`);
    const arrNew = await readJsonArray(fileNew);
    const arrNewOld = await readJsonArray(fileNewOld);
    const arrLegacy = await readJsonArray(fileLegacy);
    const arrLegacyOld = await readJsonArray(fileLegacyOld);
    const merged = [...arrLegacyOld, ...arrLegacy, ...arrNewOld, ...arrNew];
    const { avg1m, avg3m, avg6m, avg1y } = averagesFromPoints(merged);
    marketsWithAverages.push({
      assetSymbol: m.assetSymbol,
      vTokenSymbol: m.vTokenSymbol,
      vTokenAddress: m.vTokenAddress,
      underlyingAddress: m.underlyingAddress,
      blocksPerYear: m.blocksPerYear,
      type: (m as any).type,
      avgSupplyApy1m: avg1m,
      avgSupplyApy3m: avg3m,
      avgSupplyApy6m: avg6m,
      avgSupplyApy1y: avg1y,
    });
  }

  const snapshotWithAvg: PoolsSnapshot = {
    timestamp: new Date().toISOString(),
    network: 'bsc',
    comptroller: (process.env.SERVER_CORE_COMPTROLLER_ADDRESS || '0xfd36e2c2a6789db23113685031d7f16329158384').trim().toLowerCase(),
    markets: marketsWithAverages,
  };
  await fs.writeFile(marketsPath, JSON.stringify(snapshotWithAvg, null, 2), { encoding: 'utf8' });

  const durationMs = Date.now() - t0;
  console.log(
    JSON.stringify(
      {
        action: 'snapshot.done',
        module: 'poolsSnapshot',
        marketsPath,
        marketsCount: markets.length,
        updatedDailyFiles,
        durationMs,
      },
      null,
      2,
    ),
  );

  return { marketsPath, marketsCount: markets.length, updatedDailyFiles };
}

export default runPoolsSnapshot;


