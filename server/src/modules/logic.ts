import { fetchCoreMarketsSortedBySupplyAPY, fetchSymbolPricesUSD } from '@services/venusApi.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import Table from 'cli-table3';
import { estimateGasFeesInBaseAsset } from '@services/gas.js';
import { estimateSwapFeesBps } from '@services/swap.js';

/**
 * Affiche les meilleures core pools triées par APY (supply)
 */
export async function printBestCorePool(): Promise<void> {
  const markets = await fetchCoreMarketsSortedBySupplyAPY();
  // Merge local snapshot historical averages if available
  try {
    const cwd = process.cwd();
    const dir = process.env.SERVER_NEW_DATA_DIR || path.join(cwd, '..', 'data');
    const marketsJson = path.resolve(dir, 'markets.json');
    const raw = await fsp.readFile(marketsJson, 'utf8');
    const snap = JSON.parse(raw);
    const byVToken: Record<string, any> = {};
    for (const m of snap?.markets ?? []) {
      if (m?.vTokenAddress) byVToken[String(m.vTokenAddress).toLowerCase()] = m;
    }
    for (const m of markets as any[]) {
      const k = String(m.vTokenAddress || '').toLowerCase();
      const s = byVToken[k];
      if (s) {
        m.avgSupplyApy1m = s.avgSupplyApy1m;
        m.avgSupplyApy3m = s.avgSupplyApy3m;
        m.avgSupplyApy6m = s.avgSupplyApy6m;
        m.avgSupplyApy1y = s.avgSupplyApy1y;
      }
    }
  } catch {}
  if (markets.length === 0) {
    console.log('Aucune core pool trouvée.');
    return;
  }
  const best = markets[0];

  const table = new Table({
    head: ['Asset', 'vToken', 'Supply APY %', 'Borrow APY %', 'Avg 1m %', 'Avg 3m %', 'Avg 6m %', 'Avg 1y %', 'Total Supply', 'Total Borrows'],
    colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    style: { head: [], border: [] },
  });
  for (const m of markets) {
    table.push([
      m.assetSymbol,
      m.vTokenSymbol,
      m.supplyApyPercent.toFixed(2),
      m.borrowApyPercent.toFixed(2),
      typeof (m as any).avgSupplyApy1m === 'number' ? (m as any).avgSupplyApy1m!.toFixed(2) : '-',
      typeof (m as any).avgSupplyApy3m === 'number' ? (m as any).avgSupplyApy3m!.toFixed(2) : '-',
      typeof (m as any).avgSupplyApy6m === 'number' ? (m as any).avgSupplyApy6m!.toFixed(2) : '-',
      typeof (m as any).avgSupplyApy1y === 'number' ? (m as any).avgSupplyApy1y!.toFixed(2) : '-',
      m.totalSupplyUnderlying.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      m.totalBorrowsUnderlying.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    ]);
  }

  console.log(String(table));
  console.log(`Meilleure cible: ${best.assetSymbol} (${best.vTokenSymbol}) supply APY ${best.supplyApyPercent.toFixed(2)}%`);
}

/**
 * Estime la rentabilité d'un switch pour un montant nominal (supposé USD) entre l'actif courant et la meilleure core pool.
 */
export async function estimateSwitchProfitability(params: { amount: number; assetSymbol: string }) {
  const { amount, assetSymbol } = params;
  const markets = await fetchCoreMarketsSortedBySupplyAPY();
  // Merge snapshot averages for decision/reporting
  try {
    const cwd = process.cwd();
    const dir = process.env.SERVER_NEW_DATA_DIR || path.join(cwd, '..', 'data');
    const marketsJson = path.resolve(dir, 'markets.json');
    const raw = await fsp.readFile(marketsJson, 'utf8');
    const snap = JSON.parse(raw);
    const byAsset: Record<string, any> = {};
    for (const m of snap?.markets ?? []) {
      if (m?.assetSymbol) byAsset[String(m.assetSymbol).toUpperCase()] = m;
    }
    for (const m of markets as any[]) {
      const s = byAsset[String(m.assetSymbol || '').toUpperCase()];
      if (s) {
        m.avgSupplyApy1m = s.avgSupplyApy1m;
        m.avgSupplyApy3m = s.avgSupplyApy3m;
        m.avgSupplyApy6m = s.avgSupplyApy6m;
        m.avgSupplyApy1y = s.avgSupplyApy1y;
      }
    }
  } catch {}
  if (markets.length === 0) {
    throw new Error('Aucun marché core disponible');
  }

  const best = markets[0];
  const current = (markets as any[]).find((m) => m.assetSymbol === assetSymbol) ?? markets[Math.floor(markets.length / 2)];
  const apyDiffPercent = best.supplyApyPercent - current.supplyApyPercent;

  const prices = await fetchSymbolPricesUSD();
  const bnbPrice = prices['BNB'] ?? null;

  const gasFeeBNB = await estimateGasFeesInBaseAsset();
  const gasFeeUSD = bnbPrice ? gasFeeBNB * bnbPrice : null;

  const swapFeeBps = await estimateSwapFeesBps(assetSymbol, best.assetSymbol);

  // Conversion gas en % du nominal si prix dispo et on suppose amount exprimé en USD
  const gasPercent = gasFeeUSD ? (gasFeeUSD / amount) * 100 : 0;
  const netApyDiffPercent = apyDiffPercent - swapFeeBps / 100 - gasPercent;

  return {
    from: { assetSymbol: current.assetSymbol, apy: current.supplyApyPercent },
    to: { assetSymbol: best.assetSymbol, apy: best.supplyApyPercent },
    apyDiffPercent,
    swapFeeBps,
    gasFeeBNB,
    gasFeeUSD,
    netApyDiffPercent,
    profitable: netApyDiffPercent > Number(process.env.MIN_NET_APY_DIFF_BPS ?? 0) / 100,
  };
}

// no re-exports


