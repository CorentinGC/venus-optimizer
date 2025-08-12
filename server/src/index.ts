#!/usr/bin/env node
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load additional .env files when running via npm workspaces
try {
  dotenvConfig(); // server/.env if present
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Try server/.env relative to dist
  dotenvConfig({ path: path.resolve(__dirname, '../.env') });
  // Try repo root .env (../../ from dist)
  dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
} catch {}
import { Command } from 'commander';
import { printBestCorePool, estimateSwitchProfitability } from '@modules/logic.js';
import { simulateSwapCostNow, quotePancakeBest, fetchGasPriceNow, computeUsdValueOnPancake, estimateSwapGasLimitByHops } from '@services/swap.js';
import { ethers } from 'ethers';
import { fetchSymbolPricesUSD } from '@services/venusApi.js';
import { runDryRunSimulation } from '@modules/simulator.js';
import { runBorrowInterestScan, runBorrowInterestMonitor } from '@modules/borrowMonitor.js';
import { cleanRawJsonData } from '@modules/dataCleaner.js';
import { runPoolsSnapshot } from '@modules/poolsSnapshot.js';

const program = new Command();
program
  .name('venus-switch-bot')
  .description('CLI pour optimiser les dépôts sur les core pools Venus (BNB Chain)')
  .version('0.1.0');

program
  .command('check')
  .description('Liste les meilleurs APY (core pools) et la meilleure cible')
  .action(async () => {
    try {
      await printBestCorePool();
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command('dry-run')
  .description("Estime la rentabilité d'un switch sans exécution de transaction")
  .requiredOption('--amount <amount>', 'Montant nominal (ex: 1000)')
  .requiredOption('--asset <symbol>', "Symbole de l'actif (ex: USDT, BUSD, USDC, BTCB ...)")
  .action(async (opts) => {
    try {
      const amount = Number(opts.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Montant invalide');
      }
      const res = await estimateSwitchProfitability({ amount, assetSymbol: String(opts.asset).toUpperCase() });
      console.log(JSON.stringify(res, null, 2));
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command('simulate')
  .description('Simulation H24 dry-run: bascule si rentable (aucune transaction réelle)')
  .option('--amount <amount>', 'Montant nominal USD (default: 100000)', '100000')
  .option('--asset <symbol>', "Symbole de l'actif de départ (default: USDC)", 'USDC')
  .option('--interval <sec>', 'Intervalle de polling en secondes (default: 60)', '60')
  .option('--hours <n>', 'Durée en heures (default: 24). Utilisez 0 ou valeur négative pour un mode continu', '24')
  .option('--continuous', 'Mode continu: boucle infinie jusqu\'à arrêt manuel')
  .option('--live-quote', 'Utiliser un vrai quote Pancake v2 pour estimer les frais et la route de swap (par défaut: activé si API key Etherscan disponible)')
  .option('--log-actions <path>', 'Fichier NDJSON des actions (default: logs/actions.ndjson)')
  .option('--log-balance <path>', 'Fichier NDJSON de l\'évolution du solde (default: logs/balance.ndjson)')
  .option('--log-blocks <path>', 'Fichier NDJSON des gains par bloc (default: logs/per-block.ndjson)')
  .action(async (opts) => {
    try {
      const amount = Number(opts.amount);
      const interval = Number(opts.interval);
      const hours = Number(opts.hours);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide');
      if (!Number.isFinite(interval) || interval <= 0) throw new Error('Interval invalide');
      if (!Number.isFinite(hours)) throw new Error('Heures invalides');
      await runDryRunSimulation({
        amountUSD: amount,
        baseAssetSymbol: String(opts.asset).toUpperCase(),
        pollIntervalSec: interval,
        hours,
        continuous: Boolean(opts.continuous) || (Number.isFinite(hours) && hours <= 0),
        minNetDiffBps: Number(process.env.MIN_NET_APY_DIFF_BPS ?? 0),
        useLiveSwapQuote: typeof opts.liveQuote === 'boolean' ? opts.liveQuote : undefined,
        logActionsPath: opts.logActions,
        logBalancePath: opts.logBalance,
        logPerBlockPath: opts.logBlocks,
      });
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command('quote-swap')
  .description('Quote PancakeSwap (v2/v3) on-chain (BSC) — meilleur prix + coût gas; sans clé API')
  .requiredOption('--from <symbol>', 'Symbole token source (ex: USDT)')
  .requiredOption('--to <symbol>', 'Symbole token destination (ex: BTC, BTCB, BUSD)')
  .requiredOption('--amount <units>', 'Montant en unités humaines du token source (ex: 1000)')
  .option('--slippage <percent>', 'Tolérance de slippage (%) pour amountOutMin', '0')
  .action(async (opts) => {
    try {
      const amount = Number(opts.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide');
      const from = String(opts.from).toUpperCase();
      const to = String(opts.to).toUpperCase() === 'BTC' ? 'BTCB' : String(opts.to).toUpperCase();
      const quote = await quotePancakeBest({ fromSymbol: from, toSymbol: to, amountInUnits: amount, allowMultiHop: true });
      const gasNow = await fetchGasPriceNow();
      // gasLimit approx based on hops
      const hops = (() => {
        if (quote.path?.length) return Math.max(1, quote.path.length - 1);
        if (quote.v3FeesBpsPerHop?.length) return quote.v3FeesBpsPerHop.length;
        return 1;
      })();
      const gasLimit = estimateSwapGasLimitByHops(hops + 1);
      const txCostBNB = (gasNow.gasPriceGwei * gasLimit) / 1e9;
      const prices = await fetchSymbolPricesUSD();
      const bnbPriceUSD = prices['BNB'];
      const txCostUSD = bnbPriceUSD && bnbPriceUSD > 0 ? txCostBNB * bnbPriceUSD : undefined;
      const valueInUSD = await computeUsdValueOnPancake(quote.from.symbol, Number(quote.amountIn));
      const valueOutUSD = await computeUsdValueOnPancake(quote.to.symbol, Number(quote.amountOut));
      const slip = Number(opts.slippage ?? 0);
      let amountOutMin: string | undefined;
      if (Number.isFinite(slip) && slip > 0) {
        const outRaw = BigInt(quote.amountOutRaw);
        const denom = 1_000_000n;
        const factor = denom - BigInt(Math.floor((slip / 100) * Number(denom)));
        const minRaw = (outRaw * factor) / denom;
        amountOutMin = ethers.formatUnits(minRaw, quote.to.decimals ?? 18);
      }
      const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
      console.log(JSON.stringify({
        ok: true,
        from: quote.from.symbol,
        to: quote.to.symbol,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        amountOutMin,
        valueInUSD,
        valueOutUSD,
        provider: quote.provider,
        gas: { source: gasNow.source, gasPriceGwei: gasNow.gasPriceGwei, gasLimit, txCostBNB, txCostUSD },
        tradingFeeBpsApprox: quote.tradingFeeBpsApprox ?? (quote.v3FeesBpsPerHop ? quote.v3FeesBpsPerHop.reduce((a, b) => a + b, 0) : undefined),
        pathSymbols: quote.pathSymbols,
      }, replacer, 2));
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

// Borrow scan CLI
program
  .command('borrow-scan')
  .description("Analyse les intérêts d'emprunt pour une adresse Venus et projection")
  .requiredOption('--account <address>', 'Adresse publique BSC (0x...)')
  .option('--days <n>', 'Fenêtre historique en jours (default: 365)')
  .option('--from-block <n>', 'Bloc de départ (prioritaire sur --days)')
  .option('--projection-hours <n>', 'Projection en heures (default: 12)')
  .option('--log <path>', 'Fichier NDJSON de sortie (default: logs/borrow.ndjson)')
  .option('--repeat', 'Boucle infinie (intervalle défini par SERVER_BORROW_INTERVAL_HOURS ou 12h)')
  .action(async (opts) => {
    try {
      const account = String(opts.account);
      if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error('Adresse invalide');
      const days = opts.days ? Number(opts.days) : undefined;
      const fromBlock = opts.fromBlock ? Number(opts.fromBlock) : undefined;
      const projectionHours = opts.projectionHours ? Number(opts.projectionHours) : undefined;
      const log = opts.log ? String(opts.log) : undefined;
      if (opts.repeat) {
        await runBorrowInterestMonitor({ accountAddress: account, daysLookback: days, fromBlock, projectionHours, logPath: log });
      } else {
        const res = await runBorrowInterestScan({ accountAddress: account, daysLookback: days, fromBlock, projectionHours, logPath: log });
        const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
        console.log(JSON.stringify(res, replacer, 2));
      }
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

// APY history CLI
// Removed: apy-history per request

// Data cleaning CLI
program
  .command('clean-data')
  .description('Nettoie les JSON bruts dans data/raw et écrit les fichiers nettoyés dans data/')
  .action(async () => {
    try {
      const { processed, outputDir } = await cleanRawJsonData();
      console.log(JSON.stringify({ ok: true, processed, outputDir }, null, 2));
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

// Daily collector CLI
// Removed: collect-apy per request

program
  .command('pools-snapshot')
  .description('Récupère les pools Venus actives (RPC) et écrit un snapshot JSON dans data/pools.json')
  .option('--out <path>', 'Chemin de sortie JSON (défaut: data/pools.json)')
  .action(async (opts) => {
    try {
      const out = opts.out ? String(opts.out) : undefined;
      const res = await runPoolsSnapshot({ outPath: out });
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    } catch (error) {
      console.error('Erreur:', (error as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);



