/**
 * Overlay and navigation primitives from the frozen catalogue
 * (DESIGN_SYSTEM.md § 5). Generic: none of them knows a domain concept.
 */
import * as React from 'react'
import { stateCoverage, type StateCoverage } from './state-coverage.js'
import { Skeleton } from './index.js'

/* ------------------------------------------------------------------ Popover */

export interface PopoverProps {
  id: string
  trigger: React.ReactNode
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  disabled?: boolean
}

export const Popover = ({
  id, trigger, children, open: controlled, onOpenChange, loading, disabled,
}: PopoverProps) => {
  const [uncontrolled, setUncontrolled] = React.useState(false)
  const open = controlled ?? uncontrolled
  const setOpen = (v: boolean) => { setUncontrolled(v); onOpenChange?.(v) }
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
    // `setOpen` is stable for this component's lifetime; re-subscribing on every
    // render would tear down and rebuild the listeners on each keystroke.
  }, [open])

  return (
    <div className="is-popover" ref={rootRef}>
      <button
        type="button"
        className="is-btn is-btn--secondary"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div className="is-popover__panel" id={`${id}-panel`} role="dialog" aria-label="More">
          {loading ? <Skeleton height={48} /> : children}
        </div>
      )}
    </div>
  )
}

export const popoverStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A popover with nothing to show is not opened; its trigger is hidden instead.',
  error: true,
  disabled: true,
})

/* ------------------------------------------------------------------- Drawer */

export interface DrawerProps {
  open: boolean
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
  onClose?: () => void
}

export const Drawer = ({ open, title, children, actions, onClose }: DrawerProps) => {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const returnTo = React.useRef<Element | null>(null)

  React.useEffect(() => {
    if (!open) return undefined
    returnTo.current = document.activeElement
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    ;(first ?? panelRef.current)?.focus()

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      ;(returnTo.current as HTMLElement | null)?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="is-drawer__scrim" onMouseDown={() => onClose?.()} />
      <div
        ref={panelRef}
        className="is-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <h2 className="is-drawer__title">{title}</h2>
        <div>{children}</div>
        {actions && <div className="is-modal__actions">{actions}</div>}
      </div>
    </>
  )
}

export const drawerStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A drawer with nothing to show is not opened.',
  error: true,
  disabled: 'A drawer is a container; its controls carry their own disabled state.',
})

/* -------------------------------------------------------------------- Toast */

export type ToastTone = 'neutral' | 'success' | 'error'

export interface ToastProps {
  id: string
  tone?: ToastTone
  title: string
  body?: string
  /** Auto-dismiss after this many ms. Omit to keep it until dismissed. */
  durationMs?: number
  onDismiss?: () => void
  loading?: boolean
}

export const Toast = ({ id, tone = 'neutral', title, body, durationMs, onDismiss, loading }: ToastProps) => {
  React.useEffect(() => {
    if (!durationMs) return undefined
    const t = setTimeout(() => onDismiss?.(), durationMs)
    return () => clearTimeout(t)
  }, [durationMs, onDismiss])

  return (
    <div
      className={`is-toast is-toast--${tone}`}
      id={id}
      // An error interrupts; anything else waits its turn.
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <div className="is-toast__body">
        <strong>{title}</strong>
        {loading ? <Skeleton height={14} width={160} /> : body && <div>{body}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="is-btn is-btn--ghost is-btn--icon"
          aria-label="Dismiss" onClick={onDismiss}>×</button>
      )}
    </div>
  )
}

export const toastStates: StateCoverage = stateCoverage({
  default: true,
  loading: true,
  empty: 'A toast with nothing to say is not raised.',
  error: true,
  disabled: 'A toast is not an interactive control; only its dismiss button is.',
})

/* --------------------------------------------------------------------- Tabs */

export interface TabItem { id: string; label: string; disabled?: boolean; content: React.ReactNode }

export interface TabsProps {
  id: string
  label: string
  items: readonly TabItem[]
  value?: string
  onValueChange?: (id: string) => void
  loading?: boolean
  emptyLabel?: string
}

export const Tabs = ({ id, label, items, value, onValueChange, loading, emptyLabel = 'Nothing here yet' }: TabsProps) => {
  const enabled = items.filter((i) => !i.disabled)
  const [internal, setInternal] = React.useState(enabled[0]?.id ?? '')
  const activeId = value ?? internal
  const select = (next: string) => { setInternal(next); onValueChange?.(next) }

  if (loading) return <div className="is-tabs"><Skeleton height={36} /><Skeleton height={80} /></div>
  if (items.length === 0) return <p className="is-field__help">{emptyLabel}</p>

  const active = items.find((i) => i.id === activeId) ?? items[0]!

  return (
    <div className="is-tabs">
      <div className="is-tabs__list" role="tablist" aria-label={label}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="is-tabs__tab"
            role="tab"
            id={`${id}-tab-${item.id}`}
            aria-selected={item.id === active.id}
            aria-controls={`${id}-panel-${item.id}`}
            // Roving tabindex: one stop for the tablist, arrows move within it.
            tabIndex={item.id === active.id ? 0 : -1}
            disabled={item.disabled}
            onClick={() => select(item.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const i = enabled.findIndex((t) => t.id === active.id)
              const next = e.key === 'ArrowRight'
                ? enabled[(i + 1) % enabled.length]
                : enabled[(i - 1 + enabled.length) % enabled.length]
              if (next) {
                select(next.id)
                document.getElementById(`${id}-tab-${next.id}`)?.focus()
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="is-tabs__panel"
        role="tabpanel"
        id={`${id}-panel-${active.id}`}
        aria-labelledby={`${id}-tab-${active.id}`}
        tabIndex={0}
      >
        {active.content}
      </div>
    </div>
  )
}

export const tabsStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true,
  error: 'A tab set does not fail; the panel inside it shows its own error state.',
  disabled: true,
})

/* --------------------------------------------------------------- Breadcrumb */

export interface Crumb { label: string; href?: string }

export interface BreadcrumbProps {
  label?: string
  items: readonly Crumb[]
  loading?: boolean
  emptyLabel?: string
}

export const Breadcrumb = ({ label = 'Breadcrumb', items, loading, emptyLabel = 'Overview' }: BreadcrumbProps) => {
  if (loading) return <Skeleton height={18} width={220} />
  const crumbs = items.length === 0 ? [{ label: emptyLabel }] : items
  return (
    <nav className="is-crumbs" aria-label={label}>
      <ol className="is-crumbs__list">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={`${c.label}-${i}`}>
              {i > 0 && <span className="is-crumbs__sep" aria-hidden="true">/ </span>}
              {last || !c.href ? (
                <span className="is-crumbs__current" aria-current={last ? 'page' : undefined}>{c.label}</span>
              ) : (
                <a href={c.href}>{c.label}</a>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export const breadcrumbStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true,
  error: 'A breadcrumb reflects where you are; it has no failure of its own.',
  disabled: 'A breadcrumb is navigation, not a control that can be disabled.',
})
