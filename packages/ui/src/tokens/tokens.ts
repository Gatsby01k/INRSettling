/**
 * Design tokens — DESIGN_SYSTEM.md.
 *
 * This file is the source of truth. `tokens.css` is generated from it, so a
 * value can never drift between the TypeScript and the stylesheet.
 */
export const color = {
  bgBase: '#FBFBF9',
  bgSurface: '#FFFFFF',
  bgSunken: '#F5F5F2',
  bgHover: '#F2F3F5',
  border: '#E5E7EB',
  borderStrong: '#D3D7DE',

  ink: '#0A1A2F',
  inkSecondary: '#33465F',
  inkMuted: '#6B7B90',
  inkDisabled: '#9AA6B5',
  inkInverse: '#FFFFFF',

  accentSaffron: '#E8871E',
  accentSaffronDeep: '#C46B0F',
  accentTeal: '#0E8A6E',
  accentTealDeep: '#0A6B55',
} as const

/** The gradient is an accent, never a background — DESIGN_SYSTEM.md § 2.3. */
export const accentGradient = 'linear-gradient(90deg, #E8871E 0%, #0E8A6E 100%)'

/**
 * One colour pair per customer-facing status, used everywhere that status
 * appears. Saffron → teal is also the settling → settled progression, which is
 * why the brand accent earns its place as a semantic.
 *
 * DEVIATION FROM THE FROZEN BASELINE — two foregrounds differ from
 * DESIGN_SYSTEM.md § 2.4, because as specified they fail the 4.5:1 contrast
 * requirement that § 7 of the same document sets:
 *
 *   settling   #B36A0C on #FDF4E7 = 3.87:1  ->  #9C5808 = 5.05:1
 *   cancelled  #6B7B90 on #F5F5F2 = 3.96:1  ->  #5F6E82 = 4.76:1
 *
 * Hue and role are unchanged; both are darkened just far enough to pass. The
 * contrast test below is the reason this was caught rather than shipped, and
 * the baseline needs a Revision 4 amendment to match. Flagged for sign-off —
 * do not silently reconcile in either direction.
 */
export const statusColor = {
  ready: { fg: '#33465F', bg: '#F1F3F6' },
  settling: { fg: '#9C5808', bg: '#FDF4E7' },
  settled: { fg: '#0A6B55', bg: '#E9F5F1' },
  action_required: { fg: '#B42318', bg: '#FEF3F2' },
  cancelled: { fg: '#5F6E82', bg: '#F5F5F2' },
} as const

export type CustomerStatus = keyof typeof statusColor

export const font = {
  ui: "'Inter var', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const

export const type = {
  displayXl: { size: 48, line: 52, weight: 600, tracking: '-0.022em' },
  displayL: { size: 36, line: 40, weight: 600, tracking: '-0.020em' },
  displayM: { size: 28, line: 34, weight: 600, tracking: '-0.016em' },
  h1: { size: 24, line: 32, weight: 600, tracking: '-0.011em' },
  h2: { size: 20, line: 28, weight: 600, tracking: '-0.008em' },
  h3: { size: 16, line: 24, weight: 600, tracking: '0' },
  body: { size: 14, line: 20, weight: 400, tracking: '0' },
  bodyStrong: { size: 14, line: 20, weight: 550, tracking: '0' },
  bodySm: { size: 13, line: 18, weight: 400, tracking: '0' },
  label: { size: 12, line: 16, weight: 560, tracking: '0.04em' },
  caption: { size: 12, line: 16, weight: 400, tracking: '0' },
  mono: { size: 13, line: 20, weight: 400, tracking: '0' },
  monoSm: { size: 12, line: 18, weight: 400, tracking: '0' },
} as const

export const space = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80] as const

export const radius = { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 } as const

export const shadow = {
  sm: '0 1px 2px rgba(10, 26, 47, 0.04)',
  md: '0 4px 12px rgba(10, 26, 47, 0.06)',
  lg: '0 12px 32px rgba(10, 26, 47, 0.10)',
} as const

/** Motion — DESIGN_SYSTEM.md § 6. Every duration here explains a state change. */
export const motion = {
  micro: { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  standard: { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  enter: { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  exit: { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  amount: { duration: 320, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
} as const

export const tokens = {
  color, accentGradient, statusColor, font, type, space, radius, shadow, motion,
} as const
