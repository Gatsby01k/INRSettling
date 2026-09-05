/**
 * Overview — the command centre described in `PRODUCT.md § 12.1`.
 *
 * The screen is short on purpose. Four metrics, then active settlements, then
 * open exceptions. What is *not* here is the specification: no chart, no
 * comparison to yesterday, no "welcome back", no fifth number. The view model
 * gives this file four named metric slots and no array to grow, so the
 * restraint survives whoever edits it next.
 */
import * as React from 'react'
import {
  AmountDisplay, Button, EmptyState, MetricTile, Skeleton, StatusIndicator,
} from '@inrsettle/ui'
import { money } from '@inrsettle/money'
import type { SettlementRow } from '../settlements/view-models.js'
import { metricList, type MetricView, type OverviewPresentation } from './view-models.js'

export interface OverviewProps {
  presentation: OverviewPresentation
  onOpenSettlement: (id: string) => void
  onNewSettlement: () => void
  /** Followed for a metric's action; a real router replaces this. */
  onNavigate?: (href: string) => void
  loading?: boolean
  /**
   * A figure that could not be loaded, by metric label.
   *
   * Per-metric rather than per-page: an Overview whose facility figure timed
   * out should still tell someone what is in flight. Replacing the whole screen
   * with one error is how a page becomes less useful than no page.
   */
  errors?: Readonly<Record<string, string>>
}

export function Overview({
  presentation, onOpenSettlement, onNewSettlement, onNavigate,
  loading = false, errors = {},
}: OverviewProps): React.ReactElement {
  const metrics = metricList(presentation)

  return (
    <section className="is-overview" aria-labelledby="overview-heading">
      <header className="is-page__header">
        {/* Not a hero. The heading names the page and the one action creates
            the thing the page is about. */}
        <h1 id="overview-heading">Overview</h1>
        <Button variant="primary" onClick={onNewSettlement}>New settlement</Button>
      </header>

      <div className="is-overview__metrics" role="group" aria-label="Workspace summary">
        {metrics.map((m) => (
          <MetricTile
            key={m.label}
            label={m.label}
            value={loading ? null : m.value}
            context={m.context}
            loading={loading}
            {...(errors[m.label] ? { error: errors[m.label]! } : {})}
            {...(m.action && onNavigate
              ? { action: { label: m.action.label, onSelect: () => onNavigate(m.action!.href) } }
              : {})}
          />
        ))}
      </div>

      {presentation.emptyMessage ? (
        <EmptyState
          title="Nothing yet"
          body={presentation.emptyMessage}
          action={<Button onClick={onNewSettlement}>New settlement</Button>}
        />
      ) : (
        <>
          {/* Exceptions above active settlements: this is the section that
              answers "what needs my attention", and burying it under a longer
              list would answer it last. */}
          {presentation.openExceptions.length > 0 && (
            <SettlementSection
              id="overview-exceptions"
              title="Needs your attention"
              rows={presentation.openExceptions}
              onOpen={onOpenSettlement}
              loading={loading}
            />
          )}

          <SettlementSection
            id="overview-active"
            title="Active settlements"
            rows={presentation.activeSettlements}
            onOpen={onOpenSettlement}
            loading={loading}
            emptyBody="Nothing is moving right now."
          />
        </>
      )}
    </section>
  )
}

interface SettlementSectionProps {
  id: string
  title: string
  rows: readonly SettlementRow[]
  onOpen: (id: string) => void
  loading: boolean
  emptyBody?: string
}

function SettlementSection({
  id, title, rows, onOpen, loading, emptyBody,
}: SettlementSectionProps): React.ReactElement {
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="is-section__title">{title}</h2>

      {loading ? (
        <div role="status" aria-busy="true" aria-label={`Loading ${title.toLowerCase()}`}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : rows.length === 0 ? (
        emptyBody ? <EmptyState title="Nothing here" body={emptyBody} /> : <></>
      ) : (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Beneficiary</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="is-table__row">
                <td>
                  <button
                    type="button"
                    className="is-table__link"
                    onClick={() => onOpen(row.id)}
                  >
                    {row.beneficiaryName}
                  </button>
                </td>
                <td className="is-table__num">
                  <AmountDisplay
                    amount={money('INR', row.recipientAmountMinor)}
                    size="compact"
                  />
                </td>
                <td>
                  {row.presentation.badge && (
                    <StatusIndicator
                      tone={row.presentation.badge.tone}
                      label={row.presentation.badge.label}
                      {...(row.presentation.badge.detail
                        ? { detail: row.presentation.badge.detail }
                        : {})}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Exported for the state-coverage gate; see `screen-states.ts`. */
export type { MetricView }
