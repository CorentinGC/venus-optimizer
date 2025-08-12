import axios from 'axios';
import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ensure env is loaded both from server and repo root in workspace runs
try {
  dotenvConfig();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenvConfig({ path: path.resolve(__dirname, '../.env') });
  dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
} catch {}

/** Estimation simplifiée (fallback) des frais de swap en bps si la quote live n'est pas utilisée. */
export async function estimateSwapFeesBps(fromSymbol: string, toSymbol: string): Promise<number> {
  const a = fromSymbol.toUpperCase();
  const b = toSymbol.toUpperCase();
  if (a === b) return 0;
  const singleHopBps = 25;
  const doubleHopBps = 50;
  const stableSet = new Set(['BUSD', 'USDT', 'USDC']);
  if (stableSet.has(a) && stableSet.has(b)) return singleHopBps;
  return doubleHopBps;
}

type TokenInfo = { symbol: string; address: string; decimals?: number };

const DEFAULT_ROUTER_V2 = (process.env.SERVER_PCS_V2_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E').trim();
const DEFAULT_WBNB = (process.env.SERVER_WBNB_ADDRESS || '0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c').trim();

const KNOWN_TOKENS: Record<string, string> = {
  WBNB: DEFAULT_WBNB,
  BNB: DEFAULT_WBNB,
  BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  BTCB: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
  // Alias pratique: accepter "BTC" comme synonyme de BTCB sur BSC
  BTC: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
  ETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  CAKE: '0x0E09Fabb73Bd3Ade0a17ECC321fD13a19e81cE82',
};

const ROUTER_V2_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)'
];

// PancakeSwap v3 Quoter ABIs (support both Quoter and QuoterV2 shapes)
const QUOTER_V3_ABI = [
  // Quoter (legacy): returns single amountOut
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut)',
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
  // QuoterV2: returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160, uint32, uint256)',
  'function quoteExactInputSingle((address,address,uint24,uint256,uint160)) external returns (uint256 amountOut, uint160, uint32, uint256)'
];

const DEFAULT_RPC_CALL_TIMEOUT_MS = (() => {
  const n = Number(process.env.SERVER_RPC_CALL_TIMEOUT_MS ?? process.env.RPC_CALL_TIMEOUT_MS ?? 7000);
  return Number.isFinite(n) && n > 0 ? n : 7000;
})();

const QUOTE_DEBUG = String(process.env.SERVER_QUOTE_DEBUG ?? process.env.QUOTE_DEBUG ?? '').toLowerCase();
const IS_DEBUG = QUOTE_DEBUG === '1' || QUOTE_DEBUG === 'true' || QUOTE_DEBUG === 'yes';

const DEFAULT_V3_FEE_TIERS: number[] = (() => {
  const raw = String(process.env.SERVER_PCS_V3_FEE_TIERS ?? '100,500,2500,10000');
  return raw
    .split(/[;,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
})();

// Default to official PCS v3 QuoterV2 on BSC if not provided via env
const DEFAULT_V3_QUOTER = (process.env.SERVER_PCS_V3_QUOTER || process.env.PCS_V3_QUOTER || '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997').trim();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error(`Timeout ${context} after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]) as T;
}

function getProvider(): ethers.Provider | null {
  const rpcUrl = process.env.SERVER_BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
  try {
    return new ethers.JsonRpcProvider(rpcUrl);
  } catch {
    return null;
  }
}

function getTokenAddressFromEnv(symbol: string): string | undefined {
  const key = `ADDR_${symbol.toUpperCase()}`;
  const val = process.env[key];
  if (val && typeof val === 'string' && /^0x[a-fA-F0-9]{40}$/.test(val.trim())) return val.trim();
  return undefined;
}

export function getKnownTokenAddress(symbol: string): string | null {
  const s = symbol.toUpperCase();
  const envAddr = getTokenAddressFromEnv(s);
  if (envAddr) return envAddr;
  const addr = KNOWN_TOKENS[s];
  if (addr) return addr;
  return null;
}

const decimalsCache = new Map<string, number>();

async function fetchTokenDecimals(provider: ethers.Provider, token: string): Promise<number> {
  const key = token.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key)!;
  if (key === DEFAULT_WBNB.toLowerCase()) {
    decimalsCache.set(key, 18);
    return 18;
  }
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  try {
    const d: number = await withTimeout(erc20.decimals(), DEFAULT_RPC_CALL_TIMEOUT_MS, `erc20.decimals(${token})`);
    if (Number.isFinite(d)) {
      decimalsCache.set(key, d);
      return d;
    }
  } catch (e) {
    if (IS_DEBUG) console.error(`[quote-swap] decimals fallback=18 for ${token}: ${(e as Error)?.message ?? e}`);
  }
  decimalsCache.set(key, 18);
  return 18;
}

function uniqueAddresses(pathArr: string[]): string[] {
  return pathArr.filter((addr, i) => i === 0 || addr.toLowerCase() !== pathArr[i - 1]!.toLowerCase());
}

function getPreferredIntermediates(): string[] {
  const raw = String(process.env.SERVER_QUOTE_INTERMEDIATES || '').trim();
  if (raw) {
    return raw
      .split(/[;,:\s]+/)
      .map((s) => s.toUpperCase())
      .filter(Boolean);
  }
  // Default: avoid deprecated BUSD as intermediate; prefer WBNB, USDT, USDC
  return ['WBNB', 'USDT', 'USDC'];
}

function resolveSymbolsToAddresses(symbols: string[]): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const addr = getKnownTokenAddress(s);
    if (addr) out.push(addr);
  }
  return out;
}

export type SplitQuotePart = {
  amountIn: string;
  amountOut: string;
  amountInRaw: string;
  amountOutRaw: string;
  path: string[];
  pathSymbols: string[];
};

export type LiveQuote = {
  amountIn: string;
  amountOut: string;
  amountOutMin?: string; // with slippage tolerance applied
  amountInRaw: string;
  amountOutRaw: string;
  from: TokenInfo;
  to: TokenInfo;
  // Single-route fields
  path?: string[];
  pathSymbols?: string[];
  v3FeesBpsPerHop?: number[]; // only for pcs-v3 single-route
  // Split-routing fields
  isSplit?: boolean;
  parts?: SplitQuotePart[];
  // Optional raw aggregator info
  provider?: 'oneinch' | 'pcs-v2' | 'pcs-v3';
  estimatedGasUnits?: number;
  tradingFeeBpsApprox?: number;
};

/**
 * Compute best quote on PancakeSwap v2 for exact-in.
 * - When allowMultiHop=false, only try direct route [from, to].
 * - When allowMultiHop=true, try a set of common intermediates (WBNB, BUSD, USDT) up to 3 hops.
 * - When allowSplitRouting=true, split amount across top 2 routes in 10% steps to maximize total out.
 */
export type DexVersion = 'pcs-v2' | 'pcs-v3';

export async function quotePcsV2BestExactIn(params: {
  fromSymbol: string;
  toSymbol: string;
  amountInUnits: number;
  allowMultiHop?: boolean;
  allowSplitRouting?: boolean;
  maxHops?: number;
}): Promise<LiveQuote> {
  const provider = getProvider();
  if (!provider) throw new Error('Provider non disponible');
  const routerAddr = (process.env.PCS_V2_ROUTER || DEFAULT_ROUTER_V2).trim();
  const router = new ethers.Contract(routerAddr, ROUTER_V2_ABI, provider);
  const fromSymbol = params.fromSymbol.toUpperCase();
  const toSymbol = params.toSymbol.toUpperCase();
  const fromAddr = getKnownTokenAddress(fromSymbol);
  const toAddr = getKnownTokenAddress(toSymbol);
  if (!fromAddr || !toAddr) throw new Error(`Adresse inconnue pour ${fromSymbol} ou ${toSymbol}`);
  const fromDecimals = await fetchTokenDecimals(provider, fromAddr);
  const toDecimals = await fetchTokenDecimals(provider, toAddr);
  const amountInRaw = ethers.parseUnits(String(params.amountInUnits), fromDecimals);
  const WBNB = getKnownTokenAddress('WBNB')!;
  const BUSD = getKnownTokenAddress('BUSD')!;
  const USDT = getKnownTokenAddress('USDT')!;
  const allowMultiHop = Boolean(params.allowMultiHop);
  const maxHops = Math.max(2, Math.min(4, Number(params.maxHops ?? 3)));
  const candidatePaths: string[][] = [];
  const addPath = (p: string[]) => {
    const clean = uniqueAddresses(p);
    if (clean.length >= 2 && (!allowMultiHop ? clean.length === 2 : clean.length <= maxHops)) {
      candidatePaths.push(clean);
    }
  };
  // Always consider direct path
  addPath([fromAddr, toAddr]);
  if (allowMultiHop) {
    const interSyms = getPreferredIntermediates();
    const interAddrs = resolveSymbolsToAddresses(interSyms);
    // Single intermediate
    for (const m of interAddrs) addPath([fromAddr, m, toAddr]);
    // Two intermediates
    for (let i = 0; i < interAddrs.length; i++) {
      for (let j = 0; j < interAddrs.length; j++) {
        if (i === j) continue;
        addPath([fromAddr, interAddrs[i]!, interAddrs[j]!, toAddr]);
      }
    }
  }
  if (IS_DEBUG) console.error(`[quote-swap] trying ${candidatePaths.length} paths`);
  const evaluatePathOut = async (path: string[], inRaw: bigint) => {
    try {
      if (IS_DEBUG) console.error(`[quote-swap] getAmountsOut start hops=${path.length}`);
      const amounts: bigint[] = await withTimeout(
        router.getAmountsOut(inRaw, path),
        DEFAULT_RPC_CALL_TIMEOUT_MS,
        `getAmountsOut(${path.length}-hop)`
      );
      const out = amounts[amounts.length - 1]!;
      if (IS_DEBUG) console.error(`[quote-swap] getAmountsOut ok hops=${path.length}`);
      return out;
    } catch (e) {
      if (IS_DEBUG) console.error(`[quote-swap] getAmountsOut failed hops=${path.length}: ${(e as Error)?.message ?? e}`);
      return 0n;
    }
  };

  const results = await Promise.all(candidatePaths.map(async (path) => {
    const out = await evaluatePathOut(path, amountInRaw);
    if (out === 0n) return null;
    return { path, out } as const;
  }));
  for (const r of results) {
    // just iterate to preserve the array in memory for TS; actual selection happens below
    if (!r) { /* skip */ }
  }
  const ranked = (results.filter(Boolean) as Array<{ path: string[]; out: bigint }>).sort((a, b) => (a.out > b.out ? -1 : (a.out < b.out ? 1 : 0)));
  if (!ranked.length) throw new Error('Aucune route de swap valable trouvée');

  // If split routing is allowed and at least 2 viable routes, search a simple 2-way split.
  const allowSplit = Boolean(params.allowSplitRouting);
  if (allowSplit && ranked.length >= 2) {
    const [r1, r2] = ranked.slice(0, 2);
    const steps = 10; // 10% increments
    let bestTotalOut = 0n;
    let bestPercentToR1 = 100; // default to 100% to r1
    let bestOut1 = ranked[0]!.out;
    let bestOut2 = 0n;
    for (let p = steps; p <= 100 - steps; p += steps) {
      const in1 = (amountInRaw * BigInt(p)) / 100n;
      const in2 = amountInRaw - in1;
      const [o1, o2] = await Promise.all([
        evaluatePathOut(r1.path, in1),
        evaluatePathOut(r2.path, in2),
      ]);
      const total = o1 + o2;
      if (total > bestTotalOut) {
        bestTotalOut = total; bestPercentToR1 = p; bestOut1 = o1; bestOut2 = o2;
      }
    }
    // Compare with sending 100% to best route (ranked[0])
    if (ranked[0].out >= bestTotalOut) {
      const bestPath = ranked[0].path;
  const pathSymbols = await Promise.all(bestPath.map(async (addr) => {
    if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
    if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
    if (addr.toLowerCase() === WBNB.toLowerCase()) return 'WBNB';
    if (addr.toLowerCase() === BUSD.toLowerCase()) return 'BUSD';
    if (addr.toLowerCase() === USDT.toLowerCase()) return 'USDT';
    return 'UNKNOWN';
  }));
  return {
    amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
        amountOut: ethers.formatUnits(ranked[0].out, toDecimals),
    amountInRaw: amountInRaw.toString(),
        amountOutRaw: ranked[0].out.toString(),
    from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
    to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
    path: bestPath,
    pathSymbols,
        provider: 'pcs-v2',
        tradingFeeBpsApprox: Math.max(25, (bestPath.length - 1) * 25),
      };
    }
    // Split result
    const in1 = (amountInRaw * BigInt(bestPercentToR1)) / 100n;
    const in2 = amountInRaw - in1;
    const formatPathSymbols = async (p: string[]) => Promise.all(p.map(async (addr) => {
      if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
      if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
      if (addr.toLowerCase() === WBNB.toLowerCase()) return 'WBNB';
      if (addr.toLowerCase() === BUSD.toLowerCase()) return 'BUSD';
      if (addr.toLowerCase() === USDT.toLowerCase()) return 'USDT';
      return 'UNKNOWN';
    }));
    const part1: SplitQuotePart = {
      amountIn: ethers.formatUnits(in1, fromDecimals),
      amountOut: ethers.formatUnits(bestOut1, toDecimals),
      amountInRaw: in1.toString(),
      amountOutRaw: bestOut1.toString(),
      path: r1.path,
      pathSymbols: await formatPathSymbols(r1.path),
    };
    const part2: SplitQuotePart = {
      amountIn: ethers.formatUnits(in2, fromDecimals),
      amountOut: ethers.formatUnits(bestOut2, toDecimals),
      amountInRaw: in2.toString(),
      amountOutRaw: bestOut2.toString(),
      path: r2.path,
      pathSymbols: await formatPathSymbols(r2.path),
    };
    const totalOut = bestOut1 + bestOut2;
    return {
      amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
      amountOut: ethers.formatUnits(totalOut, toDecimals),
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: totalOut.toString(),
      from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
      to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
      isSplit: true,
      parts: [part1, part2],
    };
  }

  // Fallback: best single route
  const best = ranked[0]!;
  const pathSymbols = await Promise.all(best.path.map(async (addr) => {
    if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
    if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
    if (addr.toLowerCase() === WBNB.toLowerCase()) return 'WBNB';
    if (addr.toLowerCase() === BUSD.toLowerCase()) return 'BUSD';
    if (addr.toLowerCase() === USDT.toLowerCase()) return 'USDT';
    return 'UNKNOWN';
  }));
  return {
    amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
    amountOut: ethers.formatUnits(best.out, toDecimals),
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: best.out.toString(),
    from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
    to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
    path: best.path,
    pathSymbols,
    provider: 'pcs-v2',
    tradingFeeBpsApprox: Math.max(25, (best.path.length - 1) * 25),
  };
}

function getV3Quoter(provider: ethers.Provider, overrideAddr?: string | null): ethers.Contract | null {
  const addr = (overrideAddr || DEFAULT_V3_QUOTER).trim();
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
  return new ethers.Contract(addr, QUOTER_V3_ABI, provider);
}

function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length < 2) throw new Error('encodeV3Path: need at least 2 tokens');
  if (fees.length !== tokens.length - 1) throw new Error('encodeV3Path: fees length mismatch');
  // Uniswap/Pancake v3 path encoding: token0 (20) + fee0 (3) + token1 (20) + fee1 (3) + token2 (20) ...
  let hex = '0x' + tokens[0]!.toLowerCase().replace(/^0x/, '');
  for (let i = 0; i < fees.length; i++) {
    const feeHex = fees[i]!.toString(16).padStart(6, '0');
    hex += feeHex;
    hex += tokens[i + 1]!.toLowerCase().replace(/^0x/, '');
  }
  return hex;
}

async function quoteV3ExactInput(quoter: ethers.Contract, pathBytes: string, amountInRaw: bigint): Promise<bigint> {
  // Try Quoter/QuoterV2 using staticCall to avoid sending a tx
  try {
    const r: any = await withTimeout((quoter as any).quoteExactInput.staticCall(pathBytes, amountInRaw), DEFAULT_RPC_CALL_TIMEOUT_MS, 'v3.quoteExactInput.static');
    if (Array.isArray(r)) {
      const amt: bigint = r[0] as bigint;
      return amt;
    }
    return r as bigint;
  } catch (e) {
    if (IS_DEBUG) console.error(`[quote-swap] v3 quoteExactInput(static) failed: ${(e as Error)?.message ?? e}`);
  }
  try {
    // Some deployments may allow direct call
    const r2: any = await withTimeout((quoter as any).quoteExactInput(pathBytes, amountInRaw), DEFAULT_RPC_CALL_TIMEOUT_MS, 'v3.quoteExactInput');
    if (Array.isArray(r2)) return r2[0] as bigint;
    return r2 as bigint;
  } catch (e) {
    if (IS_DEBUG) console.error(`[quote-swap] v3 quoteExactInput fallback failed: ${(e as Error)?.message ?? e}`);
  }
  return 0n;
}

async function quoteV3ExactInputSingle(quoter: ethers.Contract, tokenIn: string, tokenOut: string, fee: number, amountInRaw: bigint): Promise<bigint> {
  // Try Quoter legacy via staticCall
  try {
    const r1: any = await withTimeout((quoter as any).quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountInRaw, 0), DEFAULT_RPC_CALL_TIMEOUT_MS, 'v3.quoteExactInputSingle.static');
    if (typeof r1 === 'bigint') return r1 as bigint;
    if (Array.isArray(r1) && r1.length > 0) return r1[0] as bigint;
  } catch {}
  // Try QuoterV2 with struct via staticCall
  try {
    const params = { tokenIn, tokenOut, fee, amountIn: amountInRaw, sqrtPriceLimitX96: 0 } as any;
    const r2: any = await withTimeout((quoter as any).quoteExactInputSingle.staticCall(params), DEFAULT_RPC_CALL_TIMEOUT_MS, 'v3.quoteExactInputSingleV2.static');
    if (Array.isArray(r2) && r2.length > 0) return r2[0] as bigint;
  } catch (e) {
    if (IS_DEBUG) console.error(`[quote-swap] v3 quoteExactInputSingle failed: ${(e as Error)?.message ?? e}`);
  }
  return 0n;
}

export async function quotePcsV3BestExactIn(params: {
  fromSymbol: string;
  toSymbol: string;
  amountInUnits: number;
  allowMultiHop?: boolean;
  allowSplitRouting?: boolean;
  maxHops?: number;
  feeTiers?: number[];
  quoterAddress?: string;
}): Promise<LiveQuote> {
  const provider = getProvider();
  if (!provider) throw new Error('Provider non disponible');
  const quoter = getV3Quoter(provider, params.quoterAddress);
  if (!quoter) throw new Error('Quoter v3 indisponible: configurez SERVER_PCS_V3_QUOTER');
  const fromSymbol = params.fromSymbol.toUpperCase();
  const toSymbol = params.toSymbol.toUpperCase();
  const fromAddr = getKnownTokenAddress(fromSymbol);
  const toAddr = getKnownTokenAddress(toSymbol);
  if (!fromAddr || !toAddr) throw new Error(`Adresse inconnue pour ${fromSymbol} ou ${toSymbol}`);
  const fromDecimals = await fetchTokenDecimals(provider, fromAddr);
  const toDecimals = await fetchTokenDecimals(provider, toAddr);
  const amountInRaw = ethers.parseUnits(String(params.amountInUnits), fromDecimals);
  const interSyms = getPreferredIntermediates();
  const interAddrs = resolveSymbolsToAddresses(interSyms);
  const allowMultiHop = Boolean(params.allowMultiHop);
  const maxHops = Math.max(2, Math.min(4, Number(params.maxHops ?? 3)));
  const feeTiers = (params.feeTiers && params.feeTiers.length ? params.feeTiers : DEFAULT_V3_FEE_TIERS).slice(0, 6);

  type V3Route = { tokens: string[]; fees: number[] };
  const routes: V3Route[] = [];
  const addRoute = (tokens: string[]) => {
    const clean = uniqueAddresses(tokens);
    if (clean.length < 2) return;
    if (!allowMultiHop && clean.length !== 2) return;
    if (allowMultiHop && clean.length > maxHops) return;
    // Expand by fee tier combinations per hop
    const hops = clean.length - 1;
    const choose = (depth: number, currentFees: number[]) => {
      if (depth === hops) {
        routes.push({ tokens: clean, fees: currentFees.slice() });
        return;
      }
      for (const f of feeTiers) choose(depth + 1, [...currentFees, f]);
    };
    choose(0, []);
  };
  addRoute([fromAddr, toAddr]);
  if (allowMultiHop) {
    for (const m of interAddrs) addRoute([fromAddr, m, toAddr]);
    for (let i = 0; i < interAddrs.length; i++) {
      for (let j = 0; j < interAddrs.length; j++) {
        if (i === j) continue;
        addRoute([fromAddr, interAddrs[i]!, interAddrs[j]!, toAddr]);
      }
    }
  }
  if (IS_DEBUG) console.error(`[quote-swap] v3 trying ${routes.length} route+fee combos`);

  const evalRoute = async (r: V3Route): Promise<bigint> => {
    // Always try multi-hop encoding; single-hop can use quoteExactInputSingle
    if (r.tokens.length === 2) {
      const single = await quoteV3ExactInputSingle(quoter, r.tokens[0]!, r.tokens[1]!, r.fees[0]!, amountInRaw);
      const path = encodeV3Path(r.tokens, r.fees);
      const multi = await quoteV3ExactInput(quoter, path, amountInRaw);
      return multi > 0n ? multi : single;
    }
    const path = encodeV3Path(r.tokens, r.fees);
    return await quoteV3ExactInput(quoter, path, amountInRaw);
  };

  const outputs = await Promise.all(routes.map(async (r) => {
    try {
      const out = await evalRoute(r);
      return out > 0n ? { r, out } : null;
    } catch { return null; }
  }));

  const ranked = (outputs.filter(Boolean) as Array<{ r: V3Route; out: bigint }>).sort((a, b) => (a.out > b.out ? -1 : (a.out < b.out ? 1 : 0)));
  if (!ranked.length) throw new Error('Aucune route v3 valable trouvée');

  const allowSplit = Boolean(params.allowSplitRouting);
  if (allowSplit && ranked.length >= 2) {
    const [x, y] = ranked.slice(0, 2);
    const steps = 10;
    let bestTotal = 0n; let bestP = 100; let bestO1 = x.out; let bestO2 = 0n;
    for (let p = steps; p <= 100 - steps; p += steps) {
      const a1 = (amountInRaw * BigInt(p)) / 100n; const a2 = amountInRaw - a1;
      const [o1, o2] = await Promise.all([
        (async () => {
          if (x.r.tokens.length === 2) return await quoteV3ExactInputSingle(quoter, x.r.tokens[0]!, x.r.tokens[1]!, x.r.fees[0]!, a1);
          return await quoteV3ExactInput(quoter, encodeV3Path(x.r.tokens, x.r.fees), a1);
        })(),
        (async () => {
          if (y.r.tokens.length === 2) return await quoteV3ExactInputSingle(quoter, y.r.tokens[0]!, y.r.tokens[1]!, y.r.fees[0]!, a2);
          return await quoteV3ExactInput(quoter, encodeV3Path(y.r.tokens, y.r.fees), a2);
        })(),
      ]);
      const tot = o1 + o2;
      if (tot > bestTotal) { bestTotal = tot; bestP = p; bestO1 = o1; bestO2 = o2; }
    }
    if (ranked[0].out >= bestTotal) {
      const best = ranked[0]!;
      const pathSymbols = await Promise.all(best.r.tokens.map(async (addr) => {
        if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
        if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
        const wbnb = getKnownTokenAddress('WBNB')?.toLowerCase();
        const busd = getKnownTokenAddress('BUSD')?.toLowerCase();
        const usdt = getKnownTokenAddress('USDT')?.toLowerCase();
        const usdc = getKnownTokenAddress('USDC')?.toLowerCase();
        if (wbnb && addr.toLowerCase() === wbnb) return 'WBNB';
        if (busd && addr.toLowerCase() === busd) return 'BUSD';
        if (usdt && addr.toLowerCase() === usdt) return 'USDT';
        if (usdc && addr.toLowerCase() === usdc) return 'USDC';
        return 'UNKNOWN';
      }));
      return {
        amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
        amountOut: ethers.formatUnits(best.out, toDecimals),
        amountInRaw: amountInRaw.toString(),
        amountOutRaw: best.out.toString(),
        from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
        to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
        path: best.r.tokens,
        pathSymbols,
        v3FeesBpsPerHop: best.r.fees,
      };
    }
    const p1 = (amountInRaw * BigInt(bestP)) / 100n; const p2 = amountInRaw - p1;
    const format = async (tokens: string[]) => Promise.all(tokens.map(async (addr) => {
      if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
      if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
      const wbnb = getKnownTokenAddress('WBNB')?.toLowerCase();
      const busd = getKnownTokenAddress('BUSD')?.toLowerCase();
      const usdt = getKnownTokenAddress('USDT')?.toLowerCase();
      const usdc = getKnownTokenAddress('USDC')?.toLowerCase();
      if (wbnb && addr.toLowerCase() === wbnb) return 'WBNB';
      if (busd && addr.toLowerCase() === busd) return 'BUSD';
      if (usdt && addr.toLowerCase() === usdt) return 'USDT';
      if (usdc && addr.toLowerCase() === usdc) return 'USDC';
      return 'UNKNOWN';
    }));
    const part1: SplitQuotePart = {
      amountIn: ethers.formatUnits(p1, fromDecimals),
      amountOut: ethers.formatUnits(bestO1, toDecimals),
      amountInRaw: p1.toString(),
      amountOutRaw: bestO1.toString(),
      path: x.r.tokens,
      pathSymbols: await format(x.r.tokens),
    };
    const part2: SplitQuotePart = {
      amountIn: ethers.formatUnits(p2, fromDecimals),
      amountOut: ethers.formatUnits(bestO2, toDecimals),
      amountInRaw: p2.toString(),
      amountOutRaw: bestO2.toString(),
      path: y.r.tokens,
      pathSymbols: await format(y.r.tokens),
    };
    const totalOut = bestO1 + bestO2;
    return {
      amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
      amountOut: ethers.formatUnits(totalOut, toDecimals),
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: totalOut.toString(),
      from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
      to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
      isSplit: true,
      parts: [part1, part2],
    };
  }

  const best = ranked[0]!;
  const pathSymbols = await Promise.all(best.r.tokens.map(async (addr) => {
    if (addr.toLowerCase() === fromAddr.toLowerCase()) return fromSymbol;
    if (addr.toLowerCase() === toAddr.toLowerCase()) return toSymbol;
    const wbnb = getKnownTokenAddress('WBNB')?.toLowerCase();
    const busd = getKnownTokenAddress('BUSD')?.toLowerCase();
    const usdt = getKnownTokenAddress('USDT')?.toLowerCase();
    const usdc = getKnownTokenAddress('USDC')?.toLowerCase();
    if (wbnb && addr.toLowerCase() === wbnb) return 'WBNB';
    if (busd && addr.toLowerCase() === busd) return 'BUSD';
    if (usdt && addr.toLowerCase() === usdt) return 'USDT';
    if (usdc && addr.toLowerCase() === usdc) return 'USDC';
    return 'UNKNOWN';
  }));
  return {
    amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
    amountOut: ethers.formatUnits(best.out, toDecimals),
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: best.out.toString(),
    from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
    to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
    path: best.r.tokens,
    pathSymbols,
    v3FeesBpsPerHop: best.r.fees,
  };
}

export async function quoteBestExactIn(params: {
  dex?: DexVersion;
  fromSymbol: string;
  toSymbol: string;
  amountInUnits: number;
  allowMultiHop?: boolean;
  allowSplitRouting?: boolean;
  maxHops?: number;
  feeTiers?: number[];
  quoterAddress?: string;
}): Promise<LiveQuote> {
  const dex = (params.dex ?? (DEFAULT_V3_QUOTER ? 'pcs-v3' : 'pcs-v2')) as DexVersion;
  if (dex === 'pcs-v3') {
    return await quotePcsV3BestExactIn(params);
  }
  return await quotePcsV2BestExactIn(params);
}

/** Quote best of PancakeSwap v2 and v3 (on-chain), multi-hop enabled by default. */
export async function quotePancakeBest(params: {
  fromSymbol: string;
  toSymbol: string;
  amountInUnits: number;
  allowMultiHop?: boolean;
  maxHops?: number;
  feeTiers?: number[];
}): Promise<LiveQuote> {
  const [q2, q3] = await Promise.allSettled([
    quotePcsV2BestExactIn({ ...params, allowMultiHop: params.allowMultiHop ?? true, allowSplitRouting: false }),
    quotePcsV3BestExactIn({ ...params, allowMultiHop: params.allowMultiHop ?? true }),
  ]);
  const ok2 = q2.status === 'fulfilled' ? q2.value as LiveQuote : null;
  const ok3 = q3.status === 'fulfilled' ? q3.value as LiveQuote : null;
  if (!ok2 && !ok3) throw new Error('Aucune route Pancake (v2/v3) trouvée');
  if (ok2 && !ok3) return { ...ok2, provider: 'pcs-v2' };
  if (!ok2 && ok3) return { ...ok3, provider: 'pcs-v3' };
  const a2 = BigInt((ok2 as LiveQuote).amountOutRaw);
  const a3 = BigInt((ok3 as LiveQuote).amountOutRaw);
  return a3 > a2 ? { ...(ok3 as LiveQuote), provider: 'pcs-v3' } : { ...(ok2 as LiveQuote), provider: 'pcs-v2' };
}

/** Compute USD value on-chain by quoting to USDT using best Pancake route. */
export async function computeUsdValueOnPancake(symbol: string, amountUnits: number): Promise<number | undefined> {
  const from = symbol.toUpperCase();
  if (from === 'USDT') return amountUnits;
  const stable = 'USDT';
  try {
    const q = await quotePancakeBest({ fromSymbol: from, toSymbol: stable, amountInUnits: amountUnits, allowMultiHop: true });
    const v = Number(q.amountOut);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export type GasPriceNow = { source: 'etherscan' | 'rpc'; slowGwei?: number; proposeGwei?: number; fastGwei?: number; gasPriceGwei: number; };

export async function fetchGasPriceNow(): Promise<GasPriceNow> {
  const apiKey = process.env.SERVER_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  try {
    if (apiKey) {
      const { data } = await axios.get('https://api.etherscan.io/v2/api', { params: { chainid: 56, module: 'gastracker', action: 'gasoracle', apikey: apiKey }, timeout: 8000 });
      const r = data?.result || {};
      const slow = Number(r.SafeGasPrice); const propose = Number(r.ProposeGasPrice); const fast = Number(r.FastGasPrice);
      const chosen = Number.isFinite(propose) && propose > 0 ? propose : (Number.isFinite(fast) && fast > 0 ? fast : (Number.isFinite(slow) ? slow : 0));
      if (chosen > 0) return { source: 'etherscan', slowGwei: slow, proposeGwei: propose, fastGwei: fast, gasPriceGwei: chosen };
    }
  } catch {}
  const provider = getProvider();
  if (!provider) return { source: 'rpc', gasPriceGwei: 3 };
  const fee = await withTimeout(provider.getFeeData(), DEFAULT_RPC_CALL_TIMEOUT_MS, 'provider.getFeeData');
  const gp = fee.gasPrice ?? ethers.parseUnits('3', 'gwei');
  const gwei = Number(ethers.formatUnits(gp, 'gwei'));
  return { source: 'rpc', gasPriceGwei: gwei };
}

export function estimateSwapGasLimitByHops(pathLength: number): number { if (pathLength <= 2) return 140_000; return 140_000 + (pathLength - 2) * 60_000; }

export type SwapCostNow = { quote: LiveQuote; gas: GasPriceNow & { gasLimit: number; txCostBNB: number; txCostUSD?: number } };

export type QuoteEngine = 'oneinch' | 'pcs';

// 1inch API configuration
const ONEINCH_API_KEY = (process.env.SERVER_ONEINCH_API_KEY || process.env.ONEINCH_API_KEY || '').trim();
const ONEINCH_V6_BASE = (process.env.SERVER_ONEINCH_V6_BASE_URL || process.env.ONEINCH_V6_BASE_URL || 'https://api.1inch.dev/swap/v6.0').trim();
const ONEINCH_V5_BASE = (process.env.SERVER_ONEINCH_V5_BASE_URL || process.env.ONEINCH_V5_BASE_URL || 'https://api.1inch.io/v5.0').trim();

type OneInchV5Quote = {
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  toTokenAmount: string; // stringified integer
  fromTokenAmount: string;
  protocols?: any[]; // nested routes
  estimatedGas?: number;
};

async function requestOneInchQuote(chainId: number, params: { fromTokenAddress: string; toTokenAddress: string; amount: string; }): Promise<OneInchV5Quote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_RPC_CALL_TIMEOUT_MS);
  try {
    if (ONEINCH_API_KEY) {
      const url = `${ONEINCH_V6_BASE}/${chainId}/quote`;
      const { data } = await axios.get(url, {
        params: { src: params.fromTokenAddress, dst: params.toTokenAddress, amount: params.amount, includeTokensInfo: true },
        headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` },
        signal: controller.signal,
      });
      // Normalize to V5-like shape
      const tokenIn = data?.tokens?.[params.fromTokenAddress.toLowerCase()] || {};
      const tokenOut = data?.tokens?.[params.toTokenAddress.toLowerCase()] || {};
      const toAmount = data?.dstAmount ?? data?.toTokenAmount ?? '0';
      const fromAmount = data?.srcAmount ?? data?.fromTokenAmount ?? params.amount;
      return {
        fromToken: { symbol: tokenIn?.symbol || 'UNKNOWN', address: params.fromTokenAddress, decimals: Number(tokenIn?.decimals) || 18 },
        toToken: { symbol: tokenOut?.symbol || 'UNKNOWN', address: params.toTokenAddress, decimals: Number(tokenOut?.decimals) || 18 },
        toTokenAmount: String(toAmount),
        fromTokenAmount: String(fromAmount),
        protocols: data?.protocols,
        estimatedGas: Number(data?.gas || data?.estimatedGas || 0) || undefined,
      } as OneInchV5Quote;
    }
    // Fallback to public v5
    const url = `${ONEINCH_V5_BASE}/${chainId}/quote`;
    const { data } = await axios.get(url, { params, signal: controller.signal });
    return data as OneInchV5Quote;
  } finally {
    clearTimeout(timer);
  }
}

function extractPathSymbolsFromProtocols(protocols: any[] | undefined, fallbackSymbols: { from: string; to: string; }): string[] | undefined {
  try {
    if (!Array.isArray(protocols) || protocols.length === 0) return undefined;
    // 1inch protocols is nested arrays; take first route and map token symbols if present
    const route = protocols[0];
    const hops: any[] = Array.isArray(route) ? route : [];
    const symbols: string[] = [fallbackSymbols.from];
    for (const hop of hops) {
      const s = hop?.toTokenSymbol || hop?.toToken?.symbol || undefined;
      if (typeof s === 'string') symbols.push(s.toUpperCase());
    }
    if (symbols.length >= 2) return symbols;
  } catch {}
  return undefined;
}

function approxTradingFeeBpsFromProtocols(protocols: any[] | undefined): number | undefined {
  try {
    if (!Array.isArray(protocols) || protocols.length === 0) return undefined;
    // assume first route; count hops as number of segments
    const route = protocols[0];
    const hops: any[] = Array.isArray(route) ? route : [];
    const hopCount = Math.max(1, hops.length);
    // Approximate: 25 bps per hop as a conservative v2-like baseline
    return hopCount * 25;
  } catch {
    return undefined;
  }
}

export async function quoteWithOneInchExactIn(params: { fromSymbol: string; toSymbol: string; amountInUnits: number; slippagePercent?: number; }): Promise<LiveQuote> {
  const provider = getProvider();
  if (!provider) throw new Error('Provider non disponible');
  const fromSymbol = params.fromSymbol.toUpperCase();
  const toSymbol = params.toSymbol.toUpperCase();
  const fromAddr = getKnownTokenAddress(fromSymbol);
  const toAddr = getKnownTokenAddress(toSymbol);
  if (!fromAddr || !toAddr) throw new Error(`Adresse inconnue pour ${fromSymbol} ou ${toSymbol}`);
  const fromDecimals = await fetchTokenDecimals(provider, fromAddr);
  const toDecimals = await fetchTokenDecimals(provider, toAddr);
  const amountInRaw = ethers.parseUnits(String(params.amountInUnits), fromDecimals);
  const chainId = 56; // BSC
  const res = await requestOneInchQuote(chainId, { fromTokenAddress: fromAddr, toTokenAddress: toAddr, amount: amountInRaw.toString() });
  const outRaw = BigInt(res?.toTokenAmount || '0');
  if (outRaw <= 0n) throw new Error('Aucune route 1inch valable trouvée');

  const quote: LiveQuote = {
    amountIn: ethers.formatUnits(amountInRaw, fromDecimals),
    amountOut: ethers.formatUnits(outRaw, toDecimals),
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: outRaw.toString(),
    from: { symbol: fromSymbol, address: fromAddr, decimals: fromDecimals },
    to: { symbol: toSymbol, address: toAddr, decimals: toDecimals },
    provider: 'oneinch',
    estimatedGasUnits: typeof res?.estimatedGas === 'number' && res.estimatedGas > 0 ? res.estimatedGas : undefined,
    tradingFeeBpsApprox: approxTradingFeeBpsFromProtocols(res?.protocols),
  };

  // Slippage → amountOutMin
  const slip = Number(params.slippagePercent ?? (process.env.SERVER_DEFAULT_SLIPPAGE_PERCENT ?? 0));
  if (Number.isFinite(slip) && slip > 0) {
    const denom = 1_000_000n; const factor = denom - BigInt(Math.floor((slip / 100) * Number(denom)));
    const minRaw = (outRaw * factor) / denom;
    quote.amountOutMin = ethers.formatUnits(minRaw, toDecimals);
  }

  // Attempt to fill pathSymbols from protocols
  const pathSymbols = extractPathSymbolsFromProtocols(res?.protocols, { from: fromSymbol, to: toSymbol });
  if (pathSymbols && pathSymbols.length >= 2) {
    quote.pathSymbols = pathSymbols;
  }

  return quote;
}

export async function simulateSwapCostNow(params: { fromSymbol: string; toSymbol: string; amountInUnits: number; bnbPriceUSD?: number; allowMultiHop?: boolean; allowSplitRouting?: boolean; maxHops?: number; dex?: DexVersion; feeTiers?: number[]; slippagePercent?: number; quoterAddress?: string; engine?: QuoteEngine; }): Promise<SwapCostNow> {
  const engine = (params.engine ?? 'oneinch') as QuoteEngine;
  const quote = engine === 'oneinch'
    ? await quoteWithOneInchExactIn({ fromSymbol: params.fromSymbol, toSymbol: params.toSymbol, amountInUnits: params.amountInUnits, slippagePercent: params.slippagePercent })
    : await quoteBestExactIn(params);
  const gasNow = await fetchGasPriceNow();
  const gasLimit = (() => {
    if (quote.provider === 'oneinch') {
      // Use estimatedGas when available from 1inch, otherwise conservative fallback
      // Note: estimatedGas is not part of LiveQuote; conservatively use single-hop estimate
      return 180_000;
    }
    if (quote.isSplit && Array.isArray(quote.parts) && quote.parts.length > 0) {
      return quote.parts.map((p) => estimateSwapGasLimitByHops(p.path.length)).reduce((a, b) => a + b, 0);
    }
    return estimateSwapGasLimitByHops((quote.path?.length ?? 2));
  })();
  const txCostBNB = (gasNow.gasPriceGwei * gasLimit) / 1e9;
  const gas = { ...gasNow, gasLimit, txCostBNB, txCostUSD: params.bnbPriceUSD && params.bnbPriceUSD > 0 ? txCostBNB * params.bnbPriceUSD : undefined };
  // Slippage tolerance: compute amountOutMin
  const slip = Number(params.slippagePercent ?? (process.env.SERVER_DEFAULT_SLIPPAGE_PERCENT ?? 0));
  if (Number.isFinite(slip) && slip > 0) {
    try {
      const outRaw = BigInt(quote.amountOutRaw);
      const denom = 1_000_000n;
      const factor = denom - BigInt(Math.floor((slip / 100) * Number(denom)));
      const minRaw = (outRaw * factor) / denom;
      quote.amountOutMin = ethers.formatUnits(minRaw, quote.to.decimals ?? 18);
    } catch {}
  }
  return { quote, gas };
}


