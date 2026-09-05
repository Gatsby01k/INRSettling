/**
 * The permitted animations — `DESIGN_SYSTEM.md § 6`.
 *
 * The section is a closed list of seven and an explicit ban on everything else.
 * A closed list nobody checks is a paragraph, so this file makes it data: every
 * `animation` and `transition` in the stylesheet must belong to one of these
 * seven, and `check-motion.mjs` fails the build over one that does not.
 *
 * The reason the list is closed at all is worth keeping in view. Every entry
 * below animates a **state change the customer needs to notice**: a price that
 * moved, a settlement that advanced, capacity that was consumed, a row that
 * arrived. Nothing on the list decorates. The banned list — confetti, checkmark
 * explosions, particles, parallax, cinematic sequences, looping ambient motion —
 * is a list of things that celebrate rather than inform, and this is a product
 * where the celebration for moving five million rupees correctly is that the
 * indicator turns teal, once, for 240ms.
 *
 * `§ 6` also bans *"anything that moves while the user is reading a number"*,
 * which is why the amount morph is opt-in on `AmountDisplay` rather than
 * automatic, and why no entry here loops.
 */

export interface PermittedAnimation {
  /** The keyframe or transition name that implements it. */
  readonly id: string
  /** § 6's own words for what it is. */
  readonly description: string
  /** Motion token it must use. */
  readonly token: 'micro' | 'standard' | 'enter' | 'exit' | 'amount'
  /**
   * What `prefers-reduced-motion: reduce` leaves.
   *
   * § 6: *"collapses every transition to opacity-only or instant. The amount
   * morph becomes an instant swap. Nothing is left in motion."* So every entry
   * declares which of the two it becomes, and none may say "unchanged".
   */
  readonly reduced: 'opacity' | 'instant'
}

export const PERMITTED_ANIMATIONS: readonly PermittedAnimation[] = [
  {
    id: 'is-amount-morph',
    description:
      'Amount morph — when a quote re-prices, digits transition in place. The ' +
      'figure never blanks and re-renders; that reads as uncertainty about money.',
    token: 'amount',
    reduced: 'instant',
  },
  {
    id: 'is-progress-advance',
    description:
      'Status progression — the rail fills from saffron to teal as the settlement ' +
      'advances. 320ms, once, on state change.',
    token: 'amount',
    reduced: 'opacity',
  },
  {
    id: 'is-availability-change',
    description:
      'Liquidity reservation feedback — a single restrained confirmation on the ' +
      'Available to settle figure when it decreases. It is the only feedback the ' +
      'customer gets for a mechanic they never see.',
    token: 'standard',
    reduced: 'opacity',
  },
  {
    id: 'is-event-enter',
    description: 'Event log insertion — new rows slide 4px and fade in over 180ms. No bounce.',
    token: 'standard',
    reduced: 'opacity',
  },
  {
    id: 'is-shimmer',
    description:
      'Skeleton loading — a shimmer no faster than 1.4s, matching final layout so ' +
      'content never shifts.',
    token: 'standard',
    reduced: 'instant',
  },
  {
    id: 'is-hover-focus',
    description: 'Hover and focus — 120ms, colour and border only, never scale.',
    token: 'micro',
    reduced: 'instant',
  },
  {
    id: 'is-settled-confirm',
    description:
      'Settled confirmation — the status indicator transitions to teal, once, 240ms. ' +
      'That is the entire celebration.',
    token: 'enter',
    reduced: 'opacity',
  },
] as const

/**
 * Explicitly banned, in § 6's own words.
 *
 * Matched against keyframe names and CSS property values, so a rule that
 * introduced one would have to be named something other than what it is —
 * at which point the seven-entry allowlist above catches it anyway.
 */
export const BANNED_MOTION: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /confetti/i, why: 'confetti' },
  { pattern: /checkmark[-_]?(explo|burst|pop)/i, why: 'checkmark explosions' },
  { pattern: /particle/i, why: 'particle systems' },
  { pattern: /parallax/i, why: 'parallax' },
  { pattern: /cinematic/i, why: 'cinematic sequences' },
  { pattern: /\binfinite\b/i, why: 'looping ambient motion' },
  { pattern: /\bbounce\b/i, why: 'bounce — § 6 names it specifically for the event log' },
]

/** § 6: *"anything longer than 400ms"* is banned outright. */
export const MAX_DURATION_MS = 400

/**
 * The one exception to the infinite-loop ban, and why it is one.
 *
 * The skeleton shimmer is on the permitted list *and* loops — a skeleton that
 * shimmered once and stopped would look like a rendering failure rather than a
 * wait. § 6 grants it explicitly ("a shimmer no faster than 1.4s") and caps its
 * speed instead of its repetition, and `prefers-reduced-motion` stops it dead.
 * The spinner is the same shape of exception for the same reason.
 */
export const PERMITTED_LOOPS: readonly string[] = ['is-shimmer', 'is-spin']
