import React, { useMemo, useState } from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './MarketsTable.module.scss';

type MarketRow = {
  vTokenAddress?: string;
  vTokenSymbol?: string;
  assetSymbol: string;
  supplyApyPercent?: number;
  borrowApyPercent?: number;
  avgSupplyApy1m?: number | null;
  avgSupplyApy3m?: number | null;
  avgSupplyApy6m?: number | null;
  avgSupplyApy1y?: number | null;
  avgBorrowApy1m?: number | null;
  avgBorrowApy3m?: number | null;
  avgBorrowApy6m?: number | null;
  avgBorrowApy1y?: number | null;
};

type Props = {
  markets: MarketRow[];
  lastUpdateTs?: string | null;
  mode?: 'supply' | 'borrow';
};

/**
 * MarketsTable
 *
 * Affiche la liste des pools (markets) avec APY courant et moyennes 1m/3m/6m/1y.
 * - Tri tri-état par colonne: non trié → ascendant → descendant (cycle au clic).
 */
export default function MarketsTable({ markets, lastUpdateTs, mode = 'supply' }: Props): React.JSX.Element {
  type SortKey = 'assetSymbol' | 'supplyApyPercent' | 'borrowApyPercent' | 'avgSupplyApy1m' | 'avgSupplyApy3m' | 'avgSupplyApy6m' | 'avgSupplyApy1y' | 'avgBorrowApy1m' | 'avgBorrowApy3m' | 'avgBorrowApy6m' | 'avgBorrowApy1y' | null;
  type SortDir = 'asc' | 'desc' | null;
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  function cycleSort(nextKey: Exclude<SortKey, null>): void {
    if (sortKey !== nextKey) {
      setSortKey(nextKey);
      setSortDir('asc');
    } else {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') {
        setSortKey(null);
        setSortDir(null);
      } else setSortDir('asc');
    }
  }

  const sorted = useMemo(() => {
    if (!Array.isArray(markets) || markets.length === 0) return [];
    if (!sortKey || !sortDir) return markets.slice();
    const arr = markets.slice();
    arr.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'assetSymbol') {
        const av = String(a.assetSymbol || '').toUpperCase();
        const bv = String(b.assetSymbol || '').toUpperCase();
        return av.localeCompare(bv) * dir;
      }
      const avRaw = (a as any)[sortKey];
      const bvRaw = (b as any)[sortKey];
      const aValid = typeof avRaw === 'number' && Number.isFinite(avRaw);
      const bValid = typeof bvRaw === 'number' && Number.isFinite(bvRaw);
      if (aValid && !bValid) return -1; // always push invalid to bottom
      if (!aValid && bValid) return 1;
      if (!aValid && !bValid) return 0;
      const av = avRaw as number;
      const bv = bvRaw as number;
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    });
    return arr;
  }, [markets, sortKey, sortDir]);

  function SortableHeader({ label, k }: { label: string; k: Exclude<SortKey, null> }): React.JSX.Element {
    const active = sortKey === k;
    const icon = !active ? '↕' : sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '↕';
    return (
      <button type="button" className={styles.sortableTh} onClick={() => cycleSort(k)} aria-label={`Trier par ${label}`}>
        <span className={styles.thLabel}>{label}</span> <span className={styles.sortIcon}>{icon}</span>
      </button>
    );
  }

  return (
    <>
      {markets.length === 0 && <div>Aucune donnée</div>}
      {markets.length > 0 && (
        <table className={styles.marketsTable}>
          <thead>
            <tr>
              <th><SortableHeader label="Actif" k="assetSymbol" /></th>
              {mode === 'supply' ? (
                <>
                  <th className={styles.apyCell}><SortableHeader label="APY Supply" k="supplyApyPercent" /></th>
                  <th className={styles.apyCell}><SortableHeader label="1m" k="avgSupplyApy1m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="3m" k="avgSupplyApy3m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="6m" k="avgSupplyApy6m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="1y" k="avgSupplyApy1y" /></th>
                </>
              ) : (
                <>
                  <th className={styles.apyCell}><SortableHeader label="APY Borrow" k="borrowApyPercent" /></th>
                  <th className={styles.apyCell}><SortableHeader label="1m" k="avgBorrowApy1m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="3m" k="avgBorrowApy3m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="6m" k="avgBorrowApy6m" /></th>
                  <th className={styles.apyCell}><SortableHeader label="1y" k="avgBorrowApy1y" /></th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.vTokenAddress || m.vTokenSymbol || m.assetSymbol}>
                <td>{m.assetSymbol}</td>
                {mode === 'supply' ? (
                  <>
                    <td className={`${styles.apyCell} ${styles.apyStrong}`}>{Number(m.supplyApyPercent ?? 0).toFixed(2)}%</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgSupplyApy1m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgSupplyApy3m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgSupplyApy6m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgSupplyApy1y)}</td>
                  </>
                ) : (
                  <>
                    <td className={`${styles.apyCell} ${styles.apyStrong}`}>{Number(m.borrowApyPercent ?? 0).toFixed(2)}%</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgBorrowApy1m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgBorrowApy3m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgBorrowApy6m)}</td>
                    <td className={styles.apyCell}>{formatAvg(m.avgBorrowApy1y)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lastUpdateTs && (
        <div style={{ marginTop: 8, color: '#666' }}>Dernière mise à jour: {new Date(lastUpdateTs).toLocaleString('fr-FR')}</div>
      )}
    </>
  );
}

function formatAvg(v?: number | null): string {
  return v != null && Number.isFinite(v) ? `${Number(v).toFixed(1)}%` : '-';
}


