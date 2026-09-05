import * as React from 'react'
import type { Preview } from '@storybook/react'
import { primitivesCss } from '../packages/ui/src/components/primitives.css.js'

/** The tokens are the source of truth; Storybook renders against the same CSS the app will. */
const Tokens = ({ children }: { children: React.ReactNode }) => (
  <>
    <style>{primitivesCss}</style>
    <div style={{ padding: 24, background: 'var(--color-bg-base)' }}>{children}</div>
  </>
)

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
  decorators: [(Story) => <Tokens><Story /></Tokens>],
}
export default preview
