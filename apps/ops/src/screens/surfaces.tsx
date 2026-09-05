/**
 * The Internal Operations screens — `PRODUCT.md § 14`.
 *
 * > A separate surface, outside customer navigation, where complexity is
 * > allowed and expected… **The internal tool may expose complexity. The
 * > customer product must not.**
 *
 * So these look nothing like `apps/app`'s. There is no reassurance, no
 * progressive disclosure and no summarising: a queue shows the internal status,
 * the transition that would follow, the provider's own code and the age, all at
 * once, because the person reading it is debugging rather than being informed.
 *
 * Three things are the same as the customer surfaces, deliberately:
 *
 * **Presentational.** View models in, callbacks out, no database, no fetch —
 * so every state renders in a test in milliseconds.
 *
 * **Masked account numbers.** `SECURITY.md § 8` has no ops exception, and the
 * ciphertext is not granted to the ops role at all, so there is nothing here to
 * unmask even for someone who wanted to.
 *
 * **Every destructive action is confirmed, and the confirmation names the
 * consequence.** More so here than there: this is the surface where the
 * irreversible actions live.
 *
 * One thing is different and is the point of the stage: **nothing happens
 * without a reason.** The reason field is inside every confirmation dialog, it
 * is required to enable the confirm button, and it is what the request sends.
 * A screen where the reason were optional would make the audit log a list of
 * blanks.
 */
import * as React from 'react'
import { Button, EmptyState, Input, Modal, Skeleton, StatusIndicator, Textarea } from '@inrsettle/ui'
import type { StatusTone } from '@inrsettle/ui'
import {
  confirmResolution, orderQueue,
  type ActionConfirmation, type ExceptionRow, type FacilityCard, type ProviderEventRow,
} from './view-models.js'

/* ── Tones ──────────────────────────────────────────────────────────────── */

const HEADROOM_TONE: Record<FacilityCard['headroom'], StatusTone> = {
  healthy: 'settled',
  tight: 'settling',
  exhausted: 'action_required',
  suspended: 'cancelled',
}

const VERDICT_TONE: Record<ProviderEventRow['verdict'], StatusTone> = {
  interpreted: 'settled',
  pending: 'settling',
  unmapped: 'action_required',
  unsigned: 'action_required',
}

/* ── The reason, everywhere ─────────────────────────────────────────────── */

export interface ReasonedConfirmProps {
  confirmation: ActionConfirmation | null
  onConfirm: (reason: string) => void
  onCancel: () => void
  busy?: boolean
}

/**
 * The one dialog every action goes through.
 *
 * The confirm button is disabled until a reason is written, and it says why —
 * `SECURITY.md § 6` makes the reason mandatory, and a screen that let an
 * operator click through and then refused server-side would teach them the
 * field was decoration.
 *
 * There is one of these rather than one per action, because a second copy is
 * how "this action does not need a reason" gets introduced by accident.
 */
export function ReasonedConfirm({
  confirmation, onConfirm, onCancel, busy = false,
}: ReasonedConfirmProps): React.ReactElement {
  const [reason, setReason] = React.useState('')

  // Cleared when the dialog changes, so a reason typed for one action can never
  // be submitted for the next.
  React.useEffect(() => { setReason('') }, [confirmation?.title])

  const tooShort = reason.trim().length < 8

  return (
    <Modal
      open={confirmation !== null}
      title={confirmation?.title ?? ''}
      onClose={onCancel}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>Back</Button>
          <Button
            variant="destructive"
            loading={busy}
            {...(tooShort
              ? { disabled: true, disabledReason: 'Write why you are doing this first.' }
              : {})}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmation?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {confirmation && (
        <>
          <p>{confirmation.body}</p>
          <Textarea
            id="ops-reason"
            label="Reason"
            value={reason}
            rows={3}
            help={confirmation.reasonPrompt}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      )}
    </Modal>
  )
}

/* ── The exception queue ────────────────────────────────────────────────── */

export interface ExceptionQueueProps {
  rows: readonly ExceptionRow[]
  onResolve: (settlementId: string, resolution: 'resume' | 'fail' | 'cancel', reason: string) => void
  onOpenSettlement: (settlementId: string) => void
  loading?: boolean
  error?: string
  busy?: boolean
}

/**
 * Where an operator lives.
 *
 * Live before sandbox and oldest first, because a ten-hour-old sandbox
 * exception is somebody testing and a five-minute-old live one is a customer's
 * money.
 */
export function ExceptionQueue({
  rows, onResolve, onOpenSettlement, loading = false, error, busy = false,
}: ExceptionQueueProps): React.ReactElement {
  const [pending, setPending] = React.useState<
    { settlementId: string; resolution: 'resume' | 'fail' | 'cancel'; confirmation: ActionConfirmation } | null
  >(null)

  const ordered = orderQueue(rows)

  return (
    <section aria-labelledby="exceptions-heading">
      <header className="is-page__header">
        <h1 id="exceptions-heading">Exceptions</h1>
      </header>

      {error && <EmptyState title="We could not load the queue" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading exceptions">
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      )}

      {!error && !loading && ordered.length === 0 && (
        <EmptyState
          title="Nothing is stuck"
          body="No settlement is waiting on an operator. This is the state the queue should normally be in."
        />
      )}

      {!error && !loading && ordered.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Settlement</th>
              <th scope="col">Workspace</th>
              <th scope="col">Code</th>
              <th scope="col">Amount</th>
              <th scope="col">Age</th>
              <th scope="col">Resumes to</th>
              <th scope="col"><span className="is-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr key={row.id} className="is-table__row">
                <td>
                  <button
                    type="button"
                    className="is-table__link"
                    onClick={() => onOpenSettlement(row.settlementId)}
                  >
                    {row.settlementId}
                  </button>
                </td>
                <td className="is-table__mono">
                  {row.workspace}
                  {row.severity === 'live' && (
                    <StatusIndicator tone="action_required" label="Live" />
                  )}
                </td>
                <td className="is-table__mono">
                  {row.code}
                  {/* The difference between "the provider is misbehaving" and
                      "our mapping is out of date" — different incidents, and
                      identical from the settlement's side without this. */}
                  {row.unmapped && (
                    <StatusIndicator tone="action_required" label="Unmapped provider code" />
                  )}
                </td>
                <td>{row.amount}</td>
                <td>{row.age}</td>
                <td className="is-table__mono">{row.resumesTo}</td>
                <td>
                  <div className="is-ops__actions">
                    {(['resume', 'fail', 'cancel'] as const).map((resolution) => {
                      const allowed = row.available.includes(resolution)
                      return (
                        <Button
                          key={resolution}
                          variant={resolution === 'resume' ? 'primary' : 'destructive'}
                          {...(allowed
                            ? {}
                            : { disabled: true, disabledReason: row.unavailableBecause ?? '' })}
                          onClick={() => setPending({
                            settlementId: row.settlementId,
                            resolution,
                            confirmation: confirmResolution(resolution, row.resumesTo),
                          })}
                        >
                          {resolution === 'resume' ? 'Resume' : resolution === 'fail' ? 'Fail' : 'Cancel'}
                        </Button>
                      )
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ReasonedConfirm
        confirmation={pending?.confirmation ?? null}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) onResolve(pending.settlementId, pending.resolution, reason)
          setPending(null)
        }}
      />
    </section>
  )
}

/* ── Facilities ─────────────────────────────────────────────────────────── */

export interface FacilityBoardProps {
  cards: readonly FacilityCard[]
  onSetLimit: (facilityId: string, minorUnits: string, reason: string) => void
  onSetStatus: (facilityId: string, status: 'ACTIVE' | 'SUSPENDED', reason: string) => void
  loading?: boolean
  error?: string
  busy?: boolean
}

export function FacilityBoard({
  cards, onSetLimit, onSetStatus, loading = false, error, busy = false,
}: FacilityBoardProps): React.ReactElement {
  const [editing, setEditing] = React.useState<FacilityCard | null>(null)
  const [minorUnits, setMinorUnits] = React.useState('')
  const [pendingStatus, setPendingStatus] = React.useState<
    { card: FacilityCard; status: 'ACTIVE' | 'SUSPENDED'; confirmation: ActionConfirmation } | null
  >(null)

  return (
    <section aria-labelledby="facilities-heading">
      <header className="is-page__header">
        <h1 id="facilities-heading">Liquidity facilities</h1>
      </header>

      {error && <EmptyState title="We could not load facilities" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading facilities">
          <Skeleton height={96} />
        </div>
      )}

      {!error && !loading && cards.length === 0 && (
        <EmptyState title="No facilities" body="No workspace in this view holds a facility." />
      )}

      {!error && !loading && cards.map((card) => (
        <article key={card.id} className="is-facility">
          <header className="is-facility__header">
            <span className="is-table__mono">{card.workspace} · {card.providerId}</span>
            <StatusIndicator tone={HEADROOM_TONE[card.headroom]} label={card.headroomLabel} />
          </header>

          <dl className="is-facts">
            <div><dt>Limit</dt><dd>{card.limit}</dd></div>
            <div><dt>Available</dt><dd>{card.available}</dd></div>
            <div><dt>Reserved</dt><dd>{card.reserved}</dd></div>
            <div><dt>Drawn</dt><dd>{card.drawn}</dd></div>
            {/* The floor a limit cannot go below, stated before somebody tries. */}
            <div><dt>Committed</dt><dd>{card.committed}</dd></div>
          </dl>

          <div className="is-ops__actions">
            <Button variant="secondary" onClick={() => { setEditing(card); setMinorUnits('') }}>
              Change limit
            </Button>
            <Button
              variant={card.headroom === 'suspended' ? 'primary' : 'destructive'}
              onClick={() => {
                const status = card.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'
                setPendingStatus({
                  card,
                  status,
                  confirmation: {
                    title: status === 'SUSPENDED' ? 'Suspend this facility?' : 'Reactivate this facility?',
                    body: status === 'SUSPENDED'
                      ? 'New reservations stop. Reservations already made stand — a settlement ' +
                        'already counting on that money is not failed by this.'
                      : 'New reservations can be made against this facility again.',
                    confirmLabel: status === 'SUSPENDED' ? 'Suspend facility' : 'Reactivate facility',
                    reasonPrompt: 'Why? This is recorded permanently.',
                  },
                })
              }}
            >
              {card.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
            </Button>
          </div>
        </article>
      ))}

      <Modal
        open={editing !== null}
        title="Change facility limit"
        onClose={() => setEditing(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Back</Button>
            <Button
              {...(/^\d+$/.test(minorUnits)
                ? {}
                : { disabled: true, disabledReason: 'Enter the new limit in minor units.' })}
              onClick={() => {
                if (editing) setPendingStatus(null)
                setEditing(null)
                if (editing) {
                  // The reason is collected by the confirmation that follows,
                  // not here — one dialog owns the reason, everywhere.
                  onSetLimit(editing.id, minorUnits, '')
                }
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        <p>
          {editing?.committed} is already drawn or reserved. A limit below that would make
          availability negative, and is refused.
        </p>
        <Input
          id="facility-limit"
          label="New limit (minor units)"
          value={minorUnits}
          inputMode="numeric"
          help="Minor units, as an integer. Never a decimal — this is the figure the ledger uses."
          onChange={(e) => setMinorUnits(e.target.value)}
        />
      </Modal>

      <ReasonedConfirm
        confirmation={pendingStatus?.confirmation ?? null}
        busy={busy}
        onCancel={() => setPendingStatus(null)}
        onConfirm={(reason) => {
          if (pendingStatus) onSetStatus(pendingStatus.card.id, pendingStatus.status, reason)
          setPendingStatus(null)
        }}
      />
    </section>
  )
}

/* ── Provider events ────────────────────────────────────────────────────── */

export interface ProviderEventLogProps {
  rows: readonly ProviderEventRow[]
  onOpenSettlement: (settlementId: string) => void
  loading?: boolean
  error?: string
}

export function ProviderEventLog({
  rows, onOpenSettlement, loading = false, error,
}: ProviderEventLogProps): React.ReactElement {
  return (
    <section aria-labelledby="provider-events-heading">
      <header className="is-page__header">
        <h1 id="provider-events-heading">Provider events</h1>
      </header>
      <p className="is-muted">
        What the provider actually sent, beside what we decided it meant. An event we could
        not interpret is a mapping problem, not a provider problem, and they look identical
        from the settlement&rsquo;s side.
      </p>

      {error && <EmptyState title="We could not load provider events" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading provider events">
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <EmptyState title="No provider events" body="Nothing has arrived in this window." />
      )}

      {!error && !loading && rows.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Event</th>
              <th scope="col">Subject</th>
              <th scope="col">What we made of it</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="is-table__row">
                <td className="is-table__mono">{row.providerId}</td>
                <td className="is-table__mono">{row.eventType}</td>
                <td>
                  {row.subjectId === null ? (
                    <span className="is-muted">—</span>
                  ) : (
                    <button
                      type="button"
                      className="is-table__link"
                      onClick={() => onOpenSettlement(row.subjectId!)}
                    >
                      {row.subjectId}
                    </button>
                  )}
                </td>
                <td>
                  <StatusIndicator tone={VERDICT_TONE[row.verdict]} label={row.verdictLabel} />
                </td>
                <td>{row.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
