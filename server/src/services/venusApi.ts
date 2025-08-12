import axios from 'axios';
import { ethers } from 'ethers';

export type CoreMarket = {
  assetSymbol: string;
  vTokenSymbol: string;
  supplyApyPercent: number;
  borrowApyPercent: number;
  totalSupplyUnderlying: number;
  totalBorrowsUnderlying: number;
  /** Taux périodique par bloc (non annualisé), en décimal */
  supplyRatePerBlock: number;
  /** Nombre de blocs par an */
  blocksPerYear: number;
  vTokenAddress: string;
  underlyingAddress?: string;
  avgSupplyApy1m?: number;
  avgSupplyApy3m?: number;
  avgSupplyApy6m?: number;
  avgSupplyApy1y?: number;
  /** Type fonctionnel du token sous-jacent: stable, wrapped, ou token générique */
  type?: 'stable' | 'wrapped' | 'token';
};

const CORE_COMPTROLLER_ADDRESS = (process.env.SERVER_CORE_COMPTROLLER_ADDRESS || '0xfd36e2c2a6789db23113685031d7f16329158384').trim();
const BLOCKS_PER_YEAR = 10512000; // ~3s block time

const COMPTROLLER_ABI = [
  'function getAllMarkets() view returns (address[])',
  'function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)',
  'function mintGuardianPaused(address) view returns (bool)',
  'function borrowGuardianPaused(address) view returns (bool)'
];

const VTOKEN_ABI = [
  'function symbol() view returns (string)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function borrowRatePerBlock() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function underlying() view returns (address)',
  'function interestRateModel() view returns (address)',
  'function borrowBalanceCurrent(address) returns (uint256)',
  'function borrowBalanceStored(address) view returns (uint256)'
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

const INTEREST_RATE_MODEL_ABI = [
  'function blocksPerYear() view returns (uint256)'
];

function getProvider(): ethers.Provider | null {
  const rpcUrl = process.env.SERVER_BSC_RPC_URL || process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
  try {
    return new ethers.JsonRpcProvider(rpcUrl);
  } catch {
    return null;
  }
}

function calcApyFromPeriodicRate(rateScaled: bigint, periodsPerYear: number): number {
  const rate = Number(rateScaled) / 1e18;
  const apy = (Math.pow(1 + rate, periodsPerYear) - 1) * 100;
  return Number.isFinite(apy) ? apy : 0;
}

/**
 * Classe une asset en "stable", "wrapped" ou "token" à partir de son symbole.
 * Heuristique simple basée sur l'usage commun des symboles sur BSC/Venus.
 */
function classifyTokenType(assetSymbol?: string): 'stable' | 'wrapped' | 'token' {
  const sym = String(assetSymbol || '').toUpperCase();
  if (!sym) return 'token';
  // Stables connus + heuristique "USD" dans le symbole
  const stableSet = new Set([
    'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'USD1', 'USDE', 'SUSDE', 'LISUSD', 'LIUSD', 'LUSD'
  ]);
  if (stableSet.has(sym) || sym.includes('USD')) return 'stable';
  // Wrapped/tokens "pegged" courants
  const wrappedSet = new Set(['BTCB', 'WBETH', 'WBNB', 'WETH', 'WBTC', 'BETH']);
  if (wrappedSet.has(sym)) return 'wrapped';
  // Préfixe W* souvent utilisé pour des tokens "wrapped" (ex: WETH)
  if (/^W[A-Z0-9]/.test(sym) && sym !== 'WOO') return 'wrapped';
  // Actifs tokenisés/partagés (souvent assimilés à wrapped)
  const tokenizedSet = new Set(['ASBNB', 'XSOLVBTC', 'SOLVBTC']);
  if (tokenizedSet.has(sym)) return 'wrapped';
  return 'token';
}

export function normalizeAddress(value?: string | null): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  const idx = v.indexOf('0x');
  return idx >= 0 ? v.slice(idx) : undefined;
}

export type YieldPool = { pool: string; chain?: string; project?: string; symbol?: string; underlyingTokens?: string[]; apy?: number };
export type YieldChartPoint = {
  timestamp: number;
  apy?: number;
  apyBase?: number | null;
  apyReward?: number | null;
  apyBaseBorrow?: number | null;
  apyRewardBorrow?: number | null;
  totalSupplyUsd?: number | null;
  totalBorrowUsd?: number | null;
  debtCeilingUsd?: number | null;
};

/**
 * Fetch pools for project "venus" on BSC from the public yields API.
 */
export async function fetchYieldVenusPools(): Promise<YieldPool[]> { return []; }

/**
 * Fetch historical APY chart points for a pool id from the public yields API.
 */
export async function fetchYieldChart(_poolId: string): Promise<YieldChartPoint[]> { return []; }

function computeAverage(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  return Number.isFinite(avg) ? avg : undefined;
}

export function computeApyAverages(points: YieldChartPoint[]): {
  avg1m?: number; avg3m?: number; avg6m?: number; avg1y?: number;
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const ranges = [
    { key: 'avg1m' as const, days: 30 },
    { key: 'avg3m' as const, days: 90 },
    { key: 'avg6m' as const, days: 180 },
    { key: 'avg1y' as const, days: 365 },
  ];
  const res: any = {};
  for (const r of ranges) {
    const cutoff = nowSec - r.days * 86400;
    const vals = points
      .filter(p => (p?.timestamp ?? 0) >= cutoff && typeof p?.apy === 'number' && Number.isFinite(p.apy))
      .map(p => p.apy as number);
    const avg = computeAverage(vals);
    if (typeof avg === 'number') res[r.key] = avg;
  }
  return res;
}

async function enrichMarketsWithHistoricalApy(markets: CoreMarket[]): Promise<CoreMarket[]> {
  const enabledEnv = (process.env.SERVER_ENABLE_APY_HISTORY ?? process.env.ENABLE_APY_HISTORY ?? 'true').toLowerCase();
  const enabled = enabledEnv !== 'false' && enabledEnv !== '0' && enabledEnv !== 'no';
  if (!enabled || markets.length === 0) return markets;

  const pools = await fetchYieldVenusPools();
  if (!pools.length) return markets;

  function isBscChain(chain?: string) {
    const c = String(chain || '').toLowerCase();
    return c === 'bsc' || c.includes('binance');
  }

  function matchPool(market: CoreMarket): YieldPool | undefined {
    const u = market.underlyingAddress;
    const uNorm = normalizeAddress(u);
    if (uNorm) {
      const byUnderlying = pools.find((p) => {
        if (!isBscChain(p.chain)) return false;
        const tokenMatch = Array.isArray(p.underlyingTokens) && p.underlyingTokens.some(t => normalizeAddress(t) === uNorm);
        if (tokenMatch) return true;
        const id = (p.pool || '').toLowerCase();
        return id.includes(uNorm);
      });
      if (byUnderlying) return byUnderlying;
    }
    const sym = market.assetSymbol?.toUpperCase?.();
    if (sym) {
      return pools.find((p) => isBscChain(p.chain) && String(p.symbol || '').toUpperCase() === sym);
    }
    return undefined;
  }

  const enriched = await Promise.all(markets.map(async (m) => {
    try {
      const pool = matchPool(m);
      if (!pool) return m;
      const chart = await fetchYieldChart(pool.pool);
      if (!chart.length) return m;
      const { avg1m, avg3m, avg6m, avg1y } = computeApyAverages(chart);
      return { ...m, avgSupplyApy1m: avg1m, avgSupplyApy3m: avg3m, avgSupplyApy6m: avg6m, avgSupplyApy1y: avg1y };
    } catch {
      return m;
    }
  }));

  return enriched;
}

// Core loader using only on-chain RPC. Returns supply-enabled core markets without any external enrichment.
async function loadCoreMarketsRpcOnly(): Promise<CoreMarket[]> {
  const provider = getProvider();
  if (!provider) return [];

  const comptrollerAddr = CORE_COMPTROLLER_ADDRESS.toLowerCase();
  const comptroller = new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider);
  let vTokens: string[] = [];
  try {
    vTokens = await comptroller.getAllMarkets();
  } catch {
    return [];
  }

  const markets: CoreMarket[] = [];
  for (const vAddr of vTokens) {
    try {
      const vAddress = vAddr.toLowerCase();
      const vToken = new ethers.Contract(vAddress, VTOKEN_ABI, provider);
      // Filtre des marchés Venus entièrement actifs (ni supply/mint, ni borrow pausés)
      let isListed = true;
      try {
        const marketInfo = await (new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider)).markets(vAddress);
        if (Array.isArray(marketInfo) || typeof marketInfo === 'object') {
          isListed = Boolean((marketInfo as any)[0] ?? (marketInfo as any).isListed ?? true);
        }
      } catch {}
      let mintPaused = false;
      try {
        mintPaused = await (new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider)).mintGuardianPaused(vAddress);
      } catch {}
      let borrowPaused = false;
      try {
        borrowPaused = await (new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider)).borrowGuardianPaused(vAddress);
      } catch {}
      if (!isListed || mintPaused || borrowPaused) continue;

      const [vSymbol, sRate, bRate, totalBorrows, totalReserves, cash, irmAddr] = await Promise.all([
        vToken.symbol().catch(() => 'vUNKNOWN'),
        vToken.supplyRatePerBlock().catch(() => 0n),
        vToken.borrowRatePerBlock().catch(() => 0n),
        vToken.totalBorrows().catch(() => 0n),
        vToken.totalReserves().catch(() => 0n),
        vToken.getCash().catch(() => 0n),
        vToken.interestRateModel().catch(() => ethers.ZeroAddress),
      ]);

      // Determine blocks per year from IRM if available
      let blocksPerYear = BLOCKS_PER_YEAR;
      if (irmAddr && irmAddr !== ethers.ZeroAddress) {
        const irm = new ethers.Contract(String(irmAddr).toLowerCase(), INTEREST_RATE_MODEL_ABI, provider);
        try {
          const bpy: bigint = await irm.blocksPerYear();
          const n = Number(bpy);
          if (Number.isFinite(n) && n > 0) blocksPerYear = n;
        } catch {
          // keep default
        }
      }

      let assetSymbol = 'UNKNOWN';
      let underlyingDecimals = 18;
      let underlyingAddress: string | undefined;
      try {
        const underlyingAddr: string = await vToken.underlying();
        underlyingAddress = String(underlyingAddr).toLowerCase();
        const underlying = new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
        assetSymbol = await underlying.symbol();
        underlyingDecimals = await underlying.decimals();
      } catch {
        if (typeof vSymbol === 'string' && vSymbol.toUpperCase().includes('VBNB')) {
          assetSymbol = 'BNB';
          underlyingDecimals = 18;
        }
      }

      const totalSupplyUnderlying = ethers.formatUnits(cash + totalBorrows - totalReserves, underlyingDecimals);
      const totalBorrowsUnderlying = ethers.formatUnits(totalBorrows, underlyingDecimals);

      const supplyRatePerBlock = (() => {
        const n = Number(sRate) / 1e18;
        return Number.isFinite(n) && n > 0 ? n : 0;
      })();

      const tokenType = classifyTokenType(assetSymbol);
      markets.push({
        assetSymbol: assetSymbol || 'UNKNOWN',
        vTokenSymbol: typeof vSymbol === 'string' ? vSymbol : 'vUNKNOWN',
        supplyApyPercent: calcApyFromPeriodicRate(sRate, blocksPerYear),
        borrowApyPercent: calcApyFromPeriodicRate(bRate, blocksPerYear),
        totalSupplyUnderlying: Number(totalSupplyUnderlying),
        totalBorrowsUnderlying: Number(totalBorrowsUnderlying),
        supplyRatePerBlock,
        blocksPerYear,
        vTokenAddress: vAddress,
        underlyingAddress,
        type: tokenType,
      });
    } catch {
      // skip token on error
    }
  }

  return markets;
}

/**
 * Fetch core markets using only RPC (no external data). Not sorted.
 */
export async function fetchCoreMarketsRPC(): Promise<CoreMarket[]> {
  const markets = await loadCoreMarketsRpcOnly();
  // Sort deterministically by asset symbol then vToken symbol
  return markets.sort((a, b) => (a.assetSymbol || '').localeCompare(b.assetSymbol || '') || (a.vTokenSymbol || '').localeCompare(b.vTokenSymbol || ''));
}

export async function fetchCoreMarketsSortedBySupplyAPY(): Promise<CoreMarket[]> {
  const markets = await loadCoreMarketsRpcOnly();
  // Sort only by live APY; historical averages now come from local snapshot consumers
  return markets.sort((a, b) => b.supplyApyPercent - a.supplyApyPercent);
}

export type AccountBorrowPosition = {
  assetSymbol: string;
  vTokenSymbol: string;
  vTokenAddress: string;
  underlyingAddress?: string;
  underlyingDecimals: number;
  borrowBalanceUnderlying: number; // in underlying human units
  borrowRatePerBlock: number; // periodic (per block) decimal
  blocksPerYear: number;
  borrowApyPercent: number;
};

export async function fetchAccountBorrowPositions(accountAddress: string): Promise<AccountBorrowPosition[]> {
  const provider = getProvider();
  if (!provider) return [];

  const acct = accountAddress.toLowerCase();
  const comptrollerAddr = CORE_COMPTROLLER_ADDRESS.toLowerCase();
  const comptroller = new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider);
  let vTokens: string[] = [];
  try {
    vTokens = await comptroller.getAllMarkets();
  } catch {
    return [];
  }

  const positions: AccountBorrowPosition[] = [];
  for (const vAddr of vTokens) {
    try {
      const vAddress = String(vAddr).toLowerCase();
      const vToken = new ethers.Contract(vAddress, VTOKEN_ABI, provider);
      const [vSymbol, sRate, bRate, irmAddr] = await Promise.all([
        vToken.symbol().catch(() => 'vUNKNOWN'),
        vToken.supplyRatePerBlock().catch(() => 0n),
        vToken.borrowRatePerBlock().catch(() => 0n),
        vToken.interestRateModel().catch(() => ethers.ZeroAddress),
      ]);

      let blocksPerYear = BLOCKS_PER_YEAR;
      if (irmAddr && irmAddr !== ethers.ZeroAddress) {
        const irm = new ethers.Contract(String(irmAddr).toLowerCase(), INTEREST_RATE_MODEL_ABI, provider);
        try {
          const bpy: bigint = await irm.blocksPerYear();
          const n = Number(bpy);
          if (Number.isFinite(n) && n > 0) blocksPerYear = n;
        } catch {}
      }

      let assetSymbol = 'UNKNOWN';
      let underlyingDecimals = 18;
      let underlyingAddress: string | undefined;
      try {
        const underlyingAddr: string = await vToken.underlying();
        underlyingAddress = String(underlyingAddr).toLowerCase();
        const underlying = new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
        assetSymbol = await underlying.symbol();
        underlyingDecimals = await underlying.decimals();
      } catch {
        if (typeof vSymbol === 'string' && vSymbol.toUpperCase().includes('VBNB')) {
          assetSymbol = 'BNB';
          underlyingDecimals = 18;
        }
      }

      // Important: prefer borrowBalanceCurrent (accrues interest) but may revert; fallback to stored
      let bb: bigint = 0n;
      try {
        // non-view: must use staticCall to avoid sending a tx
        bb = await (vToken as any).borrowBalanceCurrent.staticCall(acct);
      } catch {
        try {
          bb = await vToken.borrowBalanceStored(acct);
        } catch {
          bb = 0n;
        }
      }

      if (bb === 0n) continue;

      const borrowBalanceUnderlying = Number(ethers.formatUnits(bb, underlyingDecimals));
      const borrowRatePerBlock = Number(bRate) / 1e18;
      const borrowApyPercent = calcApyFromPeriodicRate(bRate as bigint, blocksPerYear);

      positions.push({
        assetSymbol,
        vTokenSymbol: typeof vSymbol === 'string' ? vSymbol : 'vUNKNOWN',
        vTokenAddress: vAddress,
        underlyingAddress,
        underlyingDecimals,
        borrowBalanceUnderlying,
        borrowRatePerBlock: Number.isFinite(borrowRatePerBlock) && borrowRatePerBlock > 0 ? borrowRatePerBlock : 0,
        blocksPerYear,
        borrowApyPercent,
      });
    } catch {
      // ignore single market failure
    }
  }

  return positions;
}

export async function fetchTokenPricesUSDByAddress(addresses: string[]): Promise<Record<string, number>> {
  const uniq = Array.from(new Set(addresses.map(a => a?.toLowerCase()).filter(Boolean))) as string[];
  if (uniq.length === 0) return {};
  const chunks: string[][] = [];
  const size = 50; // CG limit per request
  for (let i = 0; i < uniq.length; i += size) chunks.push(uniq.slice(i, i + size));
  const out: Record<string, number> = {};
  for (const c of chunks) {
    try {
      const url = 'https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain';
      const params = new URLSearchParams({ contract_addresses: c.join(','), vs_currencies: 'usd' });
      const { data } = await axios.get(`${url}?${params.toString()}`, { timeout: 10000 });
      for (const [addr, v] of Object.entries<any>(data || {})) {
        const price = v?.usd;
        if (typeof price === 'number' && Number.isFinite(price)) out[(addr as string).toLowerCase()] = price;
      }
    } catch {}
  }
  return out;
}

export const TOPIC_BORROW = ethers.id('Borrow(address,uint256,uint256,uint256)');
export const TOPIC_REPAY = ethers.id('RepayBorrow(address,address,uint256,uint256,uint256)');

export async function aggregateBorrowRepayForAccount(
  accountAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<Record<string, { borrowed: bigint; repaid: bigint }>> {
  const provider = getProvider();
  if (!provider) return {};

  const acct = accountAddress.toLowerCase();
  // discover all vTokens
  const comptroller = new ethers.Contract(CORE_COMPTROLLER_ADDRESS.toLowerCase(), COMPTROLLER_ABI, provider);
  let vTokens: string[] = [];
  try {
    vTokens = await comptroller.getAllMarkets();
  } catch {
    return {};
  }

  const results: Record<string, { borrowed: bigint; repaid: bigint }> = {};

  // Query logs per token to leverage address filter for efficiency
  await Promise.all(
    vTokens.map(async (vAddr) => {
      const v = String(vAddr).toLowerCase();
      try {
        const [borrowLogs, repayLogs] = await Promise.all([
          provider.getLogs({ address: v, fromBlock, toBlock, topics: [TOPIC_BORROW, ethers.zeroPadValue(acct, 32)] }),
          provider.getLogs({ address: v, fromBlock, toBlock, topics: [TOPIC_REPAY, null, ethers.zeroPadValue(acct, 32)] }),
        ]);

        let borrowed = 0n;
        for (const log of borrowLogs) {
          try {
            const iface = new ethers.Interface([
              'event Borrow(address indexed borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)'
            ]);
            const parsed = iface.parseLog(log);
            const amt: bigint = (parsed as any)?.args?.borrowAmount ?? 0n;
            borrowed += amt;
          } catch {}
        }

        let repaid = 0n;
        for (const log of repayLogs) {
          try {
            const iface = new ethers.Interface([
              'event RepayBorrow(address indexed payer, address indexed borrower, uint256 repayAmount, uint256 accountBorrows, uint256 totalBorrows)'
            ]);
            const parsed = iface.parseLog(log);
            const amt: bigint = (parsed as any)?.args?.repayAmount ?? 0n;
            repaid += amt;
          } catch {}
        }

        if (!results[v]) results[v] = { borrowed: 0n, repaid: 0n };
        results[v].borrowed += borrowed;
        results[v].repaid += repaid;
      } catch {
        // ignore token failures
      }
    }),
  );

  return results;
}

// Minimal token price fetcher via CoinGecko (BNB native)
export async function fetchSymbolPricesUSD(): Promise<Record<string, number>> {
  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'binancecoin', vs_currencies: 'usd' },
      timeout: 8000,
    });
    const bnb = (data as any)?.binancecoin?.usd;
    if (typeof bnb === 'number' && Number.isFinite(bnb)) {
      return { BNB: bnb };
    }
  } catch {}
  return {};
}


