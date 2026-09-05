/**
 * The Stage 3 settlement surfaces — `PRODUCT.md § 8`, `§ 12`.
 *
 * Two screens: New Settlement and Settlement Detail. Presentational, taking
 * view models and callbacks, so every state renders in Storybook and asserts in
 * jsdom without a database.
 *
 * What is deliberately **not** here, because Stages 4–6 do not exist yet: no
 * funding or facility figures, no provider names, no UTR, no receipt download,
 * no reconciliation detail, and no settled screen that implies money actually
 * moved. `SETTLED` renders in Storybook from a fixture so the design can be
 * judged; nothing in the running Stage 3 product can reach it, and the surface
 * does not pretend otherwise.
 */
import * as React from 'react'
import {
  AmountDisplay,
  AmountInput,
  BeneficiaryPicker,
  Button,
  EmptyState,
  QuoteSummary,
  Reference,
  RequirementCard,
  FileDrop,
  Input,
  Select,
  SettlementProgress,
  Skeleton,
  StatusIndicator,
  type BeneficiaryOption,
  type QuoteFeeLine,
} from '@inrsettle/ui'
import { money, type CurrencyCode, type Money } from '@inrsettle/money'
import type { Requirement } from '@inrsettle/domain/browser'
import {
  frozenDestinationNote,
  type ReturnNoticeView,
  type SettlementPresentation,
  type TimelineRow,
} from './view-models.js'

/* ─────────────────────────────────────────────────── New settlement ──── */

export interface QuoteView {
  recipientAmount: Money
  fundingAmount: Money
  fxRate: string
  fxPair: string
  fees: readonly QuoteFeeLine[]
  estimatedDelivery?: string
  expiresInSeconds?: number | null
}

export interface NewSettlementValues {
  beneficiaryId: string | null
  recipientMinorUnits: bigint | null
  purposeCode: string | null
  fundingCurrency: CurrencyCode
  /**
   * The customer's own reference, and any documents the purpose needs.
   *
   * The fifth and last input in the reading order `PRODUCT.md § 12.2` fixes:
   * *"Beneficiary → Recipient gets ₹ → Purpose → Funding currency → Reference /
   * documents if needed."* It is last because it is the only one that is often
   * not needed, and *"if needed"* is doing real work in that sentence — the
   * field is disclosed rather than always present, so the common path is four
   * inputs and a button.
   */
  reference: string
  documents: readonly { name: string; size?: number }[]
}

export const EMPTY_NEW_SETTLEMENT: NewSettlementValues = {
  beneficiaryId: null,
  recipientMinorUnits: null,
  purposeCode: null,
  fundingCurrency: 'USDT',
  reference: '',
  documents: [],
}

export interface NewSettlementProps {
  values: NewSettlementValues
  onChange: (values: NewSettlementValues) => void
  beneficiaries: readonly BeneficiaryOption[]
  beneficiaryQuery: string
  onBeneficiaryQueryChange: (q: string) => void
  purposes: readonly { code: string; label: string }[]
  fundingCurrencies: readonly CurrencyCode[]
  quote?: QuoteView | null
  quoteLoading?: boolean
  /**
   * A new quote is in flight **and the previous one is still on screen**.
   *
   * `DESIGN_SYSTEM.md § 6` forbids blanking a figure that has a value: *"The
   * figure never blanks and re-renders; that reads as uncertainty about
   * money."* So typing another digit re-prices without the recipient amount
   * ever disappearing — it morphs.
   */
  quoteRepricing?: boolean
  quoteError?: string
  /**
   * Whether the chosen purpose requires supporting documents.
   *
   * Comes from preflight rather than from a list in this file: which purposes
   * need what is a compliance question, and a surface that decided it locally
   * would be a second copy of the rule to keep in step.
   */
  documentsRequired?: boolean
  onDocuments?: (files: File[]) => void
  /**
   * Shown above the quote whenever the pricing is not a commercial commitment.
   * Required in sandbox — `D-08`/`D-09` are open, and a screen that presents a
   * test rate as a price the business will honour is worse than no screen.
   */
  provisionalNotice?: string
  /** Blocking requirements from preflight. Each renders its own card. */
  requirements?: readonly Requirement[]
  onRequirementAction?: (requirement: Requirement) => void
  onSubmit: () => void
  submitting?: boolean
  submitDisabledReason?: string
}

export function NewSettlement({
  values,
  onChange,
  beneficiaries,
  beneficiaryQuery,
  onBeneficiaryQueryChange,
  purposes,
  fundingCurrencies,
  quote,
  quoteLoading = false,
  quoteRepricing = false,
  quoteError,
  documentsRequired = false,
  onDocuments,
  provisionalNotice,
  requirements = [],
  onRequirementAction,
  onSubmit,
  submitting = false,
  submitDisabledReason,
}: NewSettlementProps): React.ReactElement {
  const set = <K extends keyof NewSettlementValues>(k: K, v: NewSettlementValues[K]): void =>
    onChange({ ...values, [k]: v })

  const recipient = values.recipientMinorUnits != null ? money('INR', values.recipientMinorUnits) : null

  return (
    <section className="is-new-settlement" aria-labelledby="new-settlement-heading">
      <form
        className="is-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <h1 id="new-settlement-heading">New settlement</h1>

        <BeneficiaryPicker
          label="Beneficiary"
          options={beneficiaries}
          value={values.beneficiaryId}
          query={beneficiaryQuery}
          onQueryChange={onBeneficiaryQueryChange}
          onChange={(id) => set('beneficiaryId', id)}
        />

        {/* Recipient-first: the customer states what the recipient gets, and
            everything else is derived from it (PRODUCT.md § 8). */}
        <AmountInput
          id="recipient-amount"
          label="Recipient gets"
          currency="INR"
          value={values.recipientMinorUnits}
          placeholder="0.00"
          help="The exact amount that reaches the beneficiary."
          onValueChange={(v) => set('recipientMinorUnits', v)}
        />

        <Select
          id="purpose"
          label="Purpose"
          value={values.purposeCode ?? ''}
          options={[
            { value: '', label: 'Choose a purpose' },
            ...purposes.map((p) => ({ value: p.code, label: p.label })),
          ]}
          onChange={(e) => set('purposeCode', e.target.value === '' ? null : e.target.value)}
        />

        <Select
          id="funding-currency"
          label="Funding currency"
          value={values.fundingCurrency}
          options={fundingCurrencies.map((c) => ({ value: c, label: c }))}
          onChange={(e) => set('fundingCurrency', e.target.value as CurrencyCode)}
        />

        {/*
          * Fifth and last in the reading order, and the only one that is often
          * not needed. § 12.2 says "Reference / documents **if needed**", so
          * the documents half appears only when the chosen purpose calls for
          * it — a file input on every settlement would imply one is expected.
          */}
        <Input
          id="customer-reference"
          label="Your reference"
          value={values.reference}
          help="Optional. Appears on your receipt and in the API, not on the payment."
          onChange={(e) => set('reference', e.target.value)}
        />

        {documentsRequired && (
          <FileDrop
            id="settlement-documents"
            label="Supporting documents"
            multiple
            files={values.documents}
            help="This purpose requires documentation. PDF or image."
            emptyLabel="Add a document"
            {...(onDocuments ? { onFiles: onDocuments } : {})}
          />
        )}

        {requirements.map((requirement) => (
          <RequirementCard
            key={requirement.code}
            code={requirement.code}
            title={requirement.title}
            detail={requirement.detail}
            severity={requirement.severity}
            action={{
              label: 'Resolve',
              onAction: () => onRequirementAction?.(requirement),
            }}
          />
        ))}

        <div className="is-form__actions">
          <Button
            type="submit"
            loading={submitting}
            {...(submitDisabledReason ? { disabled: true, disabledReason: submitDisabledReason } : {})}
          >
            {/* The commitment is named in the button, with the figure in it —
                "Settle ₹5,00,000", never a bare "Confirm". */}
            {recipient ? `Settle ${formatInr(recipient)}` : 'Settle'}
          </Button>
        </div>
      </form>

      {(quote || quoteLoading || quoteRepricing || quoteError) && (
        <QuoteSummary
          recipientAmount={quote?.recipientAmount ?? money('INR', 0n)}
          fundingAmount={quote?.fundingAmount ?? money(values.fundingCurrency, 0n)}
          fxRate={quote?.fxRate ?? '—'}
          fxPair={quote?.fxPair ?? `${values.fundingCurrency}/INR`}
          fees={quote?.fees ?? []}
          loading={quoteLoading}
          repricing={quoteRepricing}
          {...(quoteError ? { error: quoteError } : {})}
          {...(quote?.estimatedDelivery ? { estimatedDelivery: quote.estimatedDelivery } : {})}
          {...(quote?.expiresInSeconds != null ? { expiresInSeconds: quote.expiresInSeconds } : {})}
          {...(provisionalNotice ? { provisionalNotice } : {})}
        />
      )}
    </section>
  )
}

/** Local, so the button label does not depend on the AmountDisplay element. */
function formatInr(m: Money): string {
  const whole = (m.minorUnits / 100n).toString()
  const grouped = whole.length > 3
    ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3)
    : whole
  return `₹${grouped}`
}

/* ────────────────────────────────────────────────── Settlement detail ──── */

export interface SettlementDetailProps {
  reference: string
  recipientAmount: Money
  beneficiaryName: string
  destinationSummary: string
  presentation: SettlementPresentation
  /** Internal status, shown as secondary technical detail. */
  internalStatus: string
  createdAt: Date
  authorizedAt?: Date | null
  /** Present after authorization. Renders as a technical reference. */
  authorizedTermsHash?: string | null
  destinationVersionId?: string | null
  onCancel?: () => void
  onRequestCancellation?: () => void
  onRequirementAction?: (requirement: Requirement) => void
  /**
   * The plain-language timeline `PRODUCT.md § 12.3` prints verbatim.
   *
   * Already mapped to customer language by `settlementTimeline`, because the
   * same section forbids internal state names from dominating the page and a
   * surface that mapped them itself would be a second place the vocabulary
   * could drift.
   */
  timeline?: readonly TimelineRow[]
  /**
   * A return on this settlement, if there is one.
   *
   * § 12.3: it *"is the first thing read on that page, and the settlement still
   * reads SETTLED beside it, because both facts are true"*. Stage 6 built this
   * view model and no screen ever rendered it.
   */
  returnNotice?: ReturnNoticeView | null
  busy?: boolean
  loading?: boolean
}

export function SettlementDetail({
  reference,
  recipientAmount,
  beneficiaryName,
  destinationSummary,
  presentation,
  internalStatus,
  createdAt,
  authorizedAt,
  authorizedTermsHash,
  destinationVersionId,
  onCancel,
  onRequestCancellation,
  onRequirementAction,
  timeline = [],
  returnNotice = null,
  busy = false,
  loading = false,
}: SettlementDetailProps): React.ReactElement {
  if (loading) {
    return (
      <section aria-busy="true" aria-label="Loading settlement">
        <Skeleton height={56} />
        <Skeleton height={24} />
        <Skeleton height={72} />
      </section>
    )
  }

  const { badge, step, delayed, affordance, delayNote, requirement, resolutionMessage } = presentation
  const frozenNote = frozenDestinationNote(authorizedAt ?? null)

  return (
    <section className="is-settlement" aria-labelledby="settlement-heading">
      <header className="is-page__header">
        <div>
          <h1 id="settlement-heading" className="is-visually-hidden">
            Settlement {reference}
          </h1>
          {/* The amount is the headline; the customer identifies a settlement
              by what it sends, not by its id. */}
          <AmountDisplay amount={recipientAmount} size="hero" label={`To ${beneficiaryName}`} />
        </div>
        {badge && (
          <StatusIndicator
            tone={badge.tone}
            label={badge.label}
            {...(badge.detail ? { detail: badge.detail } : {})}
          />
        )}
      </header>

      {/*
        * First, and above everything else on the page.
        *
        * § 12.3: a return notice *"is the first thing read on that page, and
        * the settlement still reads SETTLED beside it, because both facts are
        * true"*. That is why it sits here rather than in the header — the
        * header's badge is the settlement's state and must not change, and
        * `STATE_MACHINES.md § 8.5` records the resulting tension as accepted
        * deliberately: mutating a final record, or projecting the return onto
        * CANCELLED, "destroys the distinction between never delivered and
        * delivered then returned".
        */}
      {returnNotice && (
        <div
          className={`is-return is-return--${returnNotice.tone}`}
          role={returnNotice.tone === 'attention' ? 'alert' : 'status'}
        >
          <div className="is-return__header">
            <h2 className="is-return__label">{returnNotice.label}</h2>
            <AmountDisplay amount={money('INR', returnNotice.amountMinor)} size="primary" />
          </div>
          <p className="is-return__detail">{returnNotice.detail}</p>
          <p className="is-muted">Reported {formatDay(returnNotice.observedAt)}</p>
        </div>
      )}

      {/* The rail only applies to the three states that are on it. An
          ACTION_REQUIRED or CANCELLED settlement is a different outcome, not a
          later step, so the surface renders the outcome instead. */}
      {step && (
        <SettlementProgress
          current={step}
          delayed={delayed}
          {...(delayed && delayNote ? { detail: delayNote } : {})}
        />
      )}

      {requirement && (
        <RequirementCard
          code={requirement.code}
          title={requirement.title}
          detail={requirement.detail}
          severity={requirement.severity}
          action={{ label: 'Resolve', onAction: () => onRequirementAction?.(requirement) }}
        />
      )}

      {/* D-03: FAILED and CANCELLED are one customer state, and the precise
          reason — not a second state name — is what tells them apart. */}
      {!step && !requirement && presentation.customerStatus === 'CANCELLED' && (
        <EmptyState
          title={badge?.label ?? 'Cancelled'}
          body={
            resolutionMessage ??
            'No funds were sent. You can create a new settlement whenever you are ready.'
          }
        />
      )}

      <dl className="is-facts">
        <div>
          <dt>Beneficiary</dt>
          <dd>{beneficiaryName}</dd>
        </div>
        <div>
          <dt>Payout destination</dt>
          <dd className="is-table__mono">{destinationSummary}</dd>
          {frozenNote && (
            /* § 12.3: "A small note says so, rather than leaving someone to
               wonder why the account they just corrected is not reflected
               here." Small, and beside the thing it explains. */
            <dd className="is-muted is-facts__note">{frozenNote}</dd>
          )}
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDay(createdAt)}</dd>
        </div>
        {authorizedAt && (
          <div>
            <dt>Authorized</dt>
            <dd>{formatDay(authorizedAt)}</dd>
          </div>
        )}
      </dl>

      {affordance === 'cancel' && onCancel && (
        <Button variant="secondary" loading={busy} onClick={onCancel}>
          Cancel settlement
        </Button>
      )}
      {affordance === 'request_cancellation' && onRequestCancellation && (
        <div className="is-settlement__cancel">
          <Button variant="secondary" loading={busy} onClick={onRequestCancellation}>
            Request cancellation
          </Button>
          {/* Honest about what "request" means. The settlement is already
              authorized, so cancellation takes effect at the next safe point
              rather than immediately, and saying so avoids a customer thinking
              it is already stopped. */}
          <p className="is-muted">
            This settlement is already authorized. We will stop it at the next safe point if we can.
          </p>
        </div>
      )}
      {affordance === 'requested' && (
        <p className="is-muted" role="status">
          Cancellation requested. We will stop this settlement at the next safe point if we can.
        </p>
      )}
      {affordance === 'none' && presentation.customerStatus === 'SETTLING' && (
        /* § 12.3: the Cancel control "disappears once the payout has been sent,
           replaced by a single line explaining why". Explaining, not just
           stating — "no longer available" answers nothing. */
        <p className="is-muted">
          This settlement can no longer be cancelled — the payout has been sent to the
          recipient&rsquo;s bank.
        </p>
      )}

      {/* Technical detail is secondary: present for support and developers,
          never competing with the amount and the state. */}
      <details className="is-settlement__technical">
        <summary>Technical details</summary>

        {/*
          * § 12.3 prints this list verbatim, and every line of it is a sentence
          * about the customer's money rather than a state name:
          *
          *   Settlement ready      14:02:11 IST
          *   Liquidity secured     14:02:14 IST
          *   INR payout confirmed  14:03:47 IST   UTR 2026083112345678
          *   Reconciled            14:03:52 IST   ₹5,000,000 expected · ₹5,000,000 observed
          */}
        {timeline.length > 0 && (
          <ol className="is-timeline">
            {timeline.map((row) => (
              <li key={`${row.label}-${row.at}`} className="is-timeline__row">
                <span className="is-timeline__label">{row.label}</span>
                <span className="is-timeline__at">{row.at}</span>
                {row.detail && <span className="is-timeline__detail">{row.detail}</span>}
              </li>
            ))}
          </ol>
        )}

        <dl className="is-facts">
          <div>
            <dt>Settlement</dt>
            <dd>
              <Reference value={reference} label="Settlement" />
            </dd>
          </div>
          <div>
            <dt>Internal state</dt>
            <dd className="is-table__mono">{internalStatus}</dd>
          </div>
          {destinationVersionId && (
            <div>
              <dt>Destination version</dt>
              <dd>
                <Reference value={destinationVersionId} label="Destination version" truncate />
              </dd>
            </div>
          )}
          {authorizedTermsHash && (
            <div>
              <dt>Authorized terms</dt>
              <dd>
                <Reference value={authorizedTermsHash} label="Authorized terms hash" truncate />
              </dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  )
}

function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d)
}
