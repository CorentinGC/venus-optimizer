import React, { useEffect, useMemo, useRef } from 'react';
import Chart from 'chart.js/auto';
import type { BalancePoint } from '../../types';

type Props = {
  points: BalancePoint[];
  className?: string;
};

export default function BalanceChart({ points, className }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  const labels = useMemo(() => points.map((p) => new Date((p.t ?? p.ts) ?? '').toLocaleString('fr-FR')), [points]);
  const values = useMemo(() => points.map((p) => p.v), [points]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Position USD',
            data: values,
            borderColor: '#3A78FF',
            fill: false,
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        scales: { x: { ticks: { maxTicksLimit: 8 } } },
      },
    });
    chartRef.current = chart;
    return () => chart.destroy();
  }, [labels, values]);

  return <canvas ref={canvasRef} className={className} />;
}


