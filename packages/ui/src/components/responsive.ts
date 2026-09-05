/**
 * The four breakpoints, and what the narrowest one is for — `DESIGN_SYSTEM.md § 8`.
 *
 * | Breakpoint | Behaviour |
 * |---|---|
 * | `≥1280px` | Full layout: sidebar nav, tables at full width, sticky quote summary |
 * | `1024–1279px` | Sidebar collapses to icons; tables drop low-priority columns |
 * | `768–1023px` | Single column; tables become stacked rows keyed by amount and beneficiary |
 * | `<768px` | **Monitoring experience** |
 *
 * The fourth row is the one with a decision in it. § 8:
 *
 *   *"On mobile the product does four things well: see what is moving, see what
 *   needs attention, open a settlement, and authorize one. Creating a batch,
 *   managing API keys and CSV import are desktop tasks and say so plainly rather
 *   than degrading."*
 *
 * *Say so plainly rather than degrading* is a real instruction and the hard half
 * of it. The easy thing is a responsive form that technically works at 360px —
 * a CSV importer with a file picker nobody can use, an API key screen where the
 * secret is shown once and is impossible to copy. That is worse than an honest
 * sentence, because it wastes the one moment the secret is visible.
 *
 * So the capability list below is data, and `DesktopTask` is what a desktop-only
 * surface renders instead of itself on a phone.
 */

export const BREAKPOINTS = {
  /** Full layout: sidebar nav, tables at full width, sticky quote summary. */
  full: 1280,
  /** Sidebar collapses to icons; tables drop low-priority columns. */
  compact: 1024,
  /** Single column; tables become stacked rows keyed by amount and beneficiary. */
  stacked: 768,
} as const

/** The four things § 8 says the product does well on a phone. */
export const MOBILE_CAPABILITIES = [
  'see what is moving',
  'see what needs attention',
  'open a settlement',
  'authorize one',
] as const

/** The three § 8 names as desktop tasks, with the words to say instead. */
export const DESKTOP_ONLY_TASKS = {
  batch_create: {
    title: 'Creating a batch is a desktop task',
    detail:
      'Batches are built from a spreadsheet and checked row by row, which needs a ' +
      'wider screen than this. Open INRSettle on a computer to create one.',
  },
  csv_import: {
    title: 'CSV import is a desktop task',
    detail:
      'Importing a file means reviewing every row that failed validation before ' +
      'anything is authorized. Open INRSettle on a computer to import.',
  },
  api_keys: {
    title: 'Managing API keys is a desktop task',
    detail:
      'A new key is shown once and never again, so it needs somewhere you can copy ' +
      'it to safely. Open INRSettle on a computer to create or revoke a key.',
  },
} as const

export type DesktopOnlyTask = keyof typeof DESKTOP_ONLY_TASKS

/**
 * Whether a task is available at this width.
 *
 * Width rather than a device sniff: a narrow window on a laptop is the same
 * problem as a phone, and a user agent string is a guess about a person.
 */
export function isDesktopTaskAvailable(viewportWidth: number): boolean {
  return viewportWidth >= BREAKPOINTS.stacked
}
