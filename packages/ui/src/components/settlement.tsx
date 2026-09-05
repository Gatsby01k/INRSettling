/**
 * Stage 3 domain components — `DESIGN_SYSTEM.md § 5`.
 *
 * Four of the frozen domain components, and only four: the ones the New
 * Settlement and Settlement Detail surfaces need. `EventRow`,
 * `ReceiptDocument` and `MetricTile` stay deferred to the stages that
 * introduce a developer log, a receipt and an overview.
 *
 * As with Stage 2, these take plain props rather than domain objects — the UI
 * package imports nothing from `@inrsettle/domain`. The one exception is
 * `Money`, which comes from `@inrsettle/money`: `AmountDisplay` exists
 * precisely so that a monetary value cannot be rendered from a `number`, and
 * that guarantee needs the real type.
 */
import * as React from 'react'
import { formatMoney, type Money } from '@inrsettle/money'
import { stateCoverage, type StateCoverage } from './state-coverage.js'
import { Skeleton } from './index.js'

/* ------------------------------------------------------- AmountDisplay -- */

export type AmountSize = 'hero' | 'primary' | 'body' | 'compact'

export interface AmountDisplayProps {
  /**
   * A `Money`, never a number. `INV-01` is a property of the money path, and
   * the last place it can be broken is the renderer: `AmountDisplay({amount:
   * 50000.5})` must not typecheck.
   */
  amount: Money
  size?: AmountSize
  /** Indian grouping for INR, international otherwise. Overridable per workspace. */
  format?: 'indian' | 'international'
  /** A short label rendered above the figure — "Recipient gets", "You pay". */
  label?: string
  /** Strike through, for a superseded figure. */
  superseded?: boolean
  /**
   * Transition the digits in place when the value changes.
   *
   * `DESIGN_SYSTEM.md § 6`, the first permitted animation: *"Amount morph —
   * when a quote re-prices, digits transition in place. The figure never blanks
   * and re-renders; that reads as uncertainty about money."*
   *
   * Opt-in rather than automatic, because most amounts on a page are static
   * facts. A settled receipt figure that animated on every render would be
   * moving while the user is reading a number, which the same section bans
   * outright.
   */
  morph?: boolean
}

export function AmountDisplay({
  amount,
  size = 'body',
  format,
  label,
  superseded = false,
  morph = false,
}: AmountDisplayProps): React.ReactElement {
  const grouping = format ?? (amount.currency === 'INR' ? 'indian' : 'international')
  const rendered = formatMoney(amount, { format: grouping })

  /*
   * The morph is a class applied for one animation's length, then removed.
   *
   * The important part is what it is *not*: the text node is written
   * unconditionally on every render, so the new figure is on screen
   * immediately. The animation decorates a value that has already changed —
   * it never gates it. A morph implemented as "hide, wait, show" would blank
   * the figure, which is the exact failure § 6 names.
   *
   * The transition is opacity and a 2px lift; `prefers-reduced-motion` reduces
   * it to an instant swap in CSS, so there is no media query to read here and
   * no branch that could disagree with the stylesheet.
   */
  const [morphing, setMorphing] = React.useState(false)
  const previous = React.useRef(rendered)

  React.useEffect(() => {
    if (!morph) return
    if (previous.current === rendered) return
    previous.current = rendered
    setMorphing(true)
    const timer = setTimeout(() => setMorphing(false), 320)
    return () => clearTimeout(timer)
  }, [morph, rendered])

  return (
    <span className={`is-amount is-amount--${size}${superseded ? ' is-amount--superseded' : ''}`}>
      {label && <span className="is-amount__label">{label}</span>}
      {/* Tabular figures so a column of amounts aligns on the decimal (§ 5). */}
      <span
        className={`is-amount__value${morphing ? ' is-amount__value--morphing' : ''}`}
        data-currency={amount.currency}
      >
        {rendered}
      </span>
    </span>
  )
}

export const amountDisplayStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A zero amount is a real amount and renders as one; there is no empty state.',
  error: 'An amount that could not be computed is not rendered as an amount — the surface shows the failure.',
  disabled: 'Not interactive: an amount is a rendered value, and the control that produces it owns any disabled state.',
})

/* -------------------------------------------------- SettlementProgress -- */

/**
 * "Ready → Settling → Settled rail. The completed portion carries the accent
 * gradient."
 *
 * Three customer-facing steps and no more. The internal machine has seventeen
 * states; showing them here would answer a question the customer did not ask.
 * `ACTION_REQUIRED` and `CANCELLED` are not steps on this rail — they are
 * different shapes of outcome, and the surface renders them instead of it.
 */
export type ProgressStep = 'READY' | 'SETTLING' | 'SETTLED'

export interface SettlementProgressProps {
  current: ProgressStep
  /** Extra context under the active step: "usually under 30 minutes". */
  detail?: string
  /** Marks the active step as delayed without inventing a fourth step. */
  delayed?: boolean
}

const STEPS: readonly { step: ProgressStep; label: string }[] = [
  { step: 'READY', label: 'Ready' },
  { step: 'SETTLING', label: 'Settling' },
  { step: 'SETTLED', label: 'Settled' },
]

export function SettlementProgress({
  current,
  detail,
  delayed = false,
}: SettlementProgressProps): React.ReactElement {
  const index = STEPS.findIndex((s) => s.step === current)

  /*
   * § 6: *"Status progression — the rail fills from saffron to teal as the
   * settlement advances. 320ms, once, on state change."*
   *
   * "On state change" is the whole instruction. Animating on mount would replay
   * the settlement's history every time someone opened the page, which is both
   * a lie about when it happened and motion while a number is being read.
   */
  const previous = React.useRef(current)
  const [advancing, setAdvancing] = React.useState(false)

  React.useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    setAdvancing(true)
    const timer = setTimeout(() => setAdvancing(false), 320)
    return () => clearTimeout(timer)
  }, [current])

  return (
    <div
      className={
        `is-progress${delayed ? ' is-progress--delayed' : ''}` +
        (advancing ? ' is-progress--advancing' : '')
      }
      role="group"
      aria-label="Settlement progress"
    >
      <ol className="is-progress__steps">
        {STEPS.map((s, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'todo'
          return (
            <li key={s.step} className={`is-progress__step is-progress__step--${state}`}>
              {/* The state is in the text, not only in the fill (§ 7). */}
              <span className="is-progress__label" aria-current={state === 'current' ? 'step' : undefined}>
                {s.label}
              </span>
              <span className="is-visually-hidden">
                {state === 'done' ? ' (complete)' : state === 'current' ? ' (in progress)' : ' (not started)'}
              </span>
            </li>
          )
        })}
      </ol>
      {detail && <p className="is-progress__detail">{detail}</p>}
    </div>
  )
}

export const settlementProgressStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A settlement always has a position on the rail; there is no empty state.',
  error: true,
  disabled: 'Not interactive: it reports progress rather than accepting input.',
})

/* ------------------------------------------------------- QuoteSummary -- */

export interface QuoteFeeLine {
  code: string
  label: string
  amount: Money
}

/**
 * "Recipient-first. Sticky. The recipient figure morphs on change."
 *
 * The visually dominant number is what the recipient gets. Funding amount, FX
 * rate and fees are supporting detail — the customer is buying an outcome in
 * rupees, not an FX trade.
 */
export interface QuoteSummaryProps {
  recipientAmount: Money
  fundingAmount: Money
  /** Pre-formatted; the exact decimal string, never a float. */
  fxRate: string
  fxPair: string
  fees: readonly QuoteFeeLine[]
  /** Human band, e.g. "under 30 minutes". Never a fabricated precise time. */
  estimatedDelivery?: string
  /** Seconds until expiry. Null when the quote does not expire on screen. */
  expiresInSeconds?: number | null
  loading?: boolean
  /**
   * A quote is being fetched **and a previous one is still on screen**.
   *
   * Distinct from `loading`, which is the first pricing. `§ 6` forbids blanking
   * a figure that already has a value, so a re-price keeps the recipient amount
   * rendered and morphing while the derived lines below it wait.
   */
  repricing?: boolean
  error?: string
  /**
   * Shown verbatim above the figures when the pricing is not a real commercial
   * commitment. Required in sandbox: a quote that looks like a price the
   * business will honour, but is not, is the most expensive kind of mock.
   */
  provisionalNotice?: string
}

export function QuoteSummary({
  recipientAmount,
  fundingAmount,
  fxRate,
  fxPair,
  fees,
  estimatedDelivery,
  expiresInSeconds,
  loading = false,
  repricing = false,
  error,
  provisionalNotice,
}: QuoteSummaryProps): React.ReactElement {
  if (error) {
    return (
      <aside className="is-quote is-quote--error" aria-labelledby="quote-heading">
        <h2 id="quote-heading">We could not price this settlement</h2>
        <p>{error}</p>
      </aside>
    )
  }

  /*
   * Two different loadings, and § 6 makes the distinction load-bearing.
   *
   * **First pricing** has no figure yet, so a skeleton at the final dimensions
   * is right: nothing blanks, because nothing was there.
   *
   * **Re-pricing** is the case the section legislates: *"The figure never
   * blanks and re-renders; that reads as uncertainty about money."* Replacing a
   * live ₹50,00,000 with a grey bar every time the customer types a digit is
   * precisely that failure, and it is what this component did. So a re-price
   * keeps the recipient figure on screen — struck through nothing, greyed
   * nothing — and only the derived lines below it, which genuinely are unknown
   * until the new quote lands, go to skeletons.
   */
  if (loading && !repricing) {
    return (
      <aside className="is-quote" aria-busy="true" aria-label="Pricing this settlement">
        <Skeleton height={48} />
        <Skeleton height={16} />
        <Skeleton height={16} />
      </aside>
    )
  }

  return (
    <aside className="is-quote" aria-labelledby="quote-heading">
      {provisionalNotice && (
        <p className="is-quote__provisional" role="note">
          {provisionalNotice}
        </p>
      )}
      <h2 id="quote-heading" className="is-visually-hidden">
        Quote
      </h2>

      {/* The dominant figure, and the one that morphs. It stays on screen
          through a re-price; only what is genuinely unknown goes grey. */}
      <AmountDisplay amount={recipientAmount} size="hero" label="Recipient gets" morph />

      <dl className="is-quote__lines" aria-busy={repricing || undefined}>
        <div>
          <dt>You pay</dt>
          <dd>
            {repricing ? (
              <Skeleton height={16} width="80px" />
            ) : (
              <AmountDisplay amount={fundingAmount} size="compact" />
            )}
          </dd>
        </div>
        <div>
          <dt>Rate</dt>
          <dd className="is-quote__rate">
            {repricing ? <Skeleton height={16} width="120px" /> : `${fxPair} ${fxRate}`}
          </dd>
        </div>
        {!repricing &&
          fees.map((fee) => (
            <div key={fee.code}>
              <dt>{fee.label}</dt>
              <dd>
                <AmountDisplay amount={fee.amount} size="compact" />
              </dd>
            </div>
          ))}
        {estimatedDelivery && !repricing && (
          <div>
            <dt>Arrives</dt>
            <dd>{estimatedDelivery}</dd>
          </div>
        )}
      </dl>

      {expiresInSeconds != null && (
        <p className="is-quote__expiry" aria-live="polite">
          {expiresInSeconds > 0
            ? `Rate held for ${formatCountdown(expiresInSeconds)}`
            : 'This rate has expired — we will fetch a new one.'}
        </p>
      )}
    </aside>
  )
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export const quoteSummaryStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'Nothing to price yet is a state of the form, not of the summary; the form hides it.',
  error: true,
  disabled: 'Not interactive: it reports a price rather than accepting input.',
})

/* ---------------------------------------------------------- Reference -- */

/**
 * "Monospace ID with a copy affordance on hover and on focus."
 *
 * On focus as well as hover, because a reference a keyboard user can see but
 * not copy is the kind of detail that makes a support call longer than it
 * needs to be.
 */
export interface ReferenceProps {
  value: string
  label?: string
  /** Shortens the middle for display; the full value is still copied. */
  truncate?: boolean
  onCopy?: (value: string) => void
}

export function Reference({ value, label, truncate = false, onCopy }: ReferenceProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const shown = truncate && value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value

  return (
    <span className="is-ref">
      {label && <span className="is-ref__label">{label}</span>}
      <code className="is-ref__value" title={truncate ? value : undefined}>
        {shown}
      </code>
      <button
        type="button"
        className="is-ref__copy"
        onClick={() => {
          onCopy?.(value)
          setCopied(true)
        }}
        // The full value, so a screen-reader user hears what they are copying
        // rather than the truncated form.
        aria-label={`Copy ${label ?? 'reference'} ${value}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

export const referenceStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A reference that does not exist yet is not rendered; the surface omits the row.',
  error: 'A reference is a value, not an operation — it has no error state of its own.',
  disabled: true,
})
