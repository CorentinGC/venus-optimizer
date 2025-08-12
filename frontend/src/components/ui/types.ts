export type BalancePoint = { t?: string; ts?: string; v: number };

export type ActionEvent =
  | {
      type: 'start';
      ts: string;
      amountUSD: number;
      baseAssetSymbol: string;
      pollIntervalSec: number;
      ticks: number;
      thresholdBps: number;
    }
  | {
      type: 'tick';
      ts: string;
      currentAsset: string;
      currentApyPercent: number;
      ratePerBlock: number;
      bestAsset: string;
      bestApyPercent: number;
      positionUSD: number;
      blocksElapsed: number;
      netApyDiffPercent: number;
      profitable: boolean;
      gasFeeUSD?: number;
      swapFeeUSD?: number;
      cumulativeFeesUSD?: number;
      cumulativeGasUSD?: number;
      cumulativeSwapUSD?: number;
      cumulativeYieldUSD?: number;
    }
  | { type: 'switch'; ts: string; toAsset: string; gasFeeUSD: number; swapFeeUSD: number; newPositionUSD: number }
  | { type: 'error'; ts: string; message: string }
  | {
      type: 'summary';
      ts: string;
      durationHours: number;
      finalPositionUSD: number;
      cumulativeYieldUSD: number;
      cumulativeFeesUSD: number;
      cumulativeGasUSD?: number;
      cumulativeSwapUSD?: number;
      switches: number;
    }
  | Record<string, unknown>;


