/**
 * The Stage 8 Developers surfaces — `PRODUCT.md § 13`.
 *
 * > Sandbox and Live environments · API keys · webhook endpoints and signing
 * > secrets · request logs · event logs · replay and test-webhook actions · API
 * > reference · copyable examples in curl, TypeScript and Python.
 *
 * Presentational, like every other surface in this app: they take view models
 * and callbacks, so every state renders in Storybook and is asserted in a test
 * without a database.
 *
 * Three product rules do most of the work here, and all three are `SECURITY.md`:
 *
 * **A secret appears once.** `CreatedSecret` is the only component in this file
 * that renders a secret, it is only reachable from a create or rotate action,
 * and every list renders the searchable prefix. There is no "show key" control
 * anywhere, because a screen that can re-show a secret is a screen that puts it
 * in a screenshot and a support ticket.
 *
 * **The environment is stated, not inferred.** A developer with two tabs open
 * has one on Sandbox and one on Live, and the difference between them is
 * whether money moves. It is a control at the top of the page, and it is in the
 * page heading.
 *
 * **The request log holds no bodies.** Not "we truncate them" — there are none.
 * A settlement request body carries beneficiary details, and § 8 does not stop
 * applying because the log has a UI.
 *
 * Stage 10 is the polish pass. This is the working surface: real states, real
 * copy, real keyboard behaviour, no visual tuning beyond what the design system
 * already gives.
 */
import * as React from 'react'
import {
  Button,
  EmptyState,
  Input,
  Modal,
  Reference,
  Select,
  Skeleton,
  StatusIndicator,
  DesktopTask,
  isDesktopTaskAvailable,
  Tabs,
} from '@inrsettle/ui'
import type { StatusTone } from '@inrsettle/ui'
import type {
  ApiKeyRow,
  DeliveryView,
  EventLogRow,
  RequestLogRow,
  RevealedSecret,
  WebhookEndpointCard,
} from './view-models.js'

/* ── Tones ──────────────────────────────────────────────────────────────── */

/**
 * The five `DESIGN_SYSTEM.md` tones, applied to states that are not settlement
 * states.
 *
 * Written as tables rather than nested ternaries so that adding a state to a
 * view model is a type error here rather than a silently grey badge. The view
 * models name the state; this file is the only place that decides its colour.
 */
const API_KEY_TONE: Record<ApiKeyRow['state'], StatusTone> = {
  active: 'settled',
  unused: 'ready',
  revoked: 'cancelled',
}

const ENDPOINT_TONE: Record<WebhookEndpointCard['health'], StatusTone> = {
  healthy: 'settled',
  failing: 'settling',
  circuit_open: 'action_required',
  disabled: 'cancelled',
  deleted: 'cancelled',
}

const REQUEST_TONE: Record<RequestLogRow['outcome'], StatusTone> = {
  ok: 'settled',
  client_error: 'action_required',
  server_error: 'action_required',
}

const DELIVERY_TONE: Record<EventLogRow['delivery'], StatusTone> = {
  delivered: 'settled',
  sending: 'settling',
  gave_up: 'action_required',
  unsubscribed: 'ready',
}

/* ─────────────────────────────────────────────────── Environment switch ──── */

export type DeveloperEnvironment = 'sandbox' | 'live'

export interface EnvironmentSwitchProps {
  value: DeveloperEnvironment
  onChange: (next: DeveloperEnvironment) => void
  /** A workspace not yet cleared to settle cannot be switched into Live. */
  liveAvailableReason?: string
}

/**
 * Which environment everything below is about.
 *
 * A `<select>` rather than a toggle: a toggle reads as "on/off", and neither of
 * these is off. The label says the word out loud so the answer is never
 * inferred from a colour.
 */
export function EnvironmentSwitch({
  value, onChange, liveAvailableReason,
}: EnvironmentSwitchProps): React.ReactElement {
  return (
    <div className="is-developers__environment">
      <Select
        id="developer-environment"
        label="Environment"
        value={value}
        options={[
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'live', label: 'Live' },
        ]}
        onChange={(e) => onChange(e.target.value as DeveloperEnvironment)}
      />
      {liveAvailableReason !== undefined && (
        <p className="is-field__help">{liveAvailableReason}</p>
      )}
      {value === 'live' && (
        <p className="is-callout" role="note">
          You are looking at Live. Requests here move real money.
        </p>
      )}
    </div>
  )
}

/* ───────────────────────────────────────────────────── The one reveal ──── */

export interface CreatedSecretProps {
  secret: RevealedSecret | null
  onClose: () => void
  onCopy?: (value: string) => void
}

/**
 * The only place a secret is on screen, and it says so.
 *
 * Closing is the only way out on purpose — there is no "remind me later",
 * because there is no later.
 */
export function CreatedSecret({ secret, onClose, onCopy }: CreatedSecretProps): React.ReactElement {
  return (
    <Modal
      open={secret !== null}
      title={secret?.title ?? ''}
      onClose={onClose}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {secret && (
        <>
          <p>{secret.warning}</p>
          <Reference value={secret.secret} label="Secret" {...(onCopy ? { onCopy } : {})} />
        </>
      )}
    </Modal>
  )
}

/* ───────────────────────────────────────────────────────────── API keys ──── */

export interface ApiKeysPanelProps {
  rows: readonly ApiKeyRow[]
  onCreate: (name: string) => void
  onRevoke: (id: string) => void
  creating?: boolean
  loading?: boolean
  error?: string
}

export function ApiKeysPanel({
  rows, onCreate, onRevoke, creating = false, loading = false, error,
}: ApiKeysPanelProps): React.ReactElement {
  const [name, setName] = React.useState('')
  const [confirming, setConfirming] = React.useState<ApiKeyRow | null>(null)

  return (
    <section aria-labelledby="api-keys-heading">
      <header className="is-page__subheader">
        <h2 id="api-keys-heading">API keys</h2>
      </header>

      <form
        className="is-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() === '') return
          onCreate(name.trim())
          setName('')
        }}
      >
        <Input
          id="api-key-name"
          label="Name"
          value={name}
          placeholder="Billing service"
          help="A name you will recognise in six months, when you are deciding whether it is safe to revoke."
          onChange={(e) => setName(e.target.value)}
        />
        <div className="is-form__actions">
          <Button type="submit" loading={creating} {...(name.trim() === ''
            ? { disabled: true, disabledReason: 'Give the key a name first.' }
            : {})}
          >
            Create key
          </Button>
        </div>
      </form>

      {error && (
        <EmptyState title="We could not load your API keys" body={error} />
      )}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading API keys">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <EmptyState
          title="No API keys yet"
          body="Create one to start calling the API. The key is shown once, at creation."
        />
      )}

      {!error && !loading && rows.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Key</th>
              <th scope="col">Environment</th>
              <th scope="col">Scopes</th>
              <th scope="col">Status</th>
              <th scope="col">Last used</th>
              <th scope="col"><span className="is-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="is-table__row">
                <td>{row.name}</td>
                <td className="is-table__mono">{row.masked}</td>
                <td>{row.environmentLabel}</td>
                <td>{row.scopeSummary}</td>
                <td>
                  <StatusIndicator tone={API_KEY_TONE[row.state]} label={row.stateLabel} />
                </td>
                <td>{row.lastUsedLabel}</td>
                <td>
                  {row.state !== 'revoked' && (
                    <Button variant="destructive" onClick={() => setConfirming(row)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Revoking is instant and irreversible, and the thing it breaks is
          somebody's running integration. The confirmation names the key. */}
      <Modal
        open={confirming !== null}
        title="Revoke this key?"
        onClose={() => setConfirming(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>Keep it</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming) onRevoke(confirming.id)
                setConfirming(null)
              }}
            >
              Revoke key
            </Button>
          </>
        }
      >
        <p>
          {confirming?.name} stops working immediately, and every request using it will get
          <code> 401 invalid_api_key</code>. This cannot be undone — if you need it back, create a
          new key.
        </p>
      </Modal>
    </section>
  )
}

/* ────────────────────────────────────────────────── Webhook endpoints ──── */

export interface WebhookEndpointsPanelProps {
  cards: readonly WebhookEndpointCard[]
  eventTypes: readonly string[]
  onCreate: (input: { url: string; eventTypes: readonly string[] }) => void
  onSendTest: (id: string) => void
  onRotateSecret: (id: string) => void
  onReenable: (id: string) => void
  onRemove: (id: string) => void
  creating?: boolean
  loading?: boolean
  error?: string
}

export function WebhookEndpointsPanel({
  cards, eventTypes, onCreate, onSendTest, onRotateSecret, onReenable, onRemove,
  creating = false, loading = false, error,
}: WebhookEndpointsPanelProps): React.ReactElement {
  const [url, setUrl] = React.useState('')
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [removing, setRemoving] = React.useState<WebhookEndpointCard | null>(null)

  const toggle = (type: string): void => {
    setSelected((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type])
  }

  return (
    <section aria-labelledby="endpoints-heading">
      <header className="is-page__subheader">
        <h2 id="endpoints-heading">Webhook endpoints</h2>
      </header>

      <form
        className="is-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim() === '') return
          onCreate({ url: url.trim(), eventTypes: selected })
          setUrl('')
          setSelected([])
        }}
      >
        <Input
          id="endpoint-url"
          label="Endpoint URL"
          value={url}
          placeholder="https://example.com/hooks/inrsettle"
          help="We send a signed POST here. HTTPS only."
          onChange={(e) => setUrl(e.target.value)}
        />

        <fieldset className="is-fieldset">
          <legend>Events</legend>
          {/* No selection means every customer event, which is what most
              integrations want and what an empty list already means in the
              API. Saying so beats making them tick twenty boxes. */}
          <p className="is-field__help">
            {selected.length === 0
              ? 'Nothing selected sends every event. Choose some to narrow it.'
              : `${selected.length} selected.`}
          </p>
          <ul className="is-checklist">
            {eventTypes.map((type) => (
              <li key={type}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(type)}
                    onChange={() => toggle(type)}
                  />
                  <span className="is-table__mono">{type}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="is-form__actions">
          <Button type="submit" loading={creating} {...(url.trim() === ''
            ? { disabled: true, disabledReason: 'Add the URL we should send to.' }
            : {})}
          >
            Add endpoint
          </Button>
        </div>
      </form>

      {error && <EmptyState title="We could not load your endpoints" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading endpoints">
          <Skeleton height={72} />
          <Skeleton height={72} />
        </div>
      )}

      {!error && !loading && cards.length === 0 && (
        <EmptyState
          title="No endpoints yet"
          body="Add one and we will send you every settlement, beneficiary and batch event as it happens, signed so you can verify it came from us."
        />
      )}

      {!error && !loading && cards.map((card) => (
        <article key={card.id} className="is-endpoint">
          <header className="is-endpoint__header">
            <span className="is-table__mono">{card.url}</span>
            <StatusIndicator tone={ENDPOINT_TONE[card.health]} label={card.healthLabel} />
          </header>

          {card.description && <p>{card.description}</p>}
          <p className="is-muted">{card.subscriptionLabel}</p>

          {card.attention && (
            <div className="is-callout" role="note">
              <strong>{card.attention.title}</strong>
              <p>{card.attention.detail}</p>
            </div>
          )}

          <div className="is-endpoint__actions">
            {card.health === 'deleted' ? (
              <p className="is-muted">
                Removed. Its delivery history is kept and is still in the event log below.
              </p>
            ) : (
              <>
                <Button variant="secondary" onClick={() => onSendTest(card.id)}>
                  Send a test event
                </Button>
                <Button variant="secondary" onClick={() => onRotateSecret(card.id)}>
                  Rotate signing secret
                </Button>
                {card.health === 'circuit_open' && (
                  <Button onClick={() => onReenable(card.id)}>{card.attention?.action ?? 'Re-enable'}</Button>
                )}
                <Button variant="destructive" onClick={() => setRemoving(card)}>Remove</Button>
              </>
            )}
          </div>
        </article>
      ))}

      <Modal
        open={removing !== null}
        title="Remove this endpoint?"
        onClose={() => setRemoving(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing) onRemove(removing.id)
                setRemoving(null)
              }}
            >
              Remove endpoint
            </Button>
          </>
        }
      >
        <p>
          We stop sending to {removing?.url} immediately. Everything we already tried to send stays
          in the event log, so you can still see what happened — that history is not deleted.
        </p>
      </Modal>
    </section>
  )
}

/* ───────────────────────────────────────────────────────── Request log ──── */

export interface RequestLogPanelProps {
  rows: readonly RequestLogRow[]
  filter: 'all' | 'errors'
  onFilterChange: (next: 'all' | 'errors') => void
  loading?: boolean
  error?: string
}

export function RequestLogPanel({
  rows, filter, onFilterChange, loading = false, error,
}: RequestLogPanelProps): React.ReactElement {
  return (
    <section aria-labelledby="requests-heading">
      <header className="is-page__subheader">
        <h2 id="requests-heading">Request log</h2>
        <Select
          id="request-filter"
          label="Show"
          value={filter}
          options={[
            { value: 'all', label: 'All requests' },
            { value: 'errors', label: 'Errors only' },
          ]}
          onChange={(e) => onFilterChange(e.target.value as 'all' | 'errors')}
        />
      </header>

      {/* Said on the screen, not only in the security model, because a
          developer looking for their request body needs to know it is not
          coming rather than to keep looking. */}
      <p className="is-muted">
        Method, path, status and timing. We do not store request or response bodies — a
        settlement body carries your beneficiary&rsquo;s account details, and a log is not an
        exception to that.
      </p>

      {error && <EmptyState title="We could not load your requests" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading requests">
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <EmptyState
          title={filter === 'errors' ? 'No failed requests' : 'No requests yet'}
          body={
            filter === 'errors'
              ? 'Nothing has failed in this window. Switch to all requests to see what has been coming in.'
              : 'Your first API call will appear here, with its request id.'
          }
        />
      )}

      {!error && !loading && rows.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Result</th>
              <th scope="col">Time</th>
              <th scope="col">Request id</th>
              <th scope="col">At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.requestId} className="is-table__row">
                <td className="is-table__mono">{row.summary}</td>
                <td>
                  <StatusIndicator tone={REQUEST_TONE[row.outcome]} label={row.outcomeLabel} />
                  {row.replayed && (
                    <span className="is-muted"> · replayed from your idempotency key</span>
                  )}
                </td>
                <td>{row.durationLabel}</td>
                <td>
                  {/* The one value support will ask for. Copyable, always. */}
                  <Reference value={row.requestId} label="Request id" truncate />
                </td>
                <td>{row.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ─────────────────────────────────────────────────────────── Event log ──── */

export interface EventLogPanelProps {
  rows: readonly EventLogRow[]
  /** The deliveries for the expanded event, if one is expanded. */
  deliveries: readonly DeliveryView[]
  expandedEventId: string | null
  onExpand: (eventId: string | null) => void
  onReplay: (eventId: string) => void
  loading?: boolean
  error?: string
}

export function EventLogPanel({
  rows, deliveries, expandedEventId, onExpand, onReplay, loading = false, error,
}: EventLogPanelProps): React.ReactElement {
  return (
    <section aria-labelledby="events-heading">
      <header className="is-page__subheader">
        <h2 id="events-heading">Event log</h2>
      </header>

      {error && <EmptyState title="We could not load your events" body={error} />}

      {!error && loading && (
        <div role="status" aria-busy="true" aria-label="Loading events">
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <EmptyState
          title="No events yet"
          body="Every settlement, beneficiary and batch event lands here, whether or not you have an endpoint listening."
        />
      )}

      {!error && !loading && rows.length > 0 && (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Delivery</th>
              <th scope="col">At</th>
              <th scope="col"><span className="is-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className="is-table__row">
                  <td>
                    <button
                      type="button"
                      className="is-table__link"
                      aria-expanded={expandedEventId === row.id}
                      onClick={() => onExpand(expandedEventId === row.id ? null : row.id)}
                    >
                      {row.type}
                    </button>
                  </td>
                  <td><StatusIndicator tone={DELIVERY_TONE[row.delivery]} label={row.deliveryLabel} /></td>
                  <td>{row.at}</td>
                  <td>
                    <Button
                      variant="secondary"
                      {...(row.canReplay
                        ? {}
                        : {
                          disabled: true,
                          disabledReason: 'We are still trying to deliver this one. Replaying now would send it twice.',
                        })}
                      onClick={() => onReplay(row.id)}
                    >
                      Replay
                    </Button>
                  </td>
                </tr>

                {expandedEventId === row.id && (
                  <tr>
                    <td colSpan={4}>
                      {deliveries.length === 0 && (
                        <p className="is-muted">
                          No endpoint was subscribed to this event when it happened. Adding one
                          now and replaying will deliver it.
                        </p>
                      )}
                      {deliveries.map((delivery) => (
                        <article key={delivery.id} className="is-delivery">
                          <header className="is-delivery__header">
                            <span className="is-table__mono">{delivery.endpointUrl}</span>
                            <span>{delivery.originLabel}</span>
                            <span>{delivery.stateLabel}</span>
                          </header>
                          <ol className="is-delivery__attempts">
                            {delivery.attempts.map((attempt) => (
                              <li key={attempt.label}>
                                <span>{attempt.label}</span>
                                <span className="is-table__mono"> {attempt.outcome} </span>
                                {/* What their server said, verbatim. They are
                                    debugging their own code. */}
                                <code>{attempt.detail}</code>
                              </li>
                            ))}
                          </ol>
                        </article>
                      ))}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ─────────────────────────────────────────────────────────── Reference ──── */

export interface CodeExample {
  /** `curl`, `TypeScript`, `Python` — the three `PRODUCT.md § 13` names. */
  readonly language: string
  readonly code: string
}

export interface ReferenceEndpoint {
  readonly method: string
  readonly path: string
  readonly summary: string
  readonly idempotency: string
  readonly scope: string
}

export interface ApiReferencePanelProps {
  endpoints: readonly ReferenceEndpoint[]
  examples: readonly CodeExample[]
  baseUrl: string
  apiVersion: string
  onCopy?: (value: string) => void
}

export function ApiReferencePanel({
  endpoints, examples, baseUrl, apiVersion, onCopy,
}: ApiReferencePanelProps): React.ReactElement {
  return (
    <section aria-labelledby="reference-heading">
      <header className="is-page__subheader">
        <h2 id="reference-heading">API reference</h2>
      </header>

      <dl className="is-facts">
        <div>
          <dt>Base URL</dt>
          <dd><Reference value={baseUrl} label="Base URL" {...(onCopy ? { onCopy } : {})} /></dd>
        </div>
        <div>
          <dt>API version</dt>
          <dd><Reference value={apiVersion} label="API version" {...(onCopy ? { onCopy } : {})} /></dd>
        </div>
      </dl>

      <Tabs
        id="reference-examples"
        label="Copyable examples"
        items={examples.map((example) => ({
          id: example.language,
          label: example.language,
          content: (
            <div className="is-example">
              <pre><code>{example.code}</code></pre>
              <Button variant="secondary" onClick={() => onCopy?.(example.code)}>
                Copy {example.language} example
              </Button>
            </div>
          ),
        }))}
        emptyLabel="Examples are being prepared."
      />

      {endpoints.length === 0 ? (
        <EmptyState title="The reference is not available" body="Try again in a moment." />
      ) : (
        <table className="is-table">
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col">What it does</th>
              <th scope="col">Idempotency</th>
              <th scope="col">Scope</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`} className="is-table__row">
                <td className="is-table__mono">{endpoint.method} {endpoint.path}</td>
                <td>{endpoint.summary}</td>
                <td>{endpoint.idempotency}</td>
                <td className="is-table__mono">{endpoint.scope}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────── Page ──── */

export interface DevelopersPageProps {
  environment: DeveloperEnvironment
  onEnvironmentChange: (next: DeveloperEnvironment) => void
  liveAvailableReason?: string
  createdSecret: RevealedSecret | null
  onDismissSecret: () => void
  keys: ApiKeysPanelProps
  endpoints: WebhookEndpointsPanelProps
  requests: RequestLogPanelProps
  events: EventLogPanelProps
  reference: ApiReferencePanelProps
  /**
   * Viewport width, for the `DESIGN_SYSTEM.md § 8` monitoring experience.
   *
   * Below 768px, API-key management is one of the three tasks § 8 names as
   * desktop and requires to *"say so plainly rather than degrading"*. This tab
   * in particular: a new key is *"shown once and never again"*, so a phone-sized
   * version of it would waste the one moment the secret is visible.
   *
   * Everything else on the page — reading the request log, the event log, the
   * reference — is monitoring, which is exactly what § 8 says the phone is for.
   * So the guard is on the one tab rather than the page.
   */
  viewportWidth?: number
}

/**
 * The Developers page, one tab per § 13 surface.
 *
 * The environment switch is above the tabs rather than inside one, because it
 * changes what every tab is about. A switch that lived in "API keys" would let
 * a developer read a Live request log while the page still said Sandbox.
 */
export function DevelopersPage({
  environment, onEnvironmentChange, liveAvailableReason,
  createdSecret, onDismissSecret,
  keys, endpoints, requests, events, reference,
  viewportWidth,
}: DevelopersPageProps): React.ReactElement {
  // Undefined means "not measured", which must not silently degrade the page.
  // A missing measurement is not a small screen.
  const keysAvailable =
    viewportWidth === undefined || isDesktopTaskAvailable(viewportWidth)
  return (
    <section aria-labelledby="developers-heading">
      <header className="is-page__header">
        <h1 id="developers-heading">
          Developers · {environment === 'live' ? 'Live' : 'Sandbox'}
        </h1>
        <EnvironmentSwitch
          value={environment}
          onChange={onEnvironmentChange}
          {...(liveAvailableReason !== undefined ? { liveAvailableReason } : {})}
        />
      </header>

      {keysAvailable && <CreatedSecret secret={createdSecret} onClose={onDismissSecret} />}

      <Tabs
        id="developers"
        label="Developer surfaces"
        items={[
          {
            id: 'keys',
            label: 'API keys',
            content: keysAvailable ? <ApiKeysPanel {...keys} /> : <DesktopTask task="api_keys" />,
          },
          { id: 'endpoints', label: 'Webhooks', content: <WebhookEndpointsPanel {...endpoints} /> },
          { id: 'requests', label: 'Request log', content: <RequestLogPanel {...requests} /> },
          { id: 'events', label: 'Event log', content: <EventLogPanel {...events} /> },
          { id: 'reference', label: 'Reference', content: <ApiReferencePanel {...reference} /> },
        ]}
      />
    </section>
  )
}
