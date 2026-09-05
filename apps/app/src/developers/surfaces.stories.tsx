import type { Meta, StoryObj } from '@storybook/react'
import {
  ApiKeysPanel,
  ApiReferencePanel,
  CreatedSecret,
  DevelopersPage,
  EnvironmentSwitch,
  EventLogPanel,
  RequestLogPanel,
  WebhookEndpointsPanel,
} from './surfaces.js'
import {
  API_KEYS,
  DELIVERIES,
  ENDPOINTS,
  EVENTS,
  EVENT_TYPES,
  EXAMPLES,
  FAILED_REQUESTS,
  REFERENCE_ENDPOINTS,
  REQUESTS,
  REVEALED_KEY,
} from './fixtures.js'

const noop = (): void => {}

/* ── API keys ──────────────────────────────────────────────────────────── */

const keysMeta: Meta<typeof ApiKeysPanel> = {
  title: 'Surfaces/Developers · API keys',
  component: ApiKeysPanel,
  args: { rows: API_KEYS, onCreate: noop, onRevoke: noop },
}
export default keysMeta
type K = StoryObj<typeof ApiKeysPanel>

export const KeysDefault: K = { name: 'Default' }
export const KeysLoading: K = { name: 'Loading', args: { rows: [], loading: true } }
export const KeysEmpty: K = { name: 'Empty', args: { rows: [] } }
export const KeysCreating: K = { name: 'Creating', args: { creating: true } }
export const KeysError: K = {
  name: 'Error',
  args: { rows: [], error: 'The connection dropped while loading this page.' },
}

/* ── The one reveal ────────────────────────────────────────────────────── */

export const SecretRevealed: StoryObj<typeof CreatedSecret> = {
  name: 'Created secret',
  render: () => <CreatedSecret secret={REVEALED_KEY} onClose={noop} />,
}

/* ── Environment ───────────────────────────────────────────────────────── */

export const EnvironmentSandbox: StoryObj<typeof EnvironmentSwitch> = {
  name: 'Environment — sandbox',
  render: () => <EnvironmentSwitch value="sandbox" onChange={noop} />,
}

export const EnvironmentLive: StoryObj<typeof EnvironmentSwitch> = {
  name: 'Environment — live',
  render: () => <EnvironmentSwitch value="live" onChange={noop} />,
}

export const EnvironmentLiveUnavailable: StoryObj<typeof EnvironmentSwitch> = {
  name: 'Environment — live not yet available',
  render: () => (
    <EnvironmentSwitch
      value="sandbox"
      onChange={noop}
      liveAvailableReason="Live opens once your workspace is cleared to settle."
    />
  ),
}

/* ── Webhook endpoints ─────────────────────────────────────────────────── */

const endpointArgs = {
  cards: ENDPOINTS,
  eventTypes: EVENT_TYPES,
  onCreate: noop,
  onSendTest: noop,
  onRotateSecret: noop,
  onReenable: noop,
  onRemove: noop,
}

export const EndpointsDefault: StoryObj<typeof WebhookEndpointsPanel> = {
  name: 'Webhooks — default',
  render: () => <WebhookEndpointsPanel {...endpointArgs} />,
}
export const EndpointsEmpty: StoryObj<typeof WebhookEndpointsPanel> = {
  name: 'Webhooks — empty',
  render: () => <WebhookEndpointsPanel {...endpointArgs} cards={[]} />,
}
export const EndpointsLoading: StoryObj<typeof WebhookEndpointsPanel> = {
  name: 'Webhooks — loading',
  render: () => <WebhookEndpointsPanel {...endpointArgs} cards={[]} loading />,
}
export const EndpointsError: StoryObj<typeof WebhookEndpointsPanel> = {
  name: 'Webhooks — error',
  render: () => (
    <WebhookEndpointsPanel {...endpointArgs} cards={[]} error="We could not reach the API." />
  ),
}

/* ── Request log ───────────────────────────────────────────────────────── */

export const RequestsDefault: StoryObj<typeof RequestLogPanel> = {
  name: 'Request log — default',
  render: () => <RequestLogPanel rows={REQUESTS} filter="all" onFilterChange={noop} />,
}
export const RequestsErrorsOnly: StoryObj<typeof RequestLogPanel> = {
  name: 'Request log — errors only',
  render: () => <RequestLogPanel rows={FAILED_REQUESTS} filter="errors" onFilterChange={noop} />,
}
export const RequestsEmpty: StoryObj<typeof RequestLogPanel> = {
  name: 'Request log — empty',
  render: () => <RequestLogPanel rows={[]} filter="all" onFilterChange={noop} />,
}
export const RequestsLoading: StoryObj<typeof RequestLogPanel> = {
  name: 'Request log — loading',
  render: () => <RequestLogPanel rows={[]} filter="all" onFilterChange={noop} loading />,
}
export const RequestsError: StoryObj<typeof RequestLogPanel> = {
  name: 'Request log — error',
  render: () => (
    <RequestLogPanel rows={[]} filter="all" onFilterChange={noop} error="The connection dropped." />
  ),
}

/* ── Event log ─────────────────────────────────────────────────────────── */

export const EventsDefault: StoryObj<typeof EventLogPanel> = {
  name: 'Event log — default',
  render: () => (
    <EventLogPanel
      rows={EVENTS}
      deliveries={[]}
      expandedEventId={null}
      onExpand={noop}
      onReplay={noop}
    />
  ),
}
export const EventsExpanded: StoryObj<typeof EventLogPanel> = {
  name: 'Event log — attempts expanded',
  render: () => (
    <EventLogPanel
      rows={EVENTS}
      deliveries={DELIVERIES}
      expandedEventId="evt_settled"
      onExpand={noop}
      onReplay={noop}
    />
  ),
}
export const EventsEmpty: StoryObj<typeof EventLogPanel> = {
  name: 'Event log — empty',
  render: () => (
    <EventLogPanel rows={[]} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop} />
  ),
}
export const EventsLoading: StoryObj<typeof EventLogPanel> = {
  name: 'Event log — loading',
  render: () => (
    <EventLogPanel
      rows={[]} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop} loading
    />
  ),
}
export const EventsError: StoryObj<typeof EventLogPanel> = {
  name: 'Event log — error',
  render: () => (
    <EventLogPanel
      rows={[]} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop}
      error="The connection dropped."
    />
  ),
}

/* ── Reference ─────────────────────────────────────────────────────────── */

export const ReferenceDefault: StoryObj<typeof ApiReferencePanel> = {
  name: 'Reference — default',
  render: () => (
    <ApiReferencePanel
      endpoints={REFERENCE_ENDPOINTS}
      examples={EXAMPLES}
      baseUrl="https://api.inrsettle.com"
      apiVersion="2026-08-31"
    />
  ),
}
export const ReferenceEmpty: StoryObj<typeof ApiReferencePanel> = {
  name: 'Reference — unavailable',
  render: () => (
    <ApiReferencePanel
      endpoints={[]}
      examples={[]}
      baseUrl="https://api.inrsettle.com"
      apiVersion="2026-08-31"
    />
  ),
}

/* ── The whole page ────────────────────────────────────────────────────── */

export const PageDefault: StoryObj<typeof DevelopersPage> = {
  name: 'Developers page',
  render: () => (
    <DevelopersPage
      environment="sandbox"
      onEnvironmentChange={noop}
      createdSecret={null}
      onDismissSecret={noop}
      keys={{ rows: API_KEYS, onCreate: noop, onRevoke: noop }}
      endpoints={endpointArgs}
      requests={{ rows: REQUESTS, filter: 'all', onFilterChange: noop }}
      events={{
        rows: EVENTS, deliveries: [], expandedEventId: null, onExpand: noop, onReplay: noop,
      }}
      reference={{
        endpoints: REFERENCE_ENDPOINTS,
        examples: EXAMPLES,
        baseUrl: 'https://api.inrsettle.com',
        apiVersion: '2026-08-31',
      }}
    />
  ),
}
