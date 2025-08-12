import { fetchCoreMarketsSortedBySupplyAPY, type CoreMarket, fetchSymbolPricesUSD, fetchTokenPricesUSDByAddress } from '@services/venusApi.js';
import { estimateGasFeesInBaseAsset } from '@services/gas.js';
import { estimateSwapFeesBps, simulateSwapCostNow, getKnownTokenAddress, quotePancakeBest, fetchGasPriceNow, estimateSwapGasLimitByHops } from '@services/swap.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SimulationConfig = {
  amountUSD: number;
  baseAssetSymbol: string; // e.g., USDC
  pollIntervalSec: number; // e.g., 60
  hours?: number; // if provided, run for this many hours
  ticks?: number; // alternatively run for N cycles
  /** When true (or when hours<=0 or ticks<=0), run indefinitely until process termination */
  continuous?: boolean;
  minNetDiffBps?: number; // threshold to trigger switch
  /** If true, use a live PancakeSwap v2 quote to estimate swap route, gas and effective output. */
  useLiveSwapQuote?: boolean;
  /** Path to append action logs (NDJSON). Defaults to `logs/actions.ndjson`. */
  logActionsPath?: string;
  /** Path to append balance evolution (NDJSON). Defaults to `logs/balance.ndjson`. */
  logBalancePath?: string;
  /** Path to append per-block gains (NDJSON). Defaults to `logs/per-block.ndjson`. */
  logPerBlockPath?: string;
  /** Path to persist simulation state (JSON). Defaults to `logs/state.json`. */
  logStatePath?: string;
  /** Max size (bytes) before rotating NDJSON logs. */
  logMaxBytes?: number;
  /** Max number of rotated files to keep per log file. */
  logMaxFiles?: number;
};

export type SimulationState = {
  startedAtMs: number;
  lastTickMs: number;
  currentAssetSymbol: string;
  positionUSD: number;
  cumulativeYieldUSD: number;
  cumulativeFeesUSD: number;
  cumulativeGasUSD?: number;
  cumulativeSwapUSD?: number;
  switches: number;
};

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export async function runDryRunSimulation(config: SimulationConfig): Promise<void> {
  const { amountUSD, baseAssetSymbol, pollIntervalSec, hours, ticks, minNetDiffBps } = config;

  const thresholdBps = minNetDiffBps ?? Number(process.env.SERVER_MIN_NET_APY_DIFF_BPS ?? process.env.MIN_NET_APY_DIFF_BPS ?? 0);
  const defaultUseLiveQuote = Boolean(process.env.SERVER_ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY);
  const useLiveQuote = typeof config.useLiveSwapQuote === 'boolean' ? config.useLiveSwapQuote : defaultUseLiveQuote;

  const defaultLogsDir = 'logs';
  const actionsFile = (config.logActionsPath || process.env.SERVER_LOG_ACTIONS_PATH || path.join(defaultLogsDir, 'actions.ndjson')).trim();
  const balanceFile = (config.logBalancePath || process.env.SERVER_LOG_BALANCE_PATH || path.join(defaultLogsDir, 'balance.ndjson')).trim();
  const blocksFile = (config.logPerBlockPath || process.env.SERVER_LOG_BLOCKS_PATH || path.join(defaultLogsDir, 'per-block.ndjson')).trim();
  const stateFile = (config.logStatePath || process.env.SERVER_LOG_STATE_PATH || path.join(defaultLogsDir, 'state.json')).trim();
  const marketsFile = (process.env.SERVER_DATA_MARKETS_PATH || path.join('data', 'markets.json')).trim();
  const resetFlagFile = (process.env.SERVER_DATA_RESET_PATH || path.join('data', 'reset.flag')).trim();
  await ensureParentDir(actionsFile);
  await ensureParentDir(balanceFile);
  await ensureParentDir(blocksFile);
  await ensureParentDir(stateFile);
  await ensureParentDir(marketsFile);
  await ensureParentDir(resetFlagFile);

  const state: SimulationState = {
    startedAtMs: Date.now(),
    lastTickMs: Date.now(),
    currentAssetSymbol: baseAssetSymbol.toUpperCase(),
    positionUSD: amountUSD,
    cumulativeYieldUSD: 0,
    cumulativeFeesUSD: 0,
    cumulativeGasUSD: 0,
    cumulativeSwapUSD: 0,
    switches: 0,
  };

  const globalMaxBytes = Number(process.env.SERVER_LOG_MAX_BYTES || process.env.LOG_MAX_BYTES || 0) || 0;
  const globalMaxFiles = Number(process.env.SERVER_LOG_MAX_FILES || process.env.LOG_MAX_FILES || 0) || 0;
  const configuredMaxBytes = typeof config.logMaxBytes === 'number' && config.logMaxBytes > 0 ? config.logMaxBytes : globalMaxBytes;
  const configuredMaxFiles = typeof config.logMaxFiles === 'number' && config.logMaxFiles > 0 ? config.logMaxFiles : globalMaxFiles;
  const defaults = inferDefaultRotationThresholds(actionsFile, balanceFile, blocksFile);
  const maxBytesActions = configuredMaxBytes || defaults.actionsBytes;
  const maxBytesBalance = configuredMaxBytes || defaults.balanceBytes;
  const maxBytesBlocks = configuredMaxBytes || defaults.blocksBytes;
  const maxFilesKeep = configuredMaxFiles || 5;

  const fingerprint = makeConfigFingerprint({ amountUSD, baseAssetSymbol: baseAssetSymbol.toUpperCase(), pollIntervalSec, thresholdBps, useLiveQuote });
  const persisted = await readStateSnapshot(stateFile);
  if (persisted && persisted.configFingerprint === fingerprint && persisted.state) {
    state.startedAtMs = persisted.state.startedAtMs || Date.now();
    state.lastTickMs = Date.now();
    state.currentAssetSymbol = persisted.state.currentAssetSymbol || state.currentAssetSymbol;
    state.positionUSD = typeof persisted.state.positionUSD === 'number' ? persisted.state.positionUSD : state.positionUSD;
    state.cumulativeYieldUSD = persisted.state.cumulativeYieldUSD ?? 0;
    state.cumulativeFeesUSD = persisted.state.cumulativeFeesUSD ?? 0;
    state.cumulativeGasUSD = persisted.state.cumulativeGasUSD ?? 0;
    state.cumulativeSwapUSD = persisted.state.cumulativeSwapUSD ?? 0;
    state.switches = persisted.state.switches ?? 0;
  }

  await rotateIfLarge(actionsFile, maxBytesActions, maxFilesKeep);
  await rotateIfLarge(balanceFile, maxBytesBalance, maxFilesKeep);
  await rotateIfLarge(blocksFile, maxBytesBlocks, maxFilesKeep);

  const isContinuous = Boolean(config.continuous) || (typeof hours === 'number' && Number.isFinite(hours) && hours <= 0) || (typeof ticks === 'number' && Number.isFinite(ticks) && ticks <= 0);
  let plannedTicks: number;
  if (isContinuous) {
    plannedTicks = 0; // sentinel
  } else if (typeof ticks === 'number' && Number.isFinite(ticks) && ticks > 0) {
    plannedTicks = Math.floor(ticks);
  } else if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0) {
    const totalSeconds = hours * 3600;
    plannedTicks = Math.max(1, Math.ceil(totalSeconds / pollIntervalSec));
  } else {
    const totalSeconds = 24 * 3600;
    plannedTicks = Math.ceil(totalSeconds / pollIntervalSec);
  }

  const startEvent = { type: 'start' as const, ts: new Date().toISOString(), amountUSD, baseAssetSymbol: state.currentAssetSymbol, pollIntervalSec, ticks: plannedTicks, thresholdBps: thresholdBps, continuous: isContinuous };
  console.log(`Simulation dry-run started: $${amountUSD.toLocaleString()} ${state.currentAssetSymbol}, interval=${pollIntervalSec}s, ${isContinuous ? 'continuous' : `ticks=${plannedTicks}`}`);
  await appendJson(actionsFile, startEvent);
  await writeStateSnapshot(stateFile, fingerprint, state);

  async function runOneTick(): Promise<void> {
    const tickStart = Date.now();
    try {
      await rotateIfLarge(actionsFile, maxBytesActions, maxFilesKeep);
      await rotateIfLarge(balanceFile, maxBytesBalance, maxFilesKeep);
      await rotateIfLarge(blocksFile, maxBytesBlocks, maxFilesKeep);

      if (await isResetRequested(resetFlagFile)) {
        state.startedAtMs = Date.now();
        state.lastTickMs = Date.now();
        state.currentAssetSymbol = baseAssetSymbol.toUpperCase();
        state.positionUSD = amountUSD;
        state.cumulativeYieldUSD = 0;
        state.cumulativeFeesUSD = 0;
        state.cumulativeGasUSD = 0;
        state.cumulativeSwapUSD = 0;
        state.switches = 0;
        const restartEvent = { type: 'start' as const, ts: new Date().toISOString(), amountUSD, baseAssetSymbol: state.currentAssetSymbol, pollIntervalSec, ticks: plannedTicks, thresholdBps: thresholdBps, continuous: isContinuous };
        await appendJson(actionsFile, restartEvent);
        await clearResetFlag(resetFlagFile);
        await writeStateSnapshot(stateFile, fingerprint, state);
      }

      const markets = await fetchCoreMarketsSortedBySupplyAPY();
      await writeJson(marketsFile, { ts: new Date().toISOString(), markets });
      if (markets.length === 0) {
        const msg = 'No core markets available at this tick';
        console.log(msg);
        await safeAppend(actionsFile, msg + '\n');
        await delay(pollIntervalSec * 1000);
        return; // nothing to do this tick
      }

      const nowMs = Date.now();
      const deltaSec = (nowMs - state.lastTickMs) / 1000;
      state.lastTickMs = nowMs;

      const current = pickMarketForSymbol(markets, state.currentAssetSymbol) ?? markets[0];
      const currentApy = current.supplyApyPercent;
      const secondsPerBlock = current.blocksPerYear > 0 ? SECONDS_PER_YEAR / current.blocksPerYear : 3;
      const ratePerBlock = current.supplyRatePerBlock > 0 ? current.supplyRatePerBlock : Math.pow(1 + currentApy / 100, 1 / (current.blocksPerYear || 10512000)) - 1;
      const blocksElapsedFloat = deltaSec / secondsPerBlock;
      const blocksElapsed = Math.max(0, Math.floor(blocksElapsedFloat));
      let perTickBlockGainTotal = 0;
      for (let b = 1; b <= blocksElapsed; b++) {
        const beforeBlock = state.positionUSD;
        state.positionUSD *= 1 + ratePerBlock;
        const gainBlock = state.positionUSD - beforeBlock;
        perTickBlockGainTotal += gainBlock;
        await appendJson(blocksFile, { ts: new Date().toISOString(), asset: state.currentAssetSymbol, blockIndex: b, ratePerBlock, positionBefore: beforeBlock, blockGainUSD: gainBlock, positionAfter: state.positionUSD });
      }
      if (blocksElapsed === 0 && deltaSec > 0) {
        const growth = Math.pow(1 + currentApy / 100, deltaSec / SECONDS_PER_YEAR);
        const beforeApprox = state.positionUSD;
        state.positionUSD *= growth;
        const gainApprox = state.positionUSD - beforeApprox;
        perTickBlockGainTotal += gainApprox;
        await appendJson(blocksFile, { ts: new Date().toISOString(), asset: state.currentAssetSymbol, blockIndex: 0, ratePerBlock, positionBefore: beforeApprox, blockGainUSD: gainApprox, positionAfter: state.positionUSD });
      }
      state.cumulativeYieldUSD += perTickBlockGainTotal;
      await appendJson(balanceFile, { t: new Date().toISOString(), v: state.positionUSD });

      const best = markets[0];
      const bestApy = best.supplyApyPercent;

      const bnbPrice = (await fetchSymbolPricesUSD())['BNB'] ?? 0;
      const gasFeeBNB = await estimateGasFeesInBaseAsset();
      let gasFeeUSD = bnbPrice > 0 ? gasFeeBNB * bnbPrice : 0;
      let swapFeeBps = await estimateSwapFeesBps(state.currentAssetSymbol, best.assetSymbol);
      let swapFeeUSD = (state.positionUSD * swapFeeBps) / 10000;
      if (useLiveQuote) {
        try {
          const currentSymbol = state.currentAssetSymbol.toUpperCase();
          const currentAddr = getKnownTokenAddress(currentSymbol);
          const bestAddr = getKnownTokenAddress(best.assetSymbol.toUpperCase());
          if (currentAddr && bestAddr) {
            const priceMap = await fetchTokenPricesUSDByAddress([currentAddr.toLowerCase(), bestAddr.toLowerCase()]);
            const currentPriceUSD = priceMap[currentAddr.toLowerCase()] ?? (currentSymbol === 'BNB' ? bnbPrice : 1);
            const amountInUnits = currentPriceUSD > 0 ? state.positionUSD / currentPriceUSD : 0;
            if (amountInUnits > 0) {
              const liveQuote = await quotePancakeBest({ fromSymbol: currentSymbol, toSymbol: best.assetSymbol, amountInUnits, allowMultiHop: true });
              const hops = (() => {
                if (Array.isArray(liveQuote.v3FeesBpsPerHop) && liveQuote.v3FeesBpsPerHop.length > 0) {
                  return liveQuote.v3FeesBpsPerHop.length;
                }
                return Math.max(1, ((liveQuote.path?.length ?? 2) - 1));
              })();
              const tradingFeeBps = Array.isArray(liveQuote.v3FeesBpsPerHop) && liveQuote.v3FeesBpsPerHop.length > 0
                ? liveQuote.v3FeesBpsPerHop.reduce((a, b) => a + b, 0)
                : Math.min(1000, hops * 25);
              swapFeeBps = Math.max(swapFeeBps, tradingFeeBps);
              swapFeeUSD = (state.positionUSD * swapFeeBps) / 10000;

              const gasNow = await fetchGasPriceNow();
              const gasLimit = estimateSwapGasLimitByHops(hops + 1);
              const txCostBNB = (gasNow.gasPriceGwei * gasLimit) / 1e9;
              gasFeeUSD = bnbPrice > 0 ? txCostBNB * bnbPrice : gasFeeUSD;
            }
          }
        } catch {}
      }

      const gasPercent = state.positionUSD > 0 ? (gasFeeUSD / state.positionUSD) * 100 : 0;
      const netApyDiffPercent = bestApy - currentApy - swapFeeBps / 100 - gasPercent;
      const profitable = netApyDiffPercent > thresholdBps / 100;

      const tickEvent = { type: 'tick' as const, ts: new Date().toISOString(), currentAsset: state.currentAssetSymbol, currentApyPercent: currentApy, ratePerBlock, bestAsset: best.assetSymbol, bestApyPercent: best.supplyApyPercent, positionUSD: state.positionUSD, blocksElapsed, netApyDiffPercent, profitable, gasFeeUSD, swapFeeUSD, cumulativeFeesUSD: state.cumulativeFeesUSD, cumulativeGasUSD: state.cumulativeGasUSD, cumulativeSwapUSD: state.cumulativeSwapUSD, cumulativeYieldUSD: state.cumulativeYieldUSD };
      console.log(`tick: ${tickEvent.currentAsset} ${tickEvent.currentApyPercent.toFixed(2)}% → best ${tickEvent.bestAsset} ${tickEvent.bestApyPercent.toFixed(2)}% | pos=$${state.positionUSD.toFixed(2)} | netΔ=${netApyDiffPercent.toFixed(3)}% ${profitable ? 'SWITCH' : ''}`);
      await appendJson(actionsFile, tickEvent);

      if (profitable && best.assetSymbol !== state.currentAssetSymbol) {
        state.positionUSD -= gasFeeUSD;
        state.positionUSD -= swapFeeUSD;
        state.cumulativeFeesUSD += gasFeeUSD + swapFeeUSD;
        state.cumulativeGasUSD = (state.cumulativeGasUSD ?? 0) + gasFeeUSD;
        state.cumulativeSwapUSD = (state.cumulativeSwapUSD ?? 0) + swapFeeUSD;
        state.currentAssetSymbol = best.assetSymbol;
        state.switches += 1;
        const switchEvent = { type: 'switch' as const, ts: new Date().toISOString(), toAsset: best.assetSymbol, gasFeeUSD, swapFeeUSD, newPositionUSD: state.positionUSD };
        console.log(`switch → ${best.assetSymbol}: gas=$${gasFeeUSD.toFixed(2)} swap=$${swapFeeUSD.toFixed(2)} | new=$${state.positionUSD.toFixed(2)}`);
        await appendJson(actionsFile, switchEvent);
      }
    } catch (error) {
      const message = (error as Error).message;
      console.error(`Simulation tick error: ${message}`);
      await appendJson(actionsFile, { type: 'error', ts: new Date().toISOString(), message });
    }

    const elapsed = Date.now() - tickStart;
    const sleepMs = Math.max(0, pollIntervalSec * 1000 - elapsed);
    await writeStateSnapshot(stateFile, fingerprint, state);
    await delay(sleepMs);
  }

  if (isContinuous) {
    // Loop forever until process termination (Ctrl+C / container stop)
    // No summary emitted on exit.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runOneTick();
    }
  } else {
    for (let i = 0; i < plannedTicks; i++) {
      await runOneTick();
    }
  }

  const durSec = (Date.now() - state.startedAtMs) / 1000;
  const summary = { type: 'summary' as const, ts: new Date().toISOString(), durationHours: Number((durSec / 3600).toFixed(4)), finalPositionUSD: state.positionUSD, cumulativeYieldUSD: state.cumulativeYieldUSD, cumulativeFeesUSD: state.cumulativeFeesUSD, cumulativeGasUSD: state.cumulativeGasUSD ?? 0, cumulativeSwapUSD: state.cumulativeSwapUSD ?? 0, switches: state.switches };
  console.log(`Simulation summary: duration=${summary.durationHours}h, final=$${summary.finalPositionUSD.toFixed(2)}, yield=$${summary.cumulativeYieldUSD.toFixed(2)}, fees=$${summary.cumulativeFeesUSD.toFixed(2)}, switches=${summary.switches}`);
  await appendJson(actionsFile, summary);
  await writeStateSnapshot(stateFile, fingerprint, state);
}

function pickMarketForSymbol(markets: CoreMarket[], symbol: string): CoreMarket | undefined {
  const s = symbol.toUpperCase();
  return markets.find(m => m.assetSymbol.toUpperCase() === s);
}

function delay(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)); }

async function ensureParentDir(filePath: string): Promise<void> { try { const dir = path.dirname(filePath); await fs.mkdir(dir, { recursive: true }); } catch {} }

async function safeAppend(filePath: string, content: string): Promise<void> { try { await fs.appendFile(filePath, content, { encoding: 'utf8' }); } catch (e) { console.error(`Failed to write to ${filePath}:`, (e as Error).message); } }

async function appendJson(filePath: string, obj: unknown): Promise<void> { const line = JSON.stringify(obj) + '\n'; await safeAppend(filePath, line); }

async function writeJson(filePath: string, obj: unknown): Promise<void> { try { const content = JSON.stringify(obj, null, 2); await fs.writeFile(filePath, content + '\n', { encoding: 'utf8' }); } catch (e) { console.error(`Failed to write JSON to ${filePath}:`, (e as Error).message); } }

async function isResetRequested(flagPath: string): Promise<boolean> { try { await fs.stat(flagPath); return true; } catch { return false; } }

async function clearResetFlag(flagPath: string): Promise<void> { try { await fs.unlink(flagPath); } catch {} }

type StateSnapshot = { ts: string; configFingerprint: string; state: SimulationState };

function makeConfigFingerprint(args: { amountUSD: number; baseAssetSymbol: string; pollIntervalSec: number; thresholdBps: number; useLiveQuote: boolean }): string {
  const { amountUSD, baseAssetSymbol, pollIntervalSec, thresholdBps, useLiveQuote } = args;
  return [amountUSD, baseAssetSymbol, pollIntervalSec, thresholdBps, useLiveQuote ? 1 : 0].join('|');
}

async function readStateSnapshot(filePath: string): Promise<StateSnapshot | undefined> { try { const raw = await fs.readFile(filePath, 'utf8'); const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && (parsed as any).state) { return parsed as StateSnapshot; } } catch {} return undefined; }

async function writeStateSnapshot(filePath: string, configFingerprint: string, state: SimulationState): Promise<void> { const snap: StateSnapshot = { ts: new Date().toISOString(), configFingerprint, state }; await writeJson(filePath, snap); }

function inferDefaultRotationThresholds(actionsFile: string, balanceFile: string, blocksFile: string): { actionsBytes: number; balanceBytes: number; blocksBytes: number } { return { actionsBytes: 10 * 1024 * 1024, balanceBytes: 10 * 1024 * 1024, blocksBytes: 200 * 1024 * 1024 }; }

async function rotateIfLarge(filePath: string, maxBytes: number, maxFilesKeep: number): Promise<void> {
  try {
    try { await fs.stat(filePath); } catch { await ensureParentDir(filePath); await fs.writeFile(filePath, '', 'utf8'); }
    const stat = await fs.stat(filePath);
    if (stat.size < maxBytes) return;
    const dir = path.dirname(filePath); const base = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(dir, `${base}.${timestamp}`);
    try { await fs.rename(filePath, rotated); } catch { try { const content = await fs.readFile(filePath); await fs.writeFile(rotated, content); await fs.writeFile(filePath, '', 'utf8'); } catch { return; } }
    try { await fs.writeFile(filePath, '', 'utf8'); } catch {}
    try { const entries = await fs.readdir(dir); const rotatedMatches = entries.filter((name) => name.startsWith(`${base}.`)).map((name) => path.join(dir, name)); const withTimes = await Promise.all(rotatedMatches.map(async (p) => ({ p, mtime: (await fs.stat(p)).mtimeMs }))); withTimes.sort((a, b) => b.mtime - a.mtime); const toDelete = withTimes.slice(maxFilesKeep); for (const d of toDelete) { try { await fs.unlink(d.p); } catch {} } } catch {}
  } catch {}
}
