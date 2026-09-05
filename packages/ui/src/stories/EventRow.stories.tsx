import type { Meta, StoryObj } from '@storybook/react'
import { EventRow } from '../components/overview.js'

/** A row is a `<tr>`; Storybook needs the table around it for valid markup. */
function Table({ children }: { children: React.ReactNode }) {
  return (
    <table className="is-table" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Delivery</th>
          <th scope="col">At</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

const meta: Meta<typeof EventRow> = {
  title: 'Primitives/EventRow',
  component: EventRow,
  args: {
    id: 'evt_01JBQ8Z3N7',
    type: 'settlement.settled',
    at: '2026-03-11T09:42:17Z',
    delivery: { tone: 'settled', label: 'Delivered' },
  },
  render: (args) => (
    <Table>
      <EventRow {...args} />
    </Table>
  ),
}
export default meta
type S = StoryObj<typeof EventRow>

export const Default: S = {}

export const Loading: S = {
  args: { entering: true },
  parameters: {
    docs: {
      description: {
        story:
          'A row does not load — it arrives. § 6 permits exactly one animation here: *“new rows slide 4px and fade in over 180ms. No bounce.”* ' +
          '`entering` is set by the caller rather than detected, because a component that animated on mount would animate the whole list on every navigation.',
      },
    },
  },
}

export const Empty: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: a row is one event. A log with no events renders an `EmptyState` instead of a row saying it is not there.',
      },
    },
  },
}

export const Error: S = {
  args: {
    type: 'settlement.settled',
    delivery: { tone: 'action_required', label: 'Failed — 4 attempts' },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Not an error state of the row. An event that failed to deliver is a *delivery* state on a real row — which is the distinction the log exists to make: ' +
          'the event happened, the delivery did not. Tone plus label, never colour alone (§ 7).',
      },
    },
  },
}

export const Disabled: S = {
  // No `onSelect` at all, rather than an `onSelect` set to undefined — which
  // `exactOptionalPropertyTypes` rightly refuses, and which is the same
  // distinction the component makes.
  render: () => (
    <Table>
      <EventRow
        id="evt_01JBQ8Z3N7"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
      />
    </Table>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'A row with no `onSelect` renders its type as plain text rather than a dead button. The row is still readable; it is simply not a control.',
      },
    },
  },
}

export const Expandable: S = {
  args: {
    onSelect: () => {},
    expanded: true,
    children: (
      <pre className="is-table__mono" style={{ margin: 0 }}>
        {JSON.stringify(
          { id: 'evt_01JBQ8Z3N7', type: 'settlement.settled', data: { object: 'settlement' } },
          null,
          2,
        )}
      </pre>
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          'The payload is disclosed on demand under `aria-expanded`, not printed into every row.',
      },
    },
  },
}

export const Log: S = {
  render: () => (
    <Table>
      <EventRow
        id="evt_01JBQ8Z3N9"
        type="settlement.settled"
        at="2026-03-11T09:42:17Z"
        delivery={{ tone: 'settled', label: 'Delivered' }}
        entering
      />
      <EventRow
        id="evt_01JBQ8Z3N8"
        type="settlement.settling"
        at="2026-03-11T09:31:02Z"
        delivery={{ tone: 'settling', label: 'Retrying — attempt 2' }}
      />
      <EventRow
        id="evt_01JBQ8Z3N7"
        type="settlement.created"
        at="2026-03-11T09:30:55Z"
        delivery={{ tone: 'action_required', label: 'Failed — 4 attempts' }}
      />
    </Table>
  ),
}
