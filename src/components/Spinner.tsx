/** Decorative activity indicator; pair it with visible text or aria-busy. */
export function Spinner({ size = 'small' }: { size?: 'small' | 'medium' }) {
  return <span className={`rp-spinner rp-spinner--${size}`} aria-hidden='true' />;
}
