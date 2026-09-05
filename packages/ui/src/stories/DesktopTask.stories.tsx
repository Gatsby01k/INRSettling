import type { Meta, StoryObj } from '@storybook/react'
import { Button } from '../components/index.js'
import { DesktopTask } from '../components/overview.js'

const meta: Meta<typeof DesktopTask> = {
  title: 'Primitives/DesktopTask',
  component: DesktopTask,
  args: { task: 'csv_import' },
  parameters: {
    docs: {
      description: {
        component:
          '`DESIGN_SYSTEM.md § 8`, the `<768px` monitoring experience: creating a batch, managing API keys and ' +
          'CSV import *"are desktop tasks and say so plainly rather than degrading"*. The easy thing is the wrong ' +
          'one — a responsive form that technically works at 360px, an API-key screen where the secret is shown ' +
          'once and cannot be copied — because that wastes the one moment the secret is visible.',
      },
    },
  },
}
export default meta
type S = StoryObj<typeof DesktopTask>

/** The state stories keep the state names; the extras below have real ones. */
export const Default: S = {}

export const Loading: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: there is nothing to load. The message is decided by the viewport, which is known before ' +
          'any request — and a spinner would imply the task might become available if you waited.',
      },
    },
  },
}

export const Empty: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: this component *is* the substitute for an absent surface, so an empty state of it would ' +
          'be an absence of an absence.',
      },
    },
  },
}

export const Error: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: nothing here can fail. Saying a screen is desktop-only is a statement about this device, ' +
          'not the result of an operation.',
      },
    },
  },
}

export const Disabled: S = {
  parameters: {
    docs: {
      description: {
        story:
          'Not applicable: it offers no control to disable. Its optional alternative is an ordinary element and ' +
          'carries its own states.',
      },
    },
  },
}

export const ApiKeys: S = {
  name: 'API keys',
  args: { task: 'api_keys' },
}

export const WithAlternative: S = {
  name: 'Batches, with what you can do here',
  args: {
    task: 'batch_create',
    alternative: <Button variant="secondary">See batches you already created</Button>,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Reading a batch is one of the four things § 8 says the phone does well. So the message names the task ' +
          'that needs a computer and then offers the part that does not.',
      },
    },
  },
}
