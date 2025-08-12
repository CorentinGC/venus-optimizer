import React from 'react';
import type { ActionEvent } from '../../types';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './ActionsLog.module.scss';

type Props = {
  loading: boolean;
  events: ActionEvent[];
};

export default function ActionsLog({ loading, events }: Props): React.JSX.Element {
  return (
    <pre className={styles.logArea}>
      {loading && 'Chargement...'}
      {!loading && events.length === 0 && 'Aucune donnée'}
      {!loading && events.length > 0 && formatEvents(events).join('\n')}
    </pre>
  );
}

function formatEvents(events: ActionEvent[]): string[] {
  return events.slice(-300).reverse().map((ev) => fmtEvent(ev));
}

function fmtEvent(ev: ActionEvent): string {
  const t = (ev as any).ts ?? (ev as any).t;
  const d = new Date(t || Date.now());
  const ts = isNaN(d.getTime()) ? '' : '[' + d.toLocaleString('fr-FR') + '] ';
  if ('type' in ev) {
    if (ev.type === 'switch') {
      return (
        ts +
        `SWITCH → ${ev.toAsset} | -gas=$${Number(ev.gasFeeUSD || 0).toFixed(2)} -swap=$${Number(ev.swapFeeUSD || 0).toFixed(2)} | new=$${Number(ev.newPositionUSD || 0).toFixed(2)}`
      );
    }
    if (ev.type === 'tick') {
      return (
        ts +
        `tick ${ev.currentAsset} ${Number(ev.currentApyPercent ?? 0).toFixed(2)}% → best ${ev.bestAsset} ${
          Number(ev.bestApyPercent ?? 0).toFixed(2)
        }% | pos=$${Number(ev.positionUSD ?? 0).toFixed(2)} | netΔ=${
          Number(ev.netApyDiffPercent ?? 0).toFixed(3)
        }%`
      );
    }
    if (ev.type === 'error') {
      return ts + `error: ${ev.message}`;
    }
    if (ev.type === 'summary') {
      return (
        ts +
        `summary: final=$${Number(ev.finalPositionUSD ?? 0).toFixed(2)} yield=$${
          Number(ev.cumulativeYieldUSD ?? 0).toFixed(2)
        } fees=$${Number(ev.cumulativeFeesUSD ?? 0).toFixed(2)} switches=${Number((ev as any).switches ?? 0)}`
      );
    }
    if (ev.type === 'start') {
      return (
        ts +
        `start: $${Number((ev as any).amountUSD ?? 0).toLocaleString()} ${(ev as any).baseAssetSymbol} interval=${(ev as any).pollIntervalSec}s ticks=${(ev as any).ticks} thresholdBps=${(ev as any).thresholdBps}`
      );
    }
  }
  return ts + JSON.stringify(ev);
}


