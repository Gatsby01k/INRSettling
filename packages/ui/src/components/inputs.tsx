/**
 * Input primitives from the frozen catalogue (DESIGN_SYSTEM.md § 5).
 *
 * Generic by construction. `AmountInput` knows about currencies because money
 * is a primitive concern (`@inrsettle/money` is a pure package); it knows
 * nothing about settlements, quotes or beneficiaries.
 */
import * as React from 'react'
import {
  formatMoney, money, moneyFromDecimalString, scaleOf, type CurrencyCode,
} from '@inrsettle/money'
import { stateCoverage, type StateCoverage } from './state-coverage.js'
import { Skeleton } from './index.js'

/* -------------------------------------------------------------- AmountInput */

export interface AmountInputProps {
  id: string
  label: string
  currency: CurrencyCode
  /** Controlled value in minor units. */
  value?: bigint | null
  onValueChange?: (value: bigint | null) => void
  help?: string | undefined
  error?: string | undefined
  loading?: boolean
  disabled?: boolean
  placeholder?: string
}

const SYMBOL: Partial<Record<CurrencyCode, string>> = { INR: '₹' }

/**
 * Paste-tolerant: strips the symbol, grouping separators, ordinary and
 * non-breaking spaces. Someone copying "₹5,000,000.00" out of a spreadsheet
 * should not have to clean it up by hand (DESIGN_SYSTEM.md § 5).
 */
export function parseAmountInput(raw: string, currency: CurrencyCode): bigint | null {
  const cleaned = raw
    .replace(/[₹$€£]/g, '')
    .replace(/[\s  ]/g, '')
    .replace(/,/g, '')
    .trim()
  if (cleaned === '') return null
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return null
  const scale = scaleOf(currency)
  const [whole = '0', frac = ''] = cleaned.split('.')
  if (frac.length > scale) return null
  return moneyFromDecimalString(currency, `${whole}.${frac.padEnd(scale, '0')}`).minorUnits
}

export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(
  function AmountInput(
    { id, label, currency, value = null, onValueChange, help, error, loading, disabled, placeholder },
    ref,
  ) {
    const [text, setText] = React.useState<string>(() =>
      value === null ? '' : formatMoney(money(currency, value), { symbol: false }),
    )
    const [invalid, setInvalid] = React.useState(false)

    if (loading) {
      return (
        <div className="is-field">
          <label className="is-field__label" htmlFor={id}>{label}</label>
          <Skeleton height={40} />
        </div>
      )
    }

    const symbol = SYMBOL[currency] ?? ''
    const shownError = error ?? (invalid ? `Enter an amount in ${currency}.` : undefined)

    return (
      <div className="is-field">
        <label className="is-field__label" htmlFor={id}>{label}</label>
        <div className="is-amount-field">
          {symbol && <span className="is-amount-field__symbol" aria-hidden="true">{symbol}</span>}
          <input
            ref={ref}
            id={id}
            className="is-amount-field__control"
            // Never a number input: spinners invite a stray scroll to change an
            // amount, and the value is bigint minor units, not a float.
            type="text"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            aria-invalid={shownError ? true : undefined}
            aria-describedby={shownError ? `${id}-error` : help ? `${id}-help` : undefined}
            onChange={(e) => {
              const next = e.target.value
              setText(next)
              const parsed = parseAmountInput(next, currency)
              setInvalid(next.trim() !== '' && parsed === null)
              onValueChange?.(parsed)
            }}
            onBlur={() => {
              const parsed = parseAmountInput(text, currency)
              // Reformat only on blur — never mid-keystroke.
              if (parsed !== null) setText(formatMoney(money(currency, parsed), { symbol: false }))
            }}
          />
        </div>
        {help && !shownError && <span className="is-field__help" id={`${id}-help`}>{help}</span>}
        {shownError && <span className="is-field__error" id={`${id}-error`} role="alert">{shownError}</span>}
      </div>
    )
  },
)

export const amountInputStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

/* -------------------------------------------------------------------- Radio */

export interface RadioOption { value: string; label: string; disabled?: boolean }

export interface RadioGroupProps {
  name: string
  legend: string
  options: readonly RadioOption[]
  value?: string
  onValueChange?: (value: string) => void
  error?: string | undefined
  loading?: boolean
  disabled?: boolean
  emptyLabel?: string
}

export const Radio = ({
  name, legend, options, value, onValueChange, error, loading, disabled,
  emptyLabel = 'Nothing to choose from',
}: RadioGroupProps) => {
  if (loading) {
    return (
      <fieldset className="is-field">
        <legend className="is-field__label">{legend}</legend>
        <Skeleton height={20} width={180} /><Skeleton height={20} width={140} />
      </fieldset>
    )
  }
  return (
    <fieldset className="is-field" aria-invalid={error ? true : undefined}>
      <legend className="is-field__label">{legend}</legend>
      {options.length === 0 ? (
        <p className="is-field__help">{emptyLabel}</p>
      ) : (
        <div className="is-radios">
          {options.map((o) => (
            <label className="is-check" key={o.value}>
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={value === o.value}
                disabled={disabled || o.disabled}
                onChange={() => onValueChange?.(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
      {error && <span className="is-field__error" role="alert">{error}</span>}
    </fieldset>
  )
}

export const radioStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

/* ----------------------------------------------------------------- Combobox */

export interface ComboboxOption { value: string; label: string }

export interface ComboboxProps {
  id: string
  label: string
  options: readonly ComboboxOption[]
  value?: string | null
  onValueChange?: (value: string | null) => void
  help?: string | undefined
  error?: string | undefined
  loading?: boolean
  disabled?: boolean
  emptyLabel?: string
  placeholder?: string
}

export const Combobox = ({
  id, label, options, value = null, onValueChange, help, error, loading, disabled,
  emptyLabel = 'No matches', placeholder,
}: ComboboxProps) => {
  const selected = options.find((o) => o.value === value) ?? null
  const [query, setQuery] = React.useState(selected?.label ?? '')
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const listId = `${id}-list`

  const filtered = React.useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())),
    [options, query],
  )

  if (loading) {
    return (
      <div className="is-field">
        <label className="is-field__label" htmlFor={id}>{label}</label>
        <Skeleton height={36} />
      </div>
    )
  }

  const commit = (opt: ComboboxOption) => {
    onValueChange?.(opt.value)
    setQuery(opt.label)
    setOpen(false)
  }

  return (
    <div className="is-field">
      <label className="is-field__label" htmlFor={id}>{label}</label>
      <div className="is-combo">
        <input
          id={id}
          className="is-field__control"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[active] ? `${id}-opt-${filtered[active]!.value}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault(); setOpen(true)
              setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault(); setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              const opt = filtered[active]
              if (open && opt) { e.preventDefault(); commit(opt) }
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {open && (
          <ul className="is-combo__list" id={listId} role="listbox" aria-label={label}>
            {filtered.length === 0 ? (
              <li className="is-combo__empty" role="presentation">{emptyLabel}</li>
            ) : (
              filtered.map((o, i) => (
                <li
                  key={o.value}
                  id={`${id}-opt-${o.value}`}
                  className="is-combo__option"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); commit(o) }}
                >
                  {o.label}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {help && !error && <span className="is-field__help" id={`${id}-help`}>{help}</span>}
      {error && <span className="is-field__error" id={`${id}-error`} role="alert">{error}</span>}
    </div>
  )
}

export const comboboxStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

/* --------------------------------------------------------------- DatePicker */

export interface DatePickerProps {
  id: string
  label: string
  value?: string
  onValueChange?: (value: string) => void
  help?: string | undefined
  error?: string | undefined
  loading?: boolean
  disabled?: boolean
  min?: string
  max?: string
}

/**
 * A native date control rather than a hand-built calendar.
 *
 * The platform one is keyboard-accessible, localised and screen-reader
 * correct for free. Replacing it needs a reason Stage 1 does not have, and a
 * bespoke calendar is a large accessibility surface to get wrong.
 */
export const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(
  function DatePicker({ id, label, value, onValueChange, help, error, loading, disabled, min, max }, ref) {
    if (loading) {
      return (
        <div className="is-field">
          <label className="is-field__label" htmlFor={id}>{label}</label>
          <Skeleton height={36} />
        </div>
      )
    }
    return (
      <div className="is-field">
        <label className="is-field__label" htmlFor={id}>{label}</label>
        <input
          ref={ref}
          id={id}
          type="date"
          className="is-field__control"
          value={value ?? ''}
          min={min}
          max={max}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
          onChange={(e) => onValueChange?.(e.target.value)}
        />
        {help && !error && <span className="is-field__help" id={`${id}-help`}>{help}</span>}
        {error && <span className="is-field__error" id={`${id}-error`} role="alert">{error}</span>}
      </div>
    )
  },
)

export const datePickerStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})

/* ----------------------------------------------------------------- FileDrop */

export interface FileDropProps {
  id: string
  label: string
  accept?: string
  multiple?: boolean
  files?: readonly { name: string; size?: number }[]
  onFiles?: (files: File[]) => void
  help?: string | undefined
  error?: string | undefined
  loading?: boolean
  disabled?: boolean
  emptyLabel?: string
}

export const FileDrop = ({
  id, label, accept, multiple, files = [], onFiles, help, error, loading, disabled,
  emptyLabel = 'Drop a file here, or choose one',
}: FileDropProps) => {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)

  if (loading) {
    return (
      <div className="is-field">
        <span className="is-field__label">{label}</span>
        <Skeleton height={96} />
      </div>
    )
  }

  const open = () => { if (!disabled) inputRef.current?.click() }

  return (
    <div className="is-field">
      <span className="is-field__label" id={`${id}-label`}>{label}</span>
      <div
        className="is-filedrop"
        // A drop zone must be reachable and operable without a pointer.
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-disabled={disabled || undefined}
        aria-invalid={error ? true : undefined}
        data-dragging={dragging}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
        }}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false)
          if (!disabled) onFiles?.(Array.from(e.dataTransfer?.files ?? []))
        }}
      >
        <span>{files.length === 0 ? emptyLabel : `${files.length} file${files.length === 1 ? '' : 's'} selected`}</span>
        {files.length > 0 && (
          <ul className="is-filedrop__list">
            {files.map((f) => <li key={f.name}>{f.name}</li>)}
          </ul>
        )}
        <input
          ref={inputRef}
          id={id}
          type="file"
          hidden
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => onFiles?.(Array.from(e.target.files ?? []))}
        />
      </div>
      {help && !error && <span className="is-field__help">{help}</span>}
      {error && <span className="is-field__error" role="alert">{error}</span>}
    </div>
  )
}

export const fileDropStates: StateCoverage = stateCoverage({
  default: true, loading: true, empty: true, error: true, disabled: true,
})
