import React from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './StatRow.module.scss';

type Props = {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
};

export default function StatRow({ label, value, className }: Props): React.JSX.Element {
  return (
    <div className={[styles.row, className].filter(Boolean).join(' ')}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}


