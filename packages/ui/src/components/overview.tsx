/**
 * The two `DESIGN_SYSTEM.md § 5` domain components Stage 10 needs.
 *
 * Both were deferred by earlier stages with a recorded reason. `§ 12` says a
 * component that exists in an app but not in `packages/ui` is *"a bug to be
 * closed, not a shortcut to be kept"*, and Stage 10 is the pass that closes it:
 * the Developers event log has been building its own rows in `apps/app` since
 * Stage 8, and Overview cannot exist without a tile.
 *
 * | Component | § 5 says |
 * |---|---|
 * | `MetricTile` | *"Overview only. Label, value, and one line of context. No sparkline, no delta chip unless the delta is actionable."* |
 * | `EventRow` | *"Developer event log row; new rows insert with the motion in §6."* |
 */
import * as React from 'react'
import type { Money } from '@inrsettle/money'
import { AmountDisplay } from './settlement.js'
import { Skeleton } from './index.js'
import { StatusIndicator, type StatusTone } from './beneficiary.js'
import { stateCoverage, type StateCoverage } from './state-coverage.js'
import { DESKTOP_ONLY_TASKS, type DesktopOnlyTask } from './responsive.js'

/* ------------------------------------------------------------ MetricTile -- */

export interface MetricTileProps {
  label: string
  /**
   * A `Money`, a count, or nothing yet.
   *
   * `Money` rather than a formatted string, for the same reason `AmountDisplay`
   * refuses a number: the tile is the last place `INV-01` can be broken, and a
   * tile that accepted `'₹50,00,000'` would accept a figure somebody had already
   * rounded on the way in.
   *
   * `null` is *"this workspace has no such figure"* — the case
   * `PRODUCT.md § 12.1` names for **Available to settle** before a facility is
   * provisioned. It is not zero, and rendering it as zero would tell a customer
   * they have no headroom when the truth is that the question does not apply
   * to them yet.
   */
  value: Money | number | null
  /** One line. Not a paragraph, and never a second metric in disguise. */
  context: string
  /**
   * Present only when acting on it is the point.
   *
   * § 5: *"no delta chip unless the delta is actionable"*. A number that went
   * up since yesterday is not actionable; four settlements waiting on a
   * document are. So this is a call to action rather than a delta, and the
   * component has no way to render a percentage at all.
   */
  action?: { label: string; onSelect: () => void }
  loading?: boolean
  /** Shown instead of the value when the figure could not be loaded. */
  error?: string
}

export function MetricTile({
  label, value, context, action, loading = false, error,
}: MetricTileProps): React.ReactElement {
  const id = React.useId()

  /*
   * `DESIGN_SYSTEM.md § 6`, the third permitted animation:
   * *"Liquidity reservation feedback — a single restrained confirmation on the
   * Available to settle figure when it decreases. It is the only feedback the
   * customer gets for a mechanic they never see."*
   *
   * **When it decreases**, and only then. An increase is capacity arriving,
   * which needs no acknowledgement; a decrease is the moment their own
   * settlement consumed some, and that is the mechanic the customer never
   * otherwise sees happen. So the comparison is directional, and the tile does
   * it itself rather than asking every caller to remember.
   */
  const amount = value !== null && typeof value === 'object' ? value.minorUnits : null
  const previous = React.useRef(amount)
  const [reserved, setReserved] = React.useState(false)

  React.useEffect(() => {
    const before = previous.current
    previous.current = amount
    if (before === null || amount === null || amount >= before) return
    setReserved(true)
    const timer = setTimeout(() => setReserved(false), 180)
    return () => clearTimeout(timer)
  }, [amount])

  return (
    <article className="is-metric" aria-labelledby={`${id}-label`}>
      <h3 className="is-metric__label" id={`${id}-label`}>{label}</h3>

      {loading ? (
        // Skeleton at the final dimensions, so nothing shifts when the figure
        // arrives (§ 10).
        <div role="status" aria-busy="true" aria-label={`Loading ${label}`}>
          <Skeleton height={32} width="60%" />
        </div>
      ) : error !== undefined ? (
        <p className="is-metric__error" role="status">{error}</p>
      ) : value === null ? (
        // Not zero. "No figure" and "zero" are different answers, and only one
        // of them is about money the customer does not have.
        <p className="is-metric__value is-metric__value--absent">—</p>
      ) : typeof value === 'number' ? (
        <p className="is-metric__value">{value}</p>
      ) : (
        <p className={`is-metric__value${reserved ? ' is-metric__value--reserved' : ''}`}>
          <AmountDisplay amount={value} size="primary" />
        </p>
      )}

      <p className="is-metric__context">{context}</p>

      {action && (
        <button type="button" className="is-metric__action" onClick={action.onSelect}>
          {action.label}
        </button>
      )}
    </article>
  )
}

export const metricTileStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: true,
  error: true,
  disabled:
    'A metric is a rendered figure, not a control. Its optional action is an ' +
    'ordinary button and carries its own disabled state; a tile with nothing ' +
    'to act on simply has no action.',
})

/* -------------------------------------------------------------- EventRow -- */

export interface EventRowProps {
  id: string
  type: string
  at: string
  /** Delivery state as a dot plus a label, never colour alone (§ 7). */
  delivery: { tone: StatusTone; label: string }
  /**
   * True for a row that arrived after first paint.
   *
   * § 6 permits exactly one animation here: *"new rows slide 4px and fade in
   * over 180ms. No bounce."* Marked by the caller rather than detected, because
   * a component that animated on every mount would animate the whole list on
   * every navigation.
   */
  entering?: boolean
  onSelect?: (id: string) => void
  expanded?: boolean
  children?: React.ReactNode
}

export function EventRow({
  id, type, at, delivery, entering = false, onSelect, expanded, children,
}: EventRowProps): React.ReactElement {
  return (
    <>
      <tr className={`is-table__row${entering ? ' is-event--entering' : ''}`}>
        <td>
          {onSelect ? (
            <button
              type="button"
              className="is-table__link"
              aria-expanded={expanded}
              onClick={() => onSelect(id)}
            >
              {type}
            </button>
          ) : (
            <span className="is-table__mono">{type}</span>
          )}
        </td>
        <td><StatusIndicator tone={delivery.tone} label={delivery.label} /></td>
        <td className="is-table__mono">{at}</td>
      </tr>
      {expanded === true && children !== undefined && (
        <tr><td colSpan={3}>{children}</td></tr>
      )}
    </>
  )
}

export const eventRowStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty:
    'A row is one event. A list with no events renders an EmptyState instead ' +
    'of a row that says it is not there.',
  error:
    'An event that failed to deliver is a delivery state on a real row, not an ' +
    'error state of the row — which is the distinction the log exists to make.',
  disabled: true,
})

/* ----------------------------------------------------------- DesktopTask -- */

/**
 * What a desktop-only surface renders instead of itself on a phone.
 *
 * `DESIGN_SYSTEM.md § 8`: creating a batch, managing API keys and CSV import
 * *"are desktop tasks and say so plainly rather than degrading"*.
 *
 * *Rather than degrading* is the instruction, and the easy thing is the wrong
 * one: a responsive form that technically works at 360px — a CSV importer with
 * a file picker nobody can use, an API-key screen where the secret is shown once
 * and is impossible to copy — is worse than an honest sentence, because it
 * wastes the one moment the secret is visible.
 *
 * So this says what the task is, why it needs a wider screen, and what to do.
 * It is not an error, and it does not apologise.
 */
export interface DesktopTaskProps {
  task: DesktopOnlyTask
  /** What the customer *can* do here instead, when there is something. */
  alternative?: React.ReactNode
}

export function DesktopTask({ task, alternative }: DesktopTaskProps): React.ReactElement {
  const { title, detail } = DESKTOP_ONLY_TASKS[task]
  return (
    <section className="is-desktop-task" aria-labelledby={`${task}-title`}>
      <h2 className="is-desktop-task__title" id={`${task}-title`}>{title}</h2>
      <p className="is-desktop-task__detail">{detail}</p>
      {alternative}
    </section>
  )
}

export const desktopTaskStates: StateCoverage = stateCoverage({
  default: true,
  loading:
    'There is nothing to load. The message is decided by the viewport, which is ' +
    'known before any request is made — and a spinner here would imply the task ' +
    'might become available if you waited.',
  empty:
    'Not applicable: this component *is* the substitute for an absent surface, ' +
    'so an empty state of it would be an absence of an absence.',
  error:
    'Not applicable: nothing here can fail. Saying a screen is desktop-only is ' +
    'a statement about this device, not the result of an operation.',
  disabled:
    'Not applicable: it offers no control to disable. Its optional alternative ' +
    'is an ordinary element and carries its own states.',
})
