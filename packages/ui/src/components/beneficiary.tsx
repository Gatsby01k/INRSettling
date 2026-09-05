/**
 * Stage 2 domain components — `DESIGN_SYSTEM.md § 5`.
 *
 * Three of the frozen domain components, and only three: the ones the
 * beneficiary and preflight surfaces actually need. `AmountDisplay`,
 * `SettlementProgress`, `QuoteSummary`, `Reference`, `EventRow`,
 * `ReceiptDocument` and `MetricTile` stay deferred to the stages that introduce
 * what they render.
 *
 * These take plain props, not domain objects. The UI package does not import
 * `@inrsettle/domain`; the shapes below are the presentational contract, and
 * the application maps its view models onto them.
 */
import * as React from 'react'
import { stateCoverage, type StateCoverage } from './state-coverage.js'
import { Button } from './index.js'

/* --------------------------------------------------------- StatusIndicator */

/**
 * "Dot + label. The single source of status rendering."
 *
 * The dot is decorative and hidden from assistive technology — the label is the
 * status. A dot alone would encode meaning in colour, which § 7 forbids.
 */
export type StatusTone = 'ready' | 'settling' | 'settled' | 'action_required' | 'cancelled'

export interface StatusIndicatorProps {
  tone: StatusTone
  label: string
  /** Optional context: "checked 12 Aug", "takes about a minute". */
  detail?: string
}

export function StatusIndicator({ tone, label, detail }: StatusIndicatorProps): React.ReactElement {
  /*
   * `DESIGN_SYSTEM.md § 6`, the last of the seven permitted animations:
   * *"Settled confirmation — the status indicator transitions to teal, once,
   * 240ms. That is the entire celebration."*
   *
   * On *arriving at* settled, not on rendering settled. A settlement detail page
   * opened a week later must not replay the moment; the customer is reading a
   * record, and § 6 bans anything that moves while they are. So the previous
   * tone is remembered and the class lands only on a transition into `settled`.
   */
  const previous = React.useRef(tone)
  const [confirming, setConfirming] = React.useState(false)

  React.useEffect(() => {
    const arrived = previous.current !== tone && tone === 'settled'
    previous.current = tone
    if (!arrived) return
    setConfirming(true)
    const timer = setTimeout(() => setConfirming(false), 240)
    return () => clearTimeout(timer)
  }, [tone])

  return (
    <span
      className={
        `is-status is-status--${tone}` + (confirming ? ' is-status--confirming' : '')
      }
    >
      <span className="is-status__dot" aria-hidden="true" />
      <span className="is-status__label">{label}</span>
      {detail && <span className="is-status__detail">{detail}</span>}
    </span>
  )
}

export const statusIndicatorStates: StateCoverage = stateCoverage({
  default: true,
  loading: 'Status is a rendered fact; the surface holding it owns the loading state.',
  empty: 'There is no empty status — absence of status is itself a status.',
  error: true,
  disabled: 'Not interactive: it renders a subject that may itself be disabled, but the indicator has no disabled state of its own.',
})

/* --------------------------------------------------------- RequirementCard */

/**
 * "Title, detail, one action button. Cannot render without all three."
 *
 * The type enforces that literally: `title`, `detail` and `action` are all
 * required and non-optional, so a requirement missing any of them is a type
 * error at the call site rather than an empty card in front of a customer
 * (`PRODUCT.md § 7.1`).
 */
export interface RequirementCardProps {
  code: string
  title: string
  detail: string
  action: { label: string; onAction: () => void }
  severity?: 'blocking' | 'advisory'
  /** Set while the action is running. */
  busy?: boolean
  /** Why the action cannot be taken right now, if it cannot. */
  actionDisabledReason?: string
}

export function RequirementCard({
  code,
  title,
  detail,
  action,
  severity = 'blocking',
  busy = false,
  actionDisabledReason,
}: RequirementCardProps): React.ReactElement {
  const headingId = React.useId()
  return (
    <article
      className={`is-requirement is-requirement--${severity}`}
      aria-labelledby={headingId}
      data-requirement-code={code}
    >
      <div className="is-requirement__body">
        <h3 id={headingId} className="is-requirement__title">
          {title}
        </h3>
        <p className="is-requirement__detail">{detail}</p>
      </div>
      <div className="is-requirement__action">
        <Button
          variant={severity === 'blocking' ? 'primary' : 'secondary'}
          loading={busy}
          {...(actionDisabledReason ? { disabled: true, disabledReason: actionDisabledReason } : {})}
          onClick={action.onAction}
        >
          {action.label}
        </Button>
      </div>
    </article>
  )
}

export const requirementCardStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A requirement with nothing to say is not a requirement; the list renders EmptyState.',
  error: true,
  disabled: true,
})

/* -------------------------------------------------------- BeneficiaryPicker */

/**
 * "Search-first combobox, shows destination summary and verification state
 * inline."
 *
 * Search-first means the field is focused for typing, not for browsing a list.
 * The destination summary is always the masked form — this component has no
 * prop that could carry a full account number.
 */
export interface BeneficiaryOption {
  id: string
  displayName: string
  /** Masked, e.g. "HDFC •••• 6789". Never a full account number. */
  destinationSummary: string | null
  verification: { tone: StatusTone; label: string }
}

export interface BeneficiaryPickerProps {
  label: string
  options: readonly BeneficiaryOption[]
  value?: string | null
  onChange: (id: string) => void
  query?: string
  onQueryChange?: (q: string) => void
  loading?: boolean
  disabled?: boolean
  disabledReason?: string
  /** Shown when the search returns nothing. Says what to do next. */
  emptyLabel?: string
}

export function BeneficiaryPicker({
  label,
  options,
  value,
  onChange,
  query,
  onQueryChange,
  loading = false,
  disabled = false,
  disabledReason,
  emptyLabel = 'No beneficiary matches that name. Create one to continue.',
}: BeneficiaryPickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const listId = React.useId()
  const inputId = React.useId()
  const reasonId = disabledReason ? `${inputId}-reason` : undefined

  React.useEffect(() => setActive(0), [options])

  const commit = (option: BeneficiaryOption | undefined): void => {
    if (!option) return
    onChange(option.id)
    setOpen(false)
  }

  return (
    <div className="is-field is-picker">
      <label className="is-field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        // `is-field__control`, like every other text input in the system. It
        // said `is-input` from Stage 2 — a class no stylesheet defines — so the
        // beneficiary picker rendered as a bare browser input sitting inside a
        // styled field, next to controls that looked right.
        className="is-field__control"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${options[active]!.id}` : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={reasonId}
        aria-busy={loading || undefined}
        value={query ?? ''}
        placeholder="Search beneficiaries"
        onChange={(e) => {
          if (disabled) return
          onQueryChange?.(e.target.value)
          setOpen(true)
        }}
        onFocus={() => !disabled && setOpen(true)}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(i + 1, options.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            if (!open) return
            e.preventDefault()
            commit(options[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {reasonId && (
        <span id={reasonId} className="is-field__help" data-disabled-reason>
          {disabledReason}
        </span>
      )}
      {open && (
        <ul className="is-picker__list" id={listId} role="listbox" aria-label={label}>
          {loading && (
            <li className="is-picker__status" role="presentation">
              <span className="is-skeleton" aria-hidden="true" />
            </li>
          )}
          {!loading && options.length === 0 && (
            <li className="is-picker__status" role="presentation">
              {emptyLabel}
            </li>
          )}
          {!loading &&
            options.map((option, i) => (
              <li
                key={option.id}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={option.id === value}
                className={`is-picker__option${i === active ? ' is-picker__option--active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(option)
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="is-picker__name">{option.displayName}</span>
                <span className="is-picker__summary">
                  {option.destinationSummary ?? 'No payout destination yet'}
                </span>
                <StatusIndicator tone={option.verification.tone} label={option.verification.label} />
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

export const beneficiaryPickerStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: true,
  error: true,
  disabled: true,
})
