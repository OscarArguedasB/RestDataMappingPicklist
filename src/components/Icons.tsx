// Small inline icons (16×16) so the control needs no icon font.
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

export function ChevronDownIcon() {
  return (
    <svg {...svgProps}>
      <path d='M4 6.25 8 10.25l4-4' {...strokeProps} />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...svgProps}>
      <path d='M3.5 8.5 6.5 11.5 12.5 4.75' {...strokeProps} />
    </svg>
  );
}

export function ClearIcon() {
  return (
    <svg {...svgProps}>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm2.53 3.97a.75.75 0 0 1 0 1.06L9.06 8l1.47 1.47a.75.75 0 1 1-1.06 1.06L8 9.06l-1.47 1.47a.75.75 0 0 1-1.06-1.06L6.94 8 5.47 6.53a.75.75 0 0 1 1.06-1.06L8 6.94l1.47-1.47a.75.75 0 0 1 1.06 0Z'
      />
    </svg>
  );
}

/** A plain “×”, for removing one chip (ClearIcon, in a circle, clears the whole field). */
export function DismissIcon() {
  return (
    <svg {...svgProps}>
      <path d='m4.5 4.5 7 7m0-7-7 7' {...strokeProps} />
    </svg>
  );
}

/**
 * A triangle with “!”, for warnings. Errors use AlertIcon (a circle), so the two never differ by
 * color alone.
 */
export function WarningIcon() {
  return (
    <svg {...svgProps}>
      <path
        d='M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5l5.5-9.75Z'
        {...strokeProps}
      />
      <path d='M8 6.25V9' {...strokeProps} />
      <circle cx='8' cy='11.25' r='0.85' fill='currentColor' />
    </svg>
  );
}

/** A circle with “!”, for errors. */
export function AlertIcon() {
  return (
    <svg {...svgProps}>
      <circle cx='8' cy='8' r='6.25' stroke='currentColor' strokeWidth='1.5' />
      <path d='M8 4.75v3.75' {...strokeProps} />
      <circle cx='8' cy='11' r='0.9' fill='currentColor' />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...svgProps}>
      <rect x='5.25' y='5.25' width='8' height='8' rx='1.75' {...strokeProps} />
      <path
        d='M10.75 3.5A1.75 1.75 0 0 0 9 2.75H4.5A1.75 1.75 0 0 0 2.75 4.5V9A1.75 1.75 0 0 0 3.5 10.75'
        {...strokeProps}
      />
    </svg>
  );
}

/** An “i” in a circle, for notes that only inform. */
export function InfoIcon() {
  return (
    <svg {...svgProps}>
      <circle cx='8' cy='8' r='6.25' stroke='currentColor' strokeWidth='1.5' />
      <path d='M8 7.25v3.75' {...strokeProps} />
      <circle cx='8' cy='5' r='0.9' fill='currentColor' />
    </svg>
  );
}

export function SuccessIcon() {
  return (
    <svg {...svgProps}>
      <circle cx='8' cy='8' r='6.25' stroke='currentColor' strokeWidth='1.5' />
      <path d='M5.25 8.25 7.1 10.1l3.65-4' {...strokeProps} />
    </svg>
  );
}
