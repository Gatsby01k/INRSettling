/**
 * Stage 1 primitives.
 *
 * Generic building blocks only. No component here knows what a settlement, a
 * quote or a beneficiary is — the domain components in DESIGN_SYSTEM.md § 5
 * (AmountDisplay, StatusIndicator, SettlementProgress, QuoteSummary,
 * RequirementCard, …) belong to the stages that introduce those concepts, and
 * building them now to fill a Storybook would be implementing Stage 2+ early.
 */
import * as React from 'react'
import { stateCoverage, type StateCoverage } from './state-coverage.js'

type Div = React.HTMLAttributes<HTMLDivElement>

/* ------------------------------------------------------------------ Button */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
  loading?: boolean
  /** Shown to a keyboard or pointer user as the reason a disabled control is disabled. */
  disabledReason?: string
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading = false, disabled, disabledReason, children, onClick, ...rest },
  ref,
) {
  const inert = disabled || loading
  const reactId = React.useId()
  const reasonId = disabledReason ? `${reactId}-reason` : undefined

  // A native `disabled` button is removed from the tab order, so a `title` on it
  // is unreachable by keyboard and invisible to a screen reader — the reason
  // exists only for a mouse user who happens to hover. `aria-disabled` keeps the
  // control focusable and announced, the reason is associated with
  // aria-describedby, and activation is blocked here instead (§ 10, § 7).
  const useAriaDisabled = inert && !!disabledReason

  return (
    <>
      <button
        ref={ref}
        className={`is-btn is-btn--${variant}`}
        disabled={useAriaDisabled ? undefined : inert}
        aria-disabled={useAriaDisabled ? true : undefined}
        aria-busy={loading || undefined}
        aria-describedby={useAriaDisabled ? reasonId : undefined}
        onClick={(e) => {
          if (inert) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onClick?.(e)
        }}
        {...rest}
      >
        {loading && <span className="is-spinner" aria-hidden="true" />}
        {children}
      </button>
      {useAriaDisabled && (
        <span id={reasonId} className="is-field__help" data-disabled-reason>
          {disabledReason}
        </span>
      )}
    </>
  )
})

export const buttonStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A button renders its own label; it has no collection that can be empty.',
  error: true,
  disabled: true,
})

/* -------------------------------------------------------------- IconButton */

export interface IconButtonProps extends ButtonProps {
  /** Required: an icon never carries meaning alone (§ 7). */
  label: string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, variant = 'ghost', loading = false, disabled, disabledReason, children, ...rest },
    ref,
  ) {
    // `loading` and `disabledReason` are component props, not HTML attributes.
    // Spreading them onto <button> would emit invalid DOM attributes and, worse,
    // render a control that claims to be loading while behaving normally.
    return (
      <Button
        ref={ref}
        variant={variant}
        loading={loading}
        aria-label={label}
        className={`is-btn is-btn--${variant} is-btn--icon`}
        {...(disabled !== undefined ? { disabled } : {})}
        {...(disabledReason !== undefined ? { disabledReason } : {})}
        {...rest}
      >
        <span aria-hidden="true">{children}</span>
      </Button>
    )
  },
)

export const iconButtonStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'An icon button has no collection that can be empty.',
  error: true,
  disabled: true,
})

/* ------------------------------------------------------------------- Field */

interface FieldShellProps {
  id: string
  label: string
  // Explicit `| undefined`: the repo runs exactOptionalPropertyTypes, so an
  // optional prop and a prop that may be undefined are different types.
  help?: string | undefined
  error?: string | undefined
  children: React.ReactNode
}

function FieldShell({ id, label, help, error, children }: FieldShellProps) {
  return (
    <div className="is-field">
      <label className="is-field__label" htmlFor={id}>{label}</label>
      {children}
      {help && !error && <span className="is-field__help" id={`${id}-help`}>{help}</span>}
      {error && (
        <span className="is-field__error" id={`${id}-error`} role="alert">{error}</span>
      )}
    </div>
  )
}

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string
  label: string
  help?: string
  error?: string
  loading?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, help, error, loading, ...rest },
  ref,
) {
  if (loading) return <FieldShell id={id} label={label}><Skeleton height={36} /></FieldShell>
  return (
    <FieldShell id={id} label={label} help={help} error={error}>
      <input
        ref={ref}
        id={id}
        className="is-field__control"
        aria-invalid={error ? true : undefined}
        // Errors are associated, not signalled by colour alone (§ 7).
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        {...rest}
      />
    </FieldShell>
  )
})

export const inputStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: true,
  error: true,
  disabled: true,
})

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id: string
  label: string
  help?: string
  error?: string
  loading?: boolean
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, label, help, error, loading, ...rest },
  ref,
) {
  if (loading) return <FieldShell id={id} label={label}><Skeleton height={84} /></FieldShell>
  return (
    <FieldShell id={id} label={label} help={help} error={error}>
      <textarea
        ref={ref}
        id={id}
        className="is-field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        {...rest}
      />
    </FieldShell>
  )
})

export const textareaStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string
  label: string
  help?: string
  error?: string
  loading?: boolean
  options: readonly { value: string; label: string }[]
  emptyLabel?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, label, help, error, loading, options, emptyLabel = 'Nothing to choose from', ...rest },
  ref,
) {
  if (loading) return <FieldShell id={id} label={label}><Skeleton height={36} /></FieldShell>
  return (
    <FieldShell id={id} label={label} help={help} error={error}>
      <select
        ref={ref}
        id={id}
        className="is-field__control"
        aria-invalid={error ? true : undefined}
        disabled={rest.disabled || options.length === 0}
        {...rest}
      >
        {options.length === 0 ? (
          <option value="">{emptyLabel}</option>
        ) : (
          options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
        )}
      </select>
    </FieldShell>
  )
})

export const selectStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

/* -------------------------------------------------------- Checkbox / Switch */

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, ...rest }, ref,
) {
  return (
    <label className="is-check">
      <input ref={ref} type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  )
})

export const checkboxStates: StateCoverage = stateCoverage({
  default: true,
  loading: 'A checkbox reflects state it already has; the surrounding form owns loading.',
  empty: 'A checkbox is binary; it has no collection that can be empty.',
  error: true,
  disabled: true,
})

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, ...rest }, ref,
) {
  return (
    <label className="is-check">
      <span className="is-switch">
        <input ref={ref} type="checkbox" role="switch" aria-label={label} {...rest} />
        <span className="is-switch__track" />
        <span className="is-switch__thumb" />
      </span>
      <span>{label}</span>
    </label>
  )
})

export const switchStates: StateCoverage = stateCoverage({
  default: true,
  loading: 'A switch reflects state it already has; the surrounding form owns loading.',
  empty: 'A switch is binary; it has no collection that can be empty.',
  error: true,
  disabled: true,
})

/* --------------------------------------------- Divider / Skeleton / Spinner */

export const Divider = (props: React.HTMLAttributes<HTMLHRElement>) => (
  <hr className="is-divider" {...props} />
)

export const dividerStates: StateCoverage = stateCoverage({
  default: true,
  loading: 'A rule has no content of its own, so there is nothing to load.',
  empty: 'A rule has no content of its own, so it cannot be empty.',
  error: 'A rule draws a line; it performs no operation that can fail.',
  disabled: 'A rule is presentational and takes no interaction to disable.',
})

export interface SkeletonProps extends Div {
  width?: number | string
  height?: number | string
}

export const Skeleton = ({ width = '100%', height = 16, style, ...rest }: SkeletonProps) => (
  <span
    className="is-skeleton"
    aria-hidden="true"
    style={{ width, height, ...style }}
    {...rest}
  />
)

export const skeletonStates: StateCoverage = stateCoverage({
  default: 'A skeleton exists only to represent loading; its loading story is its default.',
  loading: true,
  empty: 'A skeleton stands in for content that has not arrived; emptiness is the view\'s to show.',
  error: 'A skeleton has no failure of its own; the surrounding view shows the error.',
  disabled: 'A skeleton is presentational and takes no interaction to disable.',
})

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <span className="is-spinner" role="status" aria-label={label} />
)

export const spinnerStates: StateCoverage = stateCoverage({
  default: 'A spinner exists only to represent loading; its loading story is its default.',
  loading: true,
  empty: 'A spinner stands in for work in progress; it holds no content to be empty.',
  error: 'A spinner has no failure of its own; the surrounding view reports one.',
  disabled: 'A spinner is presentational and takes no interaction to disable.',
})

/* -------------------------------------------------------------- EmptyState */

export interface EmptyStateProps {
  title: string
  /** One sentence saying what to do — not that there is nothing (§ 10). */
  body: string
  action?: React.ReactNode
}

export const EmptyState = ({ title, body, action }: EmptyStateProps) => (
  <div className="is-empty">
    <h3 className="is-empty__title">{title}</h3>
    <p className="is-empty__body">{body}</p>
    {action}
  </div>
)

export const emptyStateStates: StateCoverage = stateCoverage({
  default: 'An empty state exists only to represent emptiness; its empty story is its default.',
  loading: 'A skeleton is shown instead while the collection is still loading.',
  empty: true,
  error: true,
  disabled: 'An empty state is not interactive; its action is a Button with its own states.',
})

/* ------------------------------------------------------- Tooltip / Modal */

export const Tooltip = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const [open, setOpen] = React.useState(false)
  return (
    <span
      className="is-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && <span className="is-tooltip__bubble" role="tooltip">{label}</span>}
    </span>
  )
}

export const tooltipStates: StateCoverage = stateCoverage({
  default: true,
  loading: 'A tooltip renders text it already holds, so it never waits on anything.',
  empty: 'A tooltip with no label is not rendered at all, so it has no empty form.',
  error: 'A tooltip has no failure of its own; it only ever renders text it holds.',
  disabled: true,
})

export interface ModalProps {
  open: boolean
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
  onClose?: () => void
}

export const Modal = ({ open, title, children, actions, onClose }: ModalProps) => {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const returnFocusTo = React.useRef<Element | null>(null)

  React.useEffect(() => {
    if (!open) return undefined
    returnFocusTo.current = document.activeElement

    // Focus moves into the dialog on open, and back where it came from on close.
    // Without this a keyboard user is left behind the scrim with nothing focused.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    ;(first ?? panelRef.current)?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key !== 'Tab') return

      // Minimal focus containment: Tab past the last control wraps to the first.
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (focusable.length === 0) return
      const firstEl = focusable[0]!
      const lastEl = focusable[focusable.length - 1]!
      if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        firstEl.focus()
      } else if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault()
        lastEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      ;(returnFocusTo.current as HTMLElement | null)?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="is-modal__scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        ref={panelRef}
        className="is-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <h2 className="is-modal__title">{title}</h2>
        <div>{children}</div>
        {actions && <div className="is-modal__actions">{actions}</div>}
      </div>
    </div>
  )
}

export const modalStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A modal with nothing to say is not opened.',
  error: true,
  disabled: 'A modal is a container; its controls carry their own disabled state.',
})
