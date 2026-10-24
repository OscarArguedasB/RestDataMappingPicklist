// Icons used only on the setup page, drawn like components/Icons.tsx (16×16, current color).
const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  'aria-hidden': true,
  focusable: false,
  className: 'rp-icon',
} as const;

const strokeProps = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function ChevronLeftIcon() {
  return (
    <svg {...svgProps}>
      <path d='M9.75 4 5.75 8l4 4' {...strokeProps} />
    </svg>
  );
}

/** A triangle with “!”: shared with the control, so it lives in components/Icons.tsx. */
export { WarningIcon } from '../components/Icons';

export function LockIcon() {
  return (
    <svg {...svgProps}>
      <rect x='3.25' y='7' width='9.5' height='6.5' rx='1.5' {...strokeProps} />
      <path d='M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7' {...strokeProps} />
    </svg>
  );
}
