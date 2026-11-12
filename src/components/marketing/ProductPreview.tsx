import styles from './ProductPreview.module.css';

const HEAD = ['Charge code', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Total'];
const ROWS = [
  ['NAVAIR-0001', '8.00', '6.00', '8.00', '8.00', '7.50', '37.50'],
  ['Leave · Annual', '', '2.00', '', '', '0.50', '2.50'],
];

/**
 * The landing page's product preview (feature-plan-ux-integrations-billing.md L2): a static HTML/CSS picture of a
 * timesheet, one image to assistive technology (role="img" with a label), in place of the old Tech stack panel.
 */
export function ProductPreview() {
  return (
    <div className={styles.shot} role="img" aria-label="Product preview: a timesheet in CadenzPoint">
      <div className={styles.top}>
        <span>My timesheet · Oct 16 – 31</span>
        <span className={styles.pill}>Draft</span>
      </div>
      <div className={styles.grid}>
        {HEAD.map((h) => <span key={h} className={styles.head}>{h}</span>)}
        {ROWS.flatMap((row) => row.map((cell, i) => (
          <span key={`${row[0]}-${i}`} className={i === row.length - 1 ? styles.total : undefined}>{cell}</span>
        )))}
      </div>
    </div>
  );
}
