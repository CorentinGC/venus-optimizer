import React from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - SCSS modules types are implicit for simplicity in this project
import styles from './Card.module.scss';

type Props = {
  title?: string;
  children?: React.ReactNode;
  className?: string;
};

export default function Card({ title, children, className }: Props): React.JSX.Element {
  return (
    <div className={[styles.card, className].filter(Boolean).join(' ')}>
      {title && <h3 className={styles.title}>{title}</h3>}
      {children}
    </div>
  );
}


