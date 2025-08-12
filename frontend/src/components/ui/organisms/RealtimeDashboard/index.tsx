import React, { useEffect, useMemo, useState } from 'react';
import BalanceChart from './BalanceChart';
import PLCard from './PLCard';
import MarketsTable from './MarketsTable';
import ActionsLog from './ActionsLog';
import Card from '../../molecules/Card';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './RealtimeDashboard.module.scss';
import type { ActionEvent, BalancePoint } from '../../types';

export default function RealtimeDashboard(): React.JSX.Element {
  const [points, setPoints] = useState<BalancePoint[]>([]);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [markets, setMarkets] = useState<any[]>([]);
  const [marketsTs, setMarketsTs] = useState<string | null>(null);

  // State updates are enough; chart component handles its own labels

  useEffect(() => {
    let pollingTimer: number | undefined;
    function startPollingFallback(): void {
      async function refreshOnce(): Promise<void> {
        try {
          const [balRes, actsRes] = await Promise.all([
            fetch('/api/balance').then((r) => r.json()),
            fetch('/api/actions').then((r) => r.json()),
          ]);
          setPoints(Array.isArray(balRes.points) ? balRes.points : []);
          setEvents(Array.isArray(actsRes.events) ? actsRes.events : []);
          setLoading(false);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err);
        }
      }
      void refreshOnce();
      pollingTimer = window.setInterval(refreshOnce, 5000);
    }

    try {
      const actsSrc = new EventSource('/api/actions/stream');
      actsSrc.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data || '{}');
          if (Array.isArray(payload.events)) {
            setEvents(payload.events);
          }
          setLoading(false);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err);
        }
      };
      actsSrc.onerror = () => {
        actsSrc.close();
        startPollingFallback();
      };

      const balSrc = new EventSource('/api/balance/stream');
      balSrc.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data || '{}');
          if (Array.isArray(payload.points)) {
            setPoints(payload.points);
          }
          setLoading(false);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err);
        }
      };
      balSrc.onerror = () => {
        balSrc.close();
        startPollingFallback();
      };

      const mktSrc = new EventSource('/api/markets/stream');
      mktSrc.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data || '{}');
          if (Array.isArray(payload.markets)) {
            setMarkets(payload.markets);
            // Support both legacy `ts` and newer `timestamp` keys
            setMarketsTs((payload.ts as string | undefined) || (payload.timestamp as string | undefined) || null);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err);
        }
      };
      mktSrc.onerror = () => {
        mktSrc.close();
      };

      return () => {
        actsSrc.close();
        balSrc.close();
        mktSrc.close();
        if (pollingTimer) window.clearInterval(pollingTimer);
      };
    } catch {
      startPollingFallback();
    }
  }, []);

  // Memoized labels retained for potential future enhancements

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.title}>Venus Switch Bot - Dry Run</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={async () => {
            try {
              setResetting(true);
              const res = await fetch('/api/reset');
              if (!res.ok) throw new Error('Reset failed');
              // Clear local state immediately for UX
              setPoints([]);
              setEvents([]);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error(e);
            } finally {
              setResetting(false);
            }
          }}
          disabled={resetting}
        >
          {resetting ? 'Réinitialisation…' : 'Réinitialiser la simulation'}
        </button>
      </div>
      <div className={styles.grid}>
        <Card title="Balance">
          <BalanceChart points={points} className={styles.chart} />
        </Card>
        <Card title="P/L actuel">
          <PLCard loading={loading} events={events} points={points} />
        </Card>
        <Card title="Actions">
          <ActionsLog loading={loading} events={events} />
        </Card>
      </div>
      {/* Pools tables at the very bottom */}
      <Card title="Pools — Supply (APY)">
        <MarketsTable markets={markets as any[]} lastUpdateTs={marketsTs ?? undefined} mode="supply" />
      </Card>
      <Card title="Pools — Borrow (APY)">
        <MarketsTable markets={markets as any[]} lastUpdateTs={marketsTs ?? undefined} mode="borrow" />
      </Card>
    </div>
  );
}
