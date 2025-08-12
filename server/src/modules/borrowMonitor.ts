import { ethers } from 'ethers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  fetchAccountBorrowPositions,
  aggregateBorrowRepayForAccount,
  fetchTokenPricesUSDByAddress,
  fetchSymbolPricesUSD,
} from '@services/venusApi.js';

export type BorrowScanConfig = {
  accountAddress: string;
  /** Days to look back for Borrow/Repay aggregation if fromBlock not given. Default: 365 */
  daysLookback?: number;
  /** Optional manual fromBlock; overrides daysLookback if provided */
  fromBlock?: number;
  /** Projection horizon hours. Default: 12 */
  projectionHours?: number;
  /** Output NDJSON path. Default: logs/borrow.ndjson */
  logPath?: string;
};

export async function runBorrowInterestScan(config: BorrowScanConfig): Promise<BorrowScanResult> {
  const account = ethers.getAddress(config.accountAddress);
  const projectionHours = config.projectionHours ?? 12;

  // 1) Current positions
  const positions = await fetchAccountBorrowPositions(account);

  // 2) Prices USD (mix native BNB + ERC20 by address)
  const bnbPrice = (await fetchSymbolPricesUSD())['BNB'] ?? 0;
  const addrToPrice = await fetchTokenPricesUSDByAddress(
    (positions.map((p: any) => p.underlyingAddress).filter(Boolean) as string[]).map((a: string) => a.toLowerCase()),
  );

  // 3) Current exposures (USD) and weighted APY
  const secondsPerYear = 365 * 24 * 60 * 60;
  let totalUsd = 0;
  let weightedApy = 0;
  const enriched = positions.map((p: any) => {
    const priceUSD = p.underlyingAddress ? (addrToPrice[p.underlyingAddress] ?? 0) : bnbPrice;
    const usd = p.borrowBalanceUnderlying * (priceUSD || 0);
    totalUsd += usd;
    weightedApy += usd * p.borrowApyPercent;
    const secondsPerBlock = p.blocksPerYear > 0 ? secondsPerYear / p.blocksPerYear : 3;
    const blocks = Math.max(1, Math.floor((projectionHours * 3600) / secondsPerBlock));
    const growth = Math.pow(1 + p.borrowRatePerBlock, blocks) - 1;
    const projectedInterest = usd * (growth > 0 && Number.isFinite(growth) ? growth : 0);
    return { ...p, priceUSD, usd, secondsPerBlock, projectedInterestUSD: projectedInterest };
  });
  const currentWeightedBorrowApyPercent = totalUsd > 0 ? weightedApy / totalUsd : 0;

  // 4) Aggregate Borrow/Repay from logs to estimate accrued interest to-date
  const provider = new ethers.JsonRpcProvider(process.env.SERVER_BSC_RPC_URL || process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org');
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = await resolveFromBlock(provider, config, latestBlock, positions);

  const byToken = await aggregateBorrowRepayForAccount(account, fromBlock, latestBlock);

  // Map vToken -> metadata (underlying address/decimals/symbol)
  const meta = await buildVTokenMeta(provider, Object.keys(byToken));

  let interestAccruedTotalUSD = 0;
  let repayTotalUSD = 0;
  let borrowTotalUSD = 0;
  for (const [vTokenAddr, agg] of Object.entries(byToken as Record<string, { borrowed: bigint; repaid: bigint }>)) {
    const m = meta[vTokenAddr.toLowerCase()];
    if (!m) continue;
    const decimals = m.underlyingDecimals;
    const underlyingAddr = m.underlyingAddress;
    const symbol = m.assetSymbol;
    const priceUSD = underlyingAddr ? (addrToPrice[underlyingAddr] ?? 0) : bnbPrice;

    const borrowed = Number(ethers.formatUnits((agg as any).borrowed, decimals));
    const repaid = Number(ethers.formatUnits((agg as any).repaid, decimals));
    const current = (positions as any[]).find((p) => p.vTokenAddress === vTokenAddr.toLowerCase())?.borrowBalanceUnderlying ?? 0;

    const interestUnderlying = repaid + current - borrowed;
    const interestUSD = interestUnderlying * (priceUSD || 0);
    interestAccruedTotalUSD += interestUSD;
    repayTotalUSD += repaid * (priceUSD || 0);
    borrowTotalUSD += borrowed * (priceUSD || 0);
  }

  // 5) Realized average annualized rate to date (approximation)
  // We approximate exposure over time using a principal-only outstanding series per token
  // derived from Borrow/Repay events (ignoring interest accrual), converted with current prices.
  const exposureYearsUSD = await estimateExposureYearsUSD(provider, account, fromBlock, latestBlock, meta, bnbPrice, addrToPrice);
  const realizedAprPercent = exposureYearsUSD > 0 ? (interestAccruedTotalUSD / exposureYearsUSD) * 100 : 0;

  const projectedInterest12hUSD = enriched.reduce((acc: number, p: any) => acc + (p.projectedInterestUSD ?? 0), 0);

  const result: BorrowScanResult = {
    account,
    window: { fromBlock, toBlock: latestBlock },
    currentPositions: enriched.map(({ priceUSD, usd, secondsPerBlock, projectedInterestUSD, ...rest }: any) => ({
      ...rest,
      priceUSD,
      currentUsd: usd,
      projectedInterestUSD,
    })),
    totals: {
      currentDebtUSD: totalUsd,
      repayTotalUSD,
      borrowTotalUSD,
      interestAccruedTotalUSD,
      projectedInterestNextHoursUSD: projectedInterest12hUSD,
      currentWeightedBorrowApyPercent,
      realizedAprPercent,
    },
  };

  const logPath = (config.logPath || process.env.SERVER_LOG_BORROW_PATH || path.join('logs', 'borrow.ndjson')).trim();
  await ensureParentDir(logPath);
  await appendJson(logPath, { ts: new Date().toISOString(), type: 'borrow-scan', data: result });

  return result;
}

export type BorrowScanResult = {
  account: string;
  window: { fromBlock: number; toBlock: number };
  currentPositions: Array<{
    assetSymbol: string;
    vTokenSymbol: string;
    vTokenAddress: string;
    underlyingAddress?: string;
    underlyingDecimals: number;
    borrowBalanceUnderlying: number;
    borrowRatePerBlock: number;
    blocksPerYear: number;
    borrowApyPercent: number;
    priceUSD: number;
    currentUsd: number;
    projectedInterestUSD: number;
  }>;
  totals: {
    currentDebtUSD: number;
    repayTotalUSD: number;
    borrowTotalUSD: number;
    interestAccruedTotalUSD: number;
    projectedInterestNextHoursUSD: number;
    currentWeightedBorrowApyPercent: number;
    realizedAprPercent: number;
  };
};

async function resolveFromBlock(
  provider: ethers.JsonRpcProvider,
  cfg: BorrowScanConfig,
  latestBlock: number,
  positions: Awaited<ReturnType<typeof fetchAccountBorrowPositions>>,
): Promise<number> {
  if (typeof cfg.fromBlock === 'number' && Number.isFinite(cfg.fromBlock) && cfg.fromBlock > 0) {
    return Math.min(cfg.fromBlock, latestBlock);
  }
  const days = cfg.daysLookback ?? Number(process.env.SERVER_BORROW_DAYS_LOOKBACK ?? 365);
  // derive seconds per block using weighted median across current positions; fallback to 3s
  const secondsPerBlockCandidates = positions
    .map((p) => (p.blocksPerYear > 0 ? (365 * 24 * 3600) / p.blocksPerYear : 3))
    .filter((v) => Number.isFinite(v) && v > 0);
  const spb = secondsPerBlockCandidates.length ? median(secondsPerBlockCandidates) : 3;
  const blocksLookback = Math.ceil(((days * 24 * 3600) / spb));
  return Math.max(1, latestBlock - blocksLookback);
}

function median(values: number[]): number {
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

type VTokenMeta = {
  [vToken: string]: { underlyingAddress?: string; underlyingDecimals: number; assetSymbol: string };
};

async function buildVTokenMeta(provider: ethers.Provider, vTokens: string[]): Promise<VTokenMeta> {
  const ERC20_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
  const VTOKEN_ABI = ['function symbol() view returns (string)', 'function underlying() view returns (address)'];
  const meta: VTokenMeta = {};
  await Promise.all(
    vTokens.map(async (addr) => {
      const v = String(addr).toLowerCase();
      try {
        const vt = new ethers.Contract(v, VTOKEN_ABI, provider);
        const [vSym, underlyingAddr] = await Promise.all([
          vt.symbol().catch(() => 'vUNKNOWN'),
          vt.underlying().catch(() => ethers.ZeroAddress),
        ]);
        let assetSymbol = 'BNB';
        let decimals = 18;
        let underlying: string | undefined = undefined;
        if (underlyingAddr && underlyingAddr !== ethers.ZeroAddress) {
          underlying = String(underlyingAddr).toLowerCase();
          const erc20 = new ethers.Contract(underlying, ERC20_ABI, provider);
          assetSymbol = await erc20.symbol().catch(() => 'UNKNOWN');
          decimals = await erc20.decimals().catch(() => 18);
        }
        meta[v] = {
          underlyingAddress: underlying,
          underlyingDecimals: decimals,
          assetSymbol,
        };
      } catch {
        // ignore
      }
    }),
  );
  return meta;
}

async function estimateExposureYearsUSD(
  provider: ethers.JsonRpcProvider,
  account: string,
  fromBlock: number,
  toBlock: number,
  meta: VTokenMeta,
  bnbPrice: number,
  addrToPrice: Record<string, number>,
): Promise<number> {
  // Build event list per token (Borrow and Repay) and integrate outstanding principal-only USD over time
  const BORROW_IFACE = new ethers.Interface([
    'event Borrow(address indexed borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)'
  ]);
  const REPAY_IFACE = new ethers.Interface([
    'event RepayBorrow(address indexed payer, address indexed borrower, uint256 repayAmount, uint256 accountBorrows, uint256 totalBorrows)'
  ]);

  // Discover all vTokens with meta
  const vTokens = Object.keys(meta);
  type Event = { t: number; vToken: string; deltaUnderlying: number };
  const events: Event[] = [];

  // Query logs per token
  await Promise.all(
    vTokens.map(async (vAddr) => {
      const v = vAddr.toLowerCase();
      try {
        const [borrowLogs, repayLogs] = await Promise.all([
          provider.getLogs({ address: v, fromBlock, toBlock, topics: [ethers.id('Borrow(address,uint256,uint256,uint256)'), ethers.zeroPadValue(account.toLowerCase(), 32)] }),
          provider.getLogs({ address: v, fromBlock, toBlock, topics: [ethers.id('RepayBorrow(address,address,uint256,uint256,uint256)'), null, ethers.zeroPadValue(account.toLowerCase(), 32)] }),
        ]);
        const m = meta[v];
        const dec = m?.underlyingDecimals ?? 18;
        for (const log of borrowLogs) {
          try {
            const p = BORROW_IFACE.parseLog(log);
            const amt: bigint = p?.args?.borrowAmount ?? 0n;
            const block = await provider.getBlock(log.blockHash!);
            events.push({ t: Number(block?.timestamp || 0), vToken: v, deltaUnderlying: Number(ethers.formatUnits(amt, dec)) });
          } catch {}
        }
        for (const log of repayLogs) {
          try {
            const p = REPAY_IFACE.parseLog(log);
            const amt: bigint = p?.args?.repayAmount ?? 0n;
            const block = await provider.getBlock(log.blockHash!);
            events.push({ t: Number(block?.timestamp || 0), vToken: v, deltaUnderlying: -Number(ethers.formatUnits(amt, dec)) });
          } catch {}
        }
      } catch {
        // ignore token errors
      }
    }),
  );

  if (events.length === 0) return 0;
  events.sort((a, b) => a.t - b.t);

  // Integrate per token
  const nowBlock = await provider.getBlock(toBlock);
  const nowTs = Number(nowBlock?.timestamp || Math.floor(Date.now() / 1000));
  let exposureSecUsd = 0;

  const perTokenOutstanding = new Map<string, number>();
  let lastTs = events[0].t;

  for (const ev of events) {
    const dt = Math.max(0, ev.t - lastTs);
    if (dt > 0) {
      // sum current outstanding across tokens to USD
      let sumUsd = 0;
      for (const [v, amt] of perTokenOutstanding.entries()) {
        const m = meta[v];
        const price = m.underlyingAddress ? (addrToPrice[m.underlyingAddress] ?? 0) : bnbPrice;
        sumUsd += amt * (price || 0);
      }
      exposureSecUsd += sumUsd * dt;
      lastTs = ev.t;
    }
    const prev = perTokenOutstanding.get(ev.vToken) ?? 0;
    perTokenOutstanding.set(ev.vToken, Math.max(0, prev + ev.deltaUnderlying));
  }

  // Tail segment to now
  const dtTail = Math.max(0, nowTs - lastTs);
  if (dtTail > 0) {
    let sumUsd = 0;
    for (const [v, amt] of perTokenOutstanding.entries()) {
      const m = meta[v];
      const price = m.underlyingAddress ? (addrToPrice[m.underlyingAddress] ?? 0) : bnbPrice;
      sumUsd += amt * (price || 0);
    }
    exposureSecUsd += sumUsd * dtTail;
  }

  const exposureYears = exposureSecUsd / (365 * 24 * 3600);
  return exposureYears;
}

async function ensureParentDir(filePath: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

async function appendJson(filePath: string, obj: unknown): Promise<void> {
  const line = JSON.stringify(obj) + '\n';
  try {
    await fs.appendFile(filePath, line, { encoding: 'utf8' });
  } catch (e) {
    console.error(`Failed to write to ${filePath}:`, (e as Error).message);
  }
}

export async function runBorrowInterestMonitor(config: BorrowScanConfig & { intervalHours?: number }): Promise<void> {
  const intervalHours = config?.intervalHours ?? Number(process.env.SERVER_BORROW_INTERVAL_HOURS ?? 12);
  while (true) {
    try {
      const res = await runBorrowInterestScan(config);
      console.log(
        `borrow-scan: debt=$${res.totals.currentDebtUSD.toFixed(2)} interestAccrued=$${res.totals.interestAccruedTotalUSD.toFixed(2)} proj${config.projectionHours ?? 12}h=$${res.totals.projectedInterestNextHoursUSD.toFixed(2)} avgNow=${res.totals.currentWeightedBorrowApyPercent.toFixed(2)}% realized=${res.totals.realizedAprPercent.toFixed(2)}%`,
      );
    } catch (e) {
      console.error('borrow-scan error:', (e as Error).message);
    }
    const sleepMs = Math.max(1, Math.floor(intervalHours * 3600 * 1000));
    await new Promise((res) => setTimeout(res, sleepMs));
  }
}

// no re-exports


