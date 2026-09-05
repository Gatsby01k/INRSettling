/**
 * What the Developers surfaces must actually do.
 *
 * The rules under test are product and security rules, not markup: a secret is
 * shown once and never re-shown, the request log has no bodies, removing an
 * endpoint says the history survives, replay is offered only when replaying is
 * the right thing, and Live says it is Live.
 */
// @vitest-environment jsdom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  ENDPOINT_CIRCUIT_OPEN,
  ENDPOINT_HEALTHY,
  ENDPOINT_REMOVED,
  EVENTS,
  EVENT_TYPES,
  EXAMPLES,
  REFERENCE_ENDPOINTS,
  REQUESTS,
  REVEALED_KEY,
} from './fixtures.js'

afterEach(cleanup)

const noop = (): void => {}

const endpointProps = {
  cards: ENDPOINTS,
  eventTypes: EVENT_TYPES,
  onCreate: noop,
  onSendTest: noop,
  onRotateSecret: noop,
  onReenable: noop,
  onRemove: noop,
}

/* ── API keys ───────────────────────────────────────────────────────────── */

describe('API keys', () => {
  it('shows the prefix and a mask, never a whole key', () => {
    render(<ApiKeysPanel rows={API_KEYS} onCreate={noop} onRevoke={noop} />)
    expect(screen.getByText('sk_live_9f3a••••')).toBeTruthy()
    // A real key is 32 characters of body after the prefix. Nothing on this
    // screen is that long, because the screen has never been given one.
    expect(document.body.textContent).not.toMatch(/sk_(test|live)_[A-Za-z0-9_-]{20,}/)
  })

  it('has no control that re-shows a key', () => {
    render(<ApiKeysPanel rows={API_KEYS} onCreate={noop} onRevoke={noop} />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/reveal|show key|view key/i)
    }
  })

  it('will not create a key without a name, and says why', async () => {
    const onCreate = vi.fn()
    render(<ApiKeysPanel rows={API_KEYS} onCreate={onCreate} onRevoke={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /create key/i }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText('Give the key a name first.')).toBeTruthy()
  })

  it('creates a key with the name typed', async () => {
    const onCreate = vi.fn()
    render(<ApiKeysPanel rows={API_KEYS} onCreate={onCreate} onRevoke={noop} />)
    await userEvent.type(screen.getByLabelText('Name'), 'Ledger sync')
    await userEvent.click(screen.getByRole('button', { name: /create key/i }))
    expect(onCreate).toHaveBeenCalledWith('Ledger sync')
  })

  it('confirms a revoke, names the key, and says it cannot be undone', async () => {
    const onRevoke = vi.fn()
    render(<ApiKeysPanel rows={API_KEYS} onCreate={noop} onRevoke={onRevoke} />)

    const row = screen.getByText('Billing service').closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /revoke/i }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Billing service/)).toBeTruthy()
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy()
    expect(onRevoke).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }))
    expect(onRevoke).toHaveBeenCalledWith('key_live_1')
  })

  it('offers no revoke on an already revoked key', () => {
    render(<ApiKeysPanel rows={API_KEYS} onCreate={noop} onRevoke={noop} />)
    const row = screen.getByText('Old CI runner').closest('tr')!
    expect(within(row).queryByRole('button', { name: /revoke/i })).toBeNull()
  })
})

/* ── The one reveal ─────────────────────────────────────────────────────── */

describe('a newly created secret', () => {
  it('says plainly that this is the only time it is shown', () => {
    render(<CreatedSecret secret={REVEALED_KEY} onClose={noop} />)
    expect(screen.getByText(/only time it is shown/i)).toBeTruthy()
    expect(screen.getByText(REVEALED_KEY.secret)).toBeTruthy()
  })

  it('renders nothing when there is no secret to show', () => {
    render(<CreatedSecret secret={null} onClose={noop} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

/* ── Environment ────────────────────────────────────────────────────────── */

describe('the environment switch', () => {
  it('says out loud when you are looking at Live', () => {
    render(<EnvironmentSwitch value="live" onChange={noop} />)
    expect(screen.getByText(/Requests here move real money/i)).toBeTruthy()
  })

  it('says nothing alarming in Sandbox', () => {
    render(<EnvironmentSwitch value="sandbox" onChange={noop} />)
    expect(screen.queryByText(/real money/i)).toBeNull()
  })

  it('switches on change', async () => {
    const onChange = vi.fn()
    render(<EnvironmentSwitch value="sandbox" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'live')
    expect(onChange).toHaveBeenCalledWith('live')
  })
})

/* ── Webhook endpoints ──────────────────────────────────────────────────── */

describe('webhook endpoints', () => {
  it('explains that selecting nothing subscribes to everything', () => {
    render(<WebhookEndpointsPanel {...endpointProps} />)
    expect(screen.getByText(/Nothing selected sends every event/i)).toBeTruthy()
  })

  it('creates an endpoint with the chosen event types', async () => {
    const onCreate = vi.fn()
    render(<WebhookEndpointsPanel {...endpointProps} onCreate={onCreate} />)

    await userEvent.type(screen.getByLabelText('Endpoint URL'), 'https://example.com/hook')
    await userEvent.click(screen.getByLabelText('settlement.settled'))
    await userEvent.click(screen.getByRole('button', { name: /add endpoint/i }))

    expect(onCreate).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      eventTypes: ['settlement.settled'],
    })
  })

  it('offers re-enabling only on a circuit that opened', () => {
    render(<WebhookEndpointsPanel {...endpointProps} cards={[ENDPOINT_HEALTHY]} />)
    expect(screen.queryByRole('button', { name: /re-enable/i })).toBeNull()

    cleanup()
    render(<WebhookEndpointsPanel {...endpointProps} cards={[ENDPOINT_CIRCUIT_OPEN]} />)
    expect(screen.getByRole('button', { name: /re-enable/i })).toBeTruthy()
    expect(screen.getByText(/Every event is still in the event log/i)).toBeTruthy()
  })

  it('promises the delivery history survives before removing anything', async () => {
    const onRemove = vi.fn()
    render(<WebhookEndpointsPanel {...endpointProps} cards={[ENDPOINT_HEALTHY]} onRemove={onRemove} />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/stays in the event log/i)).toBeTruthy()
    expect(within(dialog).getByText(/not deleted/i)).toBeTruthy()
    expect(onRemove).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove endpoint' }))
    expect(onRemove).toHaveBeenCalledWith(ENDPOINT_HEALTHY.id)
  })

  it('shows a removed endpoint without any action that would send to it', () => {
    render(<WebhookEndpointsPanel {...endpointProps} cards={[ENDPOINT_REMOVED]} />)
    expect(screen.getByText(/Its delivery history is kept/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send a test event/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /rotate/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull()
  })

  it('sends a test event and rotates a secret through their own actions', async () => {
    const onSendTest = vi.fn()
    const onRotateSecret = vi.fn()
    render(
      <WebhookEndpointsPanel
        {...endpointProps} cards={[ENDPOINT_HEALTHY]}
        onSendTest={onSendTest} onRotateSecret={onRotateSecret}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /send a test event/i }))
    await userEvent.click(screen.getByRole('button', { name: /rotate signing secret/i }))
    expect(onSendTest).toHaveBeenCalledWith(ENDPOINT_HEALTHY.id)
    expect(onRotateSecret).toHaveBeenCalledWith(ENDPOINT_HEALTHY.id)
  })
})

/* ── Request log ────────────────────────────────────────────────────────── */

describe('the request log', () => {
  it('says that no bodies are stored, rather than leaving a developer looking', () => {
    render(<RequestLogPanel rows={REQUESTS} filter="all" onFilterChange={noop} />)
    expect(screen.getByText(/We do not store request or response bodies/i)).toBeTruthy()
  })

  it('carries no body content at all', () => {
    render(<RequestLogPanel rows={REQUESTS} filter="all" onFilterChange={noop} />)
    // The fixture rows are real log rows, and a log row has no body field to
    // render. Nothing that looks like an account number can reach this screen.
    expect(document.body.textContent).not.toMatch(/\d{10,}/)
    expect(document.body.textContent).not.toMatch(/beneficiary_id|account_number|ifsc/i)
  })

  it('shows the request id and the error code together, not a bare status', () => {
    render(<RequestLogPanel rows={REQUESTS} filter="all" onFilterChange={noop} />)
    expect(screen.getByText('422 invalid_payout_details')).toBeTruthy()
  })

  it('marks a response that came back from an idempotency key', () => {
    render(<RequestLogPanel rows={REQUESTS} filter="all" onFilterChange={noop} />)
    expect(screen.getByText(/replayed from your idempotency key/i)).toBeTruthy()
  })

  it('says something useful when the error filter finds nothing', () => {
    render(<RequestLogPanel rows={[]} filter="errors" onFilterChange={noop} />)
    expect(screen.getByText('No failed requests')).toBeTruthy()
  })
})

/* ── Event log ──────────────────────────────────────────────────────────── */

describe('the event log', () => {
  it('offers replay for an event that finished trying', () => {
    render(
      <EventLogPanel
        rows={EVENTS} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop}
      />,
    )
    const row = screen.getByText('beneficiary.verified').closest('tr')!
    const replay = within(row).getByRole('button', { name: 'Replay' })
    expect(replay.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('refuses replay while a delivery is still being retried, and says why', () => {
    render(
      <EventLogPanel
        rows={EVENTS} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop}
      />,
    )
    const row = screen.getByText('settlement.ready').closest('tr')!
    expect(within(row).getByRole('button', { name: 'Replay' }).getAttribute('aria-disabled'))
      .toBe('true')
    expect(within(row).getByText(/would send it twice/i)).toBeTruthy()
  })

  it('distinguishes "nobody was listening" from "we could not deliver"', () => {
    render(
      <EventLogPanel
        rows={EVENTS} deliveries={[]} expandedEventId={null} onExpand={noop} onReplay={noop}
      />,
    )
    expect(screen.getByText('No endpoint subscribed')).toBeTruthy()
    expect(screen.getByText('Gave up on 1 endpoint')).toBeTruthy()
  })

  it('shows what the endpoint actually returned, attempt by attempt', () => {
    render(
      <EventLogPanel
        rows={EVENTS} deliveries={DELIVERIES} expandedEventId="evt_settled"
        onExpand={noop} onReplay={noop}
      />,
    )
    expect(screen.getByText('upstream unavailable')).toBeTruthy()
    expect(screen.getByText('Delivered after 2 attempts')).toBeTruthy()
  })

  it('expands and collapses from the keyboard', async () => {
    const onExpand = vi.fn()
    render(
      <EventLogPanel
        rows={EVENTS} deliveries={[]} expandedEventId={null} onExpand={onExpand} onReplay={noop}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'settlement.settled' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(onExpand).toHaveBeenCalledWith('evt_settled')
  })
})

/* ── Reference ──────────────────────────────────────────────────────────── */

describe('the API reference', () => {
  it('carries a copyable example in each of the three languages § 13 names', () => {
    render(
      <ApiReferencePanel
        endpoints={REFERENCE_ENDPOINTS} examples={EXAMPLES}
        baseUrl="https://api.inrsettle.com" apiVersion="2026-08-31"
      />,
    )
    for (const language of ['curl', 'TypeScript', 'Python']) {
      expect(screen.getByRole('tab', { name: language })).toBeTruthy()
    }
  })

  it('copies the example the developer is looking at', async () => {
    const onCopy = vi.fn()
    render(
      <ApiReferencePanel
        endpoints={REFERENCE_ENDPOINTS} examples={EXAMPLES}
        baseUrl="https://api.inrsettle.com" apiVersion="2026-08-31" onCopy={onCopy}
      />,
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Python' }))
    await userEvent.click(screen.getByRole('button', { name: /copy python example/i }))
    expect(onCopy).toHaveBeenCalledWith(EXAMPLES.find((e) => e.language === 'Python')!.code)
  })

  it('states the idempotency rule for every endpoint, because it is per endpoint', () => {
    render(
      <ApiReferencePanel
        endpoints={REFERENCE_ENDPOINTS} examples={EXAMPLES}
        baseUrl="https://api.inrsettle.com" apiVersion="2026-08-31"
      />,
    )
    const row = screen.getByText('POST /v1/settlements').closest('tr')!
    expect(within(row).getByText('Required')).toBeTruthy()
    expect(within(row).getByText(/Returns 202/)).toBeTruthy()
  })
})

/* ── The page ───────────────────────────────────────────────────────────── */

describe('the Developers page', () => {
  const props = {
    environment: 'sandbox' as const,
    onEnvironmentChange: noop,
    createdSecret: null,
    onDismissSecret: noop,
    keys: { rows: API_KEYS, onCreate: noop, onRevoke: noop },
    endpoints: endpointProps,
    requests: { rows: REQUESTS, filter: 'all' as const, onFilterChange: noop },
    events: {
      rows: EVENTS, deliveries: [], expandedEventId: null, onExpand: noop, onReplay: noop,
    },
    reference: {
      endpoints: REFERENCE_ENDPOINTS,
      examples: EXAMPLES,
      baseUrl: 'https://api.inrsettle.com',
      apiVersion: '2026-08-31',
    },
  }

  it('names the environment in the heading, not only in the control', () => {
    render(<DevelopersPage {...props} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Sandbox')

    cleanup()
    render(<DevelopersPage {...props} environment="live" />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Live')
  })

  it('has one tab per § 13 surface', () => {
    render(<DevelopersPage {...props} />)
    for (const label of ['API keys', 'Webhooks', 'Request log', 'Event log', 'Reference']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    }
  })

  it('moves between tabs with the arrow keys', async () => {
    render(<DevelopersPage {...props} />)
    const first = screen.getByRole('tab', { name: 'API keys' })
    first.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Webhooks' }).getAttribute('aria-selected')).toBe('true')
  })
})

/* ── Stage 10 — the § 8 monitoring experience ────────────────────────────── */

describe('DESIGN_SYSTEM.md § 8 — API keys are a desktop task', () => {
  const props: React.ComponentProps<typeof DevelopersPage> = {
    environment: 'sandbox',
    onEnvironmentChange: noop,
    createdSecret: null,
    onDismissSecret: noop,
    keys: { rows: API_KEYS, onCreate: noop, onRevoke: noop },
    endpoints: {
      cards: ENDPOINTS,
      eventTypes: EVENT_TYPES,
      onCreate: noop,
      onSendTest: noop,
      onRotateSecret: noop,
      onReenable: noop,
      onRemove: noop,
    },
    requests: { rows: REQUESTS, filter: 'all', onFilterChange: noop },
    events: {
      rows: EVENTS, deliveries: [], expandedEventId: null, onExpand: noop, onReplay: noop,
    },
    reference: {
      endpoints: REFERENCE_ENDPOINTS,
      examples: EXAMPLES,
      baseUrl: 'https://api.inrsettle.com',
      apiVersion: '2026-08-31',
    },
  }

  const renderPage = (overrides: Partial<React.ComponentProps<typeof DevelopersPage>>) =>
    render(<DevelopersPage {...props} {...overrides} />)

  it('says so plainly below 768px, rather than degrading', () => {
    renderPage({ viewportWidth: 390 })
    expect(screen.getByText('Managing API keys is a desktop task')).toBeTruthy()
    // Not a shrunken key list. § 8: "say so plainly rather than degrading".
    expect(screen.queryByRole('button', { name: /Create.*key/i })).toBeNull()
  })

  it('withholds a revealed secret there too', () => {
    // The reason the tab is desktop-only in the first place: a new key is shown
    // once and never again, so showing it where it cannot be copied safely
    // wastes the only moment it exists.
    renderPage({ viewportWidth: 390, createdSecret: REVEALED_KEY })
    expect(document.body.textContent).not.toContain(REVEALED_KEY.secret)
  })

  it('keeps the monitoring tabs, which are what § 8 says a phone is for', () => {
    renderPage({ viewportWidth: 390 })
    for (const tab of ['Request log', 'Event log', 'Reference', 'Webhooks']) {
      expect(screen.getByRole('tab', { name: tab })).toBeTruthy()
    }
  })

  it('shows the real panel at 768px and above', () => {
    renderPage({ viewportWidth: 768 })
    expect(screen.queryByText('Managing API keys is a desktop task')).toBeNull()
  })

  it('does not degrade when the viewport was never measured', () => {
    // Undefined is "not measured", and a missing measurement is not a small
    // screen. Defaulting the other way would hide the tab in every environment
    // that does not report a width — including the tests of everything else.
    renderPage({})
    expect(screen.queryByText('Managing API keys is a desktop task')).toBeNull()
  })
})
