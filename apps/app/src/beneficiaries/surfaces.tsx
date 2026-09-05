/**
 * The Stage 2 beneficiary surfaces — `PRODUCT.md § 11`, `DESIGN_SYSTEM.md § 5`.
 *
 * Five screens: the list, the detail, create, edit-destination, and the
 * preflight panel. All presentational: they take view models and callbacks, so
 * every state can be rendered in Storybook and asserted in a test without a
 * database.
 *
 * What is deliberately absent, because `PRODUCT.md § 11` says beneficiaries are
 * not a CRM: tags, notes, owners, contacts, lifecycle stages, activity feeds.
 * There is also no provider name anywhere in this file and no compliance
 * dashboard — a customer verifies a beneficiary; they do not run a penny drop.
 */
import * as React from 'react'
import {
  Button,
  EmptyState,
  Input,
  RequirementCard,
  Select,
  Skeleton,
  StatusIndicator,
} from '@inrsettle/ui'
import type { Requirement } from '@inrsettle/domain/browser'
import { actionLabel, type BeneficiaryRow, type VerificationBadge, type VersionRow } from './view-models.js'

/* ─────────────────────────────────────────────── Beneficiaries list ──── */

export interface BeneficiaryListProps {
  rows: readonly BeneficiaryRow[]
  query: string
  onQueryChange: (q: string) => void
  onOpen: (id: string) => void
  onCreate: () => void
  loading?: boolean
  error?: string
}

export function BeneficiaryList({
  rows,
  query,
  onQueryChange,
  onOpen,
  onCreate,
  loading = false,
  error,
}: BeneficiaryListProps): React.ReactElement {
  return (
    <section aria-labelledby="beneficiaries-heading">
      <header className="is-page__header">
        <h1 id="beneficiaries-heading">Beneficiaries</h1>
        <Button onClick={onCreate}>New beneficiary</Button>
      </header>

      <Input
        id="beneficiary-search"
        label="Search"
        value={query}
        placeholder="Search by name"
        onChange={(e) => onQueryChange(e.target.value)}
      />

      {error && (
        <EmptyState
          title="We could not load your beneficiaries"
          body={error}
          action={<Button variant="secondary" onClick={() => onQueryChange(query)}>Try again</Button>}
        />
      )}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading beneficiaries">
          {/* Skeleton rows at the real row height, so nothing shifts (§ 5). */}
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <EmptyState
          title={query ? 'No beneficiary matches that name' : 'No beneficiaries yet'}
          body={
            query
              ? 'Try a different name, or add the person or company you want to pay.'
              : 'Add the person or company you want to pay. You verify their payout details once, then settle to them as often as you like.'
          }
          action={<Button onClick={onCreate}>New beneficiary</Button>}
        />
      )}

      {!error && !loading && rows.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Payout destination</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="is-table__row">
                <td>
                  {/* The whole row is reachable through one real control, so it
                      takes a focus ring and works from the keyboard (§ 5). */}
                  <button type="button" className="is-table__link" onClick={() => onOpen(row.id)}>
                    {row.displayName}
                  </button>
                </td>
                <td className="is-table__mono">
                  {row.destinationSummary ?? <span className="is-muted">Not added yet</span>}
                </td>
                <td>
                  <StatusIndicator tone={row.status.tone} label={row.status.label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ───────────────────────────────────────────────── Beneficiary detail ──── */

export interface DestinationPanel {
  id: string
  kind: 'bank_account' | 'upi'
  currentVersionId: string | null
  summary: string
  verification: VerificationBadge
  /** True while a verification is in flight for the current version. */
  verifying: boolean
  /** Reason the verify action is unavailable, if it is. */
  verifyDisabledReason?: string
  history: readonly VersionRow[]
}

export interface BeneficiaryDetailProps {
  displayName: string
  legalName: string | null
  country: string
  taxIdLast4: string | null
  status: VerificationBadge
  destinations: readonly DestinationPanel[]
  onVerify: (destinationVersionId: string) => void
  onEditDestination: (destinationId: string) => void
  onAddDestination: () => void
  onNewSettlement?: () => void
}

export function BeneficiaryDetail({
  displayName,
  legalName,
  country,
  taxIdLast4,
  status,
  destinations,
  onVerify,
  onEditDestination,
  onAddDestination,
  onNewSettlement,
}: BeneficiaryDetailProps): React.ReactElement {
  return (
    <section aria-labelledby="beneficiary-heading">
      <header className="is-page__header">
        <div>
          <h1 id="beneficiary-heading">{displayName}</h1>
          <StatusIndicator tone={status.tone} label={status.label} {...(status.detail ? { detail: status.detail } : {})} />
        </div>
        {/* The single primary action on this screen (PRODUCT.md § 11). */}
        {onNewSettlement && <Button onClick={onNewSettlement}>New settlement</Button>}
      </header>

      <dl className="is-facts">
        <div>
          <dt>Legal name</dt>
          <dd>{legalName ?? displayName}</dd>
        </div>
        <div>
          <dt>Country</dt>
          <dd>{country === 'IN' ? 'India' : country}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd>{taxIdLast4 ? `•••• ${taxIdLast4}` : <span className="is-muted">Not provided</span>}</dd>
        </div>
      </dl>

      <section aria-labelledby="destinations-heading">
        <header className="is-page__subheader">
          <h2 id="destinations-heading">Payout destinations</h2>
          <Button variant="secondary" onClick={onAddDestination}>
            Add destination
          </Button>
        </header>

        {destinations.length === 0 && (
          <EmptyState
            title="No payout destination yet"
            body={`Add the bank account or UPI ID ${displayName} should receive funds in.`}
            action={<Button onClick={onAddDestination}>Add destination</Button>}
          />
        )}

        {destinations.map((destination) => (
          <article key={destination.id} className="is-destination">
            <header className="is-destination__header">
              <span className="is-destination__summary">{destination.summary}</span>
              <StatusIndicator
                tone={destination.verification.tone}
                label={destination.verification.label}
                {...(destination.verification.detail ? { detail: destination.verification.detail } : {})}
              />
            </header>

            <div className="is-destination__actions">
              <Button
                variant="secondary"
                onClick={() => onEditDestination(destination.id)}
              >
                Edit details
              </Button>
              {destination.verification.label !== 'Verified' && destination.currentVersionId && (
                <Button
                  loading={destination.verifying}
                  {...(destination.verifyDisabledReason
                    ? { disabled: true, disabledReason: destination.verifyDisabledReason }
                    : {})}
                  onClick={() => onVerify(destination.currentVersionId!)}
                >
                  {destination.verification.label === 'Could not verify' ? 'Try again' : 'Verify'}
                </Button>
              )}
            </div>

            {destination.history.length > 1 && (
              <details className="is-destination__history">
                <summary>Previous details ({destination.history.length - 1})</summary>
                <ul>
                  {destination.history
                    .filter((v) => !v.current)
                    .map((v) => (
                      <li key={v.id}>
                        <span className="is-table__mono">{v.summary}</span>
                        <StatusIndicator tone={v.verification.tone} label={v.verification.label} />
                      </li>
                    ))}
                </ul>
                <p className="is-muted">
                  Earlier details are kept exactly as they were verified. Settlements already
                  authorized against them are unaffected by later edits.
                </p>
              </details>
            )}
          </article>
        ))}
      </section>
    </section>
  )
}

/* ──────────────────────────────────────────────── Create beneficiary ──── */

export interface BeneficiaryFormValues {
  displayName: string
  legalName: string
  type: 'individual' | 'business'
  taxId: string
  kind: 'bank_account' | 'upi'
  accountNumber: string
  ifsc: string
  accountType: 'savings' | 'current'
  accountHolderName: string
  vpa: string
}

export const EMPTY_BENEFICIARY_FORM: BeneficiaryFormValues = {
  displayName: '',
  legalName: '',
  type: 'individual',
  taxId: '',
  kind: 'bank_account',
  accountNumber: '',
  ifsc: '',
  accountType: 'savings',
  accountHolderName: '',
  vpa: '',
}

/** Field-level problems, keyed by form field. Never a single generic message. */
export type FormErrors = Partial<Record<keyof BeneficiaryFormValues, string>>

export interface CreateBeneficiaryFormProps {
  values: BeneficiaryFormValues
  errors?: FormErrors
  onChange: (values: BeneficiaryFormValues) => void
  onSubmit: () => void
  onCancel: () => void
  submitting?: boolean
}

export function CreateBeneficiaryForm({
  values,
  errors = {},
  onChange,
  onSubmit,
  onCancel,
  submitting = false,
}: CreateBeneficiaryFormProps): React.ReactElement {
  const set = <K extends keyof BeneficiaryFormValues>(key: K, value: BeneficiaryFormValues[K]): void =>
    onChange({ ...values, [key]: value })

  return (
    <form
      className="is-form"
      aria-labelledby="create-beneficiary-heading"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <h1 id="create-beneficiary-heading">New beneficiary</h1>

      <Input
        id="displayName"
        label="Name"
        value={values.displayName}
        {...(errors.displayName ? { error: errors.displayName } : {})}
        onChange={(e) => set('displayName', e.target.value)}
      />
      <Select
        id="type"
        label="Type"
        value={values.type}
        options={[
          { value: 'individual', label: 'Individual' },
          { value: 'business', label: 'Business' },
        ]}
        onChange={(e) => set('type', e.target.value as 'individual' | 'business')}
      />
      {values.type === 'business' && (
        <Input
          id="legalName"
          label="Registered legal name"
          value={values.legalName}
          {...(errors.legalName ? { error: errors.legalName } : {})}
          onChange={(e) => set('legalName', e.target.value)}
        />
      )}
      <Input
        id="taxId"
        label="PAN (optional)"
        value={values.taxId}
        help="Some purposes and amounts require a PAN. You can add it later."
        {...(errors.taxId ? { error: errors.taxId } : {})}
        onChange={(e) => set('taxId', e.target.value.toUpperCase())}
      />

      <fieldset className="is-fieldset">
        <legend>Payout destination</legend>
        <Select
          id="kind"
          label="Send to"
          value={values.kind}
          options={[
            { value: 'bank_account', label: 'Bank account' },
            { value: 'upi', label: 'UPI ID' },
          ]}
          onChange={(e) => set('kind', e.target.value as 'bank_account' | 'upi')}
        />

        {values.kind === 'bank_account' ? (
          <>
            <Input
              id="accountHolderName"
              label="Account holder name"
              value={values.accountHolderName}
              help="Exactly as it appears on the bank account."
              {...(errors.accountHolderName ? { error: errors.accountHolderName } : {})}
              onChange={(e) => set('accountHolderName', e.target.value)}
            />
            <Input
              id="accountNumber"
              label="Account number"
              inputMode="numeric"
              value={values.accountNumber}
              {...(errors.accountNumber ? { error: errors.accountNumber } : {})}
              onChange={(e) => set('accountNumber', e.target.value.replace(/\s/g, ''))}
            />
            <Input
              id="ifsc"
              label="IFSC"
              value={values.ifsc}
              help="Eleven characters, for example HDFC0000123."
              {...(errors.ifsc ? { error: errors.ifsc } : {})}
              onChange={(e) => set('ifsc', e.target.value.toUpperCase())}
            />
            <Select
              id="accountType"
              label="Account type"
              value={values.accountType}
              options={[
                { value: 'savings', label: 'Savings' },
                { value: 'current', label: 'Current' },
              ]}
              onChange={(e) => set('accountType', e.target.value as 'savings' | 'current')}
            />
          </>
        ) : (
          <Input
            id="vpa"
            label="UPI ID"
            value={values.vpa}
            help="For example aarti@okhdfcbank."
            {...(errors.vpa ? { error: errors.vpa } : {})}
            onChange={(e) => set('vpa', e.target.value)}
          />
        )}
      </fieldset>

      <p className="is-muted">
        We verify these details before your first settlement. It takes about a minute.
      </p>

      <div className="is-form__actions">
        <Button type="submit" loading={submitting}>
          Create beneficiary
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ───────────────────────────────────────── Edit a payout destination ──── */

export interface EditDestinationFormProps {
  beneficiaryName: string
  currentSummary: string
  currentVerification: VerificationBadge
  values: BeneficiaryFormValues
  errors?: FormErrors
  onChange: (values: BeneficiaryFormValues) => void
  onSubmit: () => void
  onCancel: () => void
  submitting?: boolean
  /** True when the form still matches the saved details — nothing would change. */
  unchanged?: boolean
}

/**
 * Editing payout details.
 *
 * The screen says plainly what saving does, because the consequence is real:
 * a new version is created, it is unverified, and settlements cannot be
 * authorized against it until it is checked (`INV-44`). Hiding that would let
 * someone break their own settlement flow by fixing a typo.
 *
 * A save that changes nothing creates nothing, and the button says so rather
 * than silently doing nothing.
 */
export function EditDestinationForm({
  beneficiaryName,
  currentSummary,
  currentVerification,
  values,
  errors = {},
  onChange,
  onSubmit,
  onCancel,
  submitting = false,
  unchanged = false,
}: EditDestinationFormProps): React.ReactElement {
  const set = <K extends keyof BeneficiaryFormValues>(key: K, value: BeneficiaryFormValues[K]): void =>
    onChange({ ...values, [key]: value })

  return (
    <form
      className="is-form"
      aria-labelledby="edit-destination-heading"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <h1 id="edit-destination-heading">Edit payout details</h1>
      <p>
        <span className="is-table__mono">{currentSummary}</span>{' '}
        <StatusIndicator tone={currentVerification.tone} label={currentVerification.label} />
      </p>

      {currentVerification.label === 'Verified' && (
        <p className="is-callout" role="note">
          Saving different details creates a new version of this destination, and we will need to
          verify it before your next settlement to {beneficiaryName}. The details you have verified
          stay exactly as they are, and settlements already authorized against them are unaffected.
        </p>
      )}

      {values.kind === 'bank_account' ? (
        <>
          <Input
            id="accountHolderName"
            label="Account holder name"
            value={values.accountHolderName}
            {...(errors.accountHolderName ? { error: errors.accountHolderName } : {})}
            onChange={(e) => set('accountHolderName', e.target.value)}
          />
          <Input
            id="accountNumber"
            label="Account number"
            inputMode="numeric"
            value={values.accountNumber}
            {...(errors.accountNumber ? { error: errors.accountNumber } : {})}
            onChange={(e) => set('accountNumber', e.target.value.replace(/\s/g, ''))}
          />
          <Input
            id="ifsc"
            label="IFSC"
            value={values.ifsc}
            {...(errors.ifsc ? { error: errors.ifsc } : {})}
            onChange={(e) => set('ifsc', e.target.value.toUpperCase())}
          />
        </>
      ) : (
        <Input
          id="vpa"
          label="UPI ID"
          value={values.vpa}
          {...(errors.vpa ? { error: errors.vpa } : {})}
          onChange={(e) => set('vpa', e.target.value)}
        />
      )}

      <div className="is-form__actions">
        <Button
          type="submit"
          loading={submitting}
          {...(unchanged
            ? { disabled: true, disabledReason: 'These are the details already saved. Change one to continue.' }
            : {})}
        >
          Save new details
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ─────────────────────────────────────────────────── Preflight panel ──── */

export interface PreflightPanelProps {
  status: 'ready' | 'action_required'
  requirements: readonly Requirement[]
  onAction: (requirement: Requirement) => void
  /** Requirement codes whose action is currently running. */
  busyCodes?: readonly string[]
  loading?: boolean
}

/**
 * Preflight, as the customer sees it: exactly two outcomes, and every blocking
 * requirement carries its own explanation and its own button
 * (`PRODUCT.md § 7`). There is no aggregate "3 problems" summary — a count is
 * not an explanation.
 */
export function PreflightPanel({
  status,
  requirements,
  onAction,
  busyCodes = [],
  loading = false,
}: PreflightPanelProps): React.ReactElement {
  if (loading) {
    return (
      <section aria-busy="true" aria-label="Checking this settlement">
        <Skeleton height={96} />
        <Skeleton height={96} />
      </section>
    )
  }

  const blocking = requirements.filter((r) => r.severity === 'blocking')
  const advisory = requirements.filter((r) => r.severity === 'advisory')

  return (
    <section aria-labelledby="preflight-heading">
      <h2 id="preflight-heading">
        {status === 'ready' ? 'Ready to settle' : 'Action required'}
      </h2>

      {status === 'ready' && blocking.length === 0 && (
        <StatusIndicator tone="ready" label="Ready" detail="Nothing is outstanding." />
      )}

      {blocking.map((requirement) => (
        <RequirementCard
          key={requirement.code}
          code={requirement.code}
          title={requirement.title}
          detail={requirement.detail}
          severity="blocking"
          busy={busyCodes.includes(requirement.code)}
          action={{ label: actionLabel(requirement.action), onAction: () => onAction(requirement) }}
        />
      ))}

      {advisory.length > 0 && (
        <div className="is-preflight__advisory">
          {advisory.map((requirement) => (
            <RequirementCard
              key={requirement.code}
              code={requirement.code}
              title={requirement.title}
              detail={requirement.detail}
              severity="advisory"
              busy={busyCodes.includes(requirement.code)}
              action={{ label: actionLabel(requirement.action), onAction: () => onAction(requirement) }}
            />
          ))}
        </div>
      )}
    </section>
  )
}
