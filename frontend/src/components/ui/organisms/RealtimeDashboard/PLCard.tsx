import React, { useMemo } from 'react';
import type { ActionEvent, BalancePoint } from '../../types';
import StatRow from '../../molecules/StatRow';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './PLCard.module.scss';

type Props = {
  loading: boolean;
  events: ActionEvent[];
  points: BalancePoint[];
};

function formatUsd(v: number): string {
  return '$' + v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function useStartAmountUSD(events: ActionEvent[]): number | null {
  return useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as any;
      if (ev && ev.type === 'start' && typeof ev.amountUSD === 'number') return ev.amountUSD as number;
    }
    return null;
  }, [events]);
}

function useCurrentPositionUSD(events: ActionEvent[], points: BalancePoint[]): number | null {
  return useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as any;
      if (ev && ev.type === 'tick' && typeof ev.positionUSD === 'number') return ev.positionUSD as number;
      if (ev && ev.type === 'summary' && typeof ev.finalPositionUSD === 'number') return ev.finalPositionUSD as number;
    }
    if (points.length > 0) {
      const last = points[points.length - 1];
      if (last && typeof last.v === 'number') return last.v;
    }
    return null;
  }, [events, points]);
}

function useStartTs(events: ActionEvent[]): string | null {
  return useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as any;
      if (ev && ev.type === 'start' && typeof ev.ts === 'string') return ev.ts as string;
    }
    return null;
  }, [events]);
}

function useLatestDataMs(events: ActionEvent[], points: BalancePoint[]): number {
  return useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as any;
      if (ev && (ev.type === 'tick' || ev.type === 'summary') && typeof ev.ts === 'string') {
        const d = new Date(ev.ts);
        if (!isNaN(d.getTime())) return d.getTime();
      }
    }
    if (points.length > 0) {
      const last = points[points.length - 1] as any;
      const raw = (last && (last.ts || last.t)) as string | undefined;
      if (raw) {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) return d.getTime();
      }
    }
    return Date.now();
  }, [events, points]);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days} j ${String(hours).padStart(2, '0')} h`;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

// Removed annualized ROI display as requested

function useDaysToBreakevenFromLastSwitch(events: ActionEvent[], fallbackPositionUSD: number | null): number | null {
  return useMemo(() => {
    // Find last switch event
    let lastSwitchIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as any;
      if (ev && ev.type === 'switch') { lastSwitchIdx = i; break; }
    }
    if (lastSwitchIdx < 0) return null;
    const sw = events[lastSwitchIdx] as any;
    const feesUSD = Number(sw.gasFeeUSD || 0) + Number(sw.swapFeeUSD || 0);
    const basePositionUSD = Number(sw.newPositionUSD || fallbackPositionUSD || 0);
    if (!(feesUSD > 0) || !(basePositionUSD > 0)) return null;
    // Find the preceding tick to read netApyDiffPercent used for the decision
    let netApyDiffPercent: number | null = null;
    for (let j = lastSwitchIdx - 1; j >= 0; j--) {
      const ev = events[j] as any;
      if (ev && ev.type === 'tick') {
        const v = Number(ev.netApyDiffPercent);
        if (isFinite(v)) { netApyDiffPercent = v; break; }
      }
    }
    if (netApyDiffPercent == null || netApyDiffPercent <= 0) return null;
    const dailyRoi = (netApyDiffPercent / 100) / 365;
    if (!(dailyRoi > 0)) return null;
    const days = feesUSD / (basePositionUSD * dailyRoi);
    return isFinite(days) && days > 0 ? days : null;
  }, [events, fallbackPositionUSD]);
}

export default function PLCard({ loading, events, points }: Props): React.JSX.Element {
  const startAmountUSD = useStartAmountUSD(events);
  const currentPositionUSD = useCurrentPositionUSD(events, points);
  const startTs = useStartTs(events);
  const latestDataMs = useLatestDataMs(events, points);
  const daysToBreakeven = useDaysToBreakevenFromLastSwitch(events, currentPositionUSD);

  const pl = useMemo(() => {
    if (startAmountUSD == null || currentPositionUSD == null) return null;
    const plUsd = currentPositionUSD - startAmountUSD;
    const plPct = startAmountUSD > 0 ? (plUsd / startAmountUSD) * 100 : 0;
    return { plUsd, plPct };
  }, [startAmountUSD, currentPositionUSD]);

  const startDateText = useMemo<string | null>(() => {
    if (!startTs) return null;
    const d = new Date(startTs);
    return isNaN(d.getTime()) ? null : d.toLocaleString('fr-FR');
  }, [startTs]);

  const elapsedText = useMemo<string | null>(() => {
    if (!startTs) return null;
    const start = new Date(startTs);
    if (isNaN(start.getTime())) return null;
    return formatDuration(latestDataMs - start.getTime());
  }, [startTs, latestDataMs]);

  return (
    <>
      {loading && <div>Chargement...</div>}
      {!loading && (startAmountUSD == null || currentPositionUSD == null) && <div>Aucune donnée</div>}
      {!loading && startAmountUSD != null && currentPositionUSD != null && pl && (
        <div className={styles.container}>
          <StatRow label={<>Position courante</>} value={formatUsd(currentPositionUSD)} />
          <StatRow label={<>Capital initial</>} value={formatUsd(startAmountUSD)} />
          <StatRow label={<>Début</>} value={startDateText ?? '—'} />
          <StatRow label={<>Temps écoulé</>} value={elapsedText ?? '—'} />
          <StatRow
            label={<>P/L</>}
            value={
              <span className={pl.plUsd >= 0 ? styles.positive : styles.negative}>
                {formatUsd(pl.plUsd)}
                <span className={styles.percent}>{` (${pl.plPct >= 0 ? '+' : ''}${pl.plPct.toFixed(2)}%)`}</span>
              </span>
            }
          />
          <StatRow
            label={<>Jours pour combler le swap</>}
            value={daysToBreakeven != null ? `${daysToBreakeven.toFixed(1)} j` : '—'}
          />
          {(() => {
            for (let i = events.length - 1; i >= 0; i--) {
              const ev = events[i] as any;
              if (ev && (ev.type === 'tick' || ev.type === 'summary')) {
                const cumFees = Number(ev.cumulativeFeesUSD ?? 0) || 0;
                const cumGas = Number(ev.cumulativeGasUSD ?? 0) || 0;
                const cumSwap = Number(ev.cumulativeSwapUSD ?? (cumFees - (Number.isFinite(cumGas) ? cumGas : 0))) || 0;
                const cumYield = Number(ev.cumulativeYieldUSD ?? 0) || 0;
                return (
                  <>
                    <StatRow label={<>Intérêts cumulés</>} value={formatUsd(cumYield)} />
                    <StatRow label={<>Frais gas cumulés</>} value={formatUsd(cumGas)} />
                    <StatRow label={<>Frais swap cumulés</>} value={formatUsd(cumSwap)} />
                    <StatRow label={<>Frais totaux</>} value={formatUsd(cumFees)} />
                  </>
                );
              }
            }
            return null;
          })()}
        </div>
      )}
    </>
  );
}


