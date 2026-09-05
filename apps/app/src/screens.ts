/**
 * The five states, at the screen level — Stage 10's fourth exit criterion.
 *
 * *"Loading, empty, error and disabled states exist everywhere and are
 * reviewed."* **Everywhere** is the operative word, and it is what separates
 * this from what `packages/ui` already has.
 *
 * The primitive registry has enforced five states per *component* since Stage 1,
 * and it works: no primitive ships without deciding what it does with nothing to
 * show. But a screen made entirely of components that each handle emptiness
 * correctly can still have no answer for *its own* emptiness — an Overview whose
 * four tiles each render a tidy dash, on a page that never says the workspace is
 * new. Every component passes. The screen has no state at all.
 *
 * So this is the same discipline one level up, with one difference. A primitive
 * names its stories after the states (`Loading`, `Empty`), because a primitive
 * has nothing else to call them. A screen's states have real names — *Day one,
 * no facility*; *Past the point of no return* — and renaming them to `Empty`
 * would make Storybook less readable to the person reviewing it, which is the
 * whole purpose of the criterion. So each state points at the story that
 * demonstrates it, and `screens.test.ts` checks the built Storybook index for
 * that exact story.
 *
 * The reasons matter as much as the states. `SettlementDetail` has no empty
 * state because a settlement you can open is a settlement that exists — writing
 * that down is what stops someone adding a defensive "no settlement found" panel
 * that can only appear when the router is broken.
 */

/** A state either has a story that demonstrates it, or a reason it cannot. */
export type ScreenState = { readonly story: string } | string

export interface ScreenCoverage {
  readonly default: ScreenState
  readonly loading: ScreenState
  readonly empty: ScreenState
  readonly error: ScreenState
  readonly disabled: ScreenState
}

export const SCREEN_STATES = ['default', 'loading', 'empty', 'error', 'disabled'] as const
export type ScreenStateName = (typeof SCREEN_STATES)[number]

/** Keyed by Storybook title, so a screen and its stories cannot drift apart. */
export const SCREENS: Record<string, ScreenCoverage> = {
  'Surfaces/Overview': {
    default: { story: 'A working day' },
    loading: { story: 'Loading' },
    // Day one: a workspace with no facility and nothing sent. The four tiles
    // would each render correctly and the page would still say nothing.
    empty: { story: 'Day one — nothing set up yet' },
    error: { story: 'One figure could not be loaded' },
    disabled:
      'Overview reports rather than accepts input. Its one control is New ' +
      'settlement, which carries its own disabled state and its own reason.',
  },

  'Surfaces/New settlement': {
    default: { story: 'Priced and ready' },
    loading: { story: 'Pricing' },
    empty: { story: 'Empty' },
    error: { story: 'Pricing failed' },
    // The screen is never disabled; the *action* is, with a reason attached
    // that a keyboard user can still reach and read.
    disabled: { story: 'Blocked by preflight' },
  },

  'Surfaces/Settlement detail': {
    default: { story: 'Ready' },
    loading: { story: 'Loading' },
    empty:
      'A settlement you can open is a settlement that exists. There is no empty ' +
      'settlement — a missing one is a routing failure, and answering it here ' +
      'with a panel would hide that.',
    error: { story: 'Not completed' },
    disabled:
      'Nothing here is disabled: an action that no longer applies is removed and ' +
      'replaced by a line saying why (§ 12.3), which is a different and more ' +
      'honest thing than a greyed button.',
  },

  'Surfaces/Beneficiaries list': {
    default: { story: 'Default' },
    loading: { story: 'Loading' },
    empty: { story: 'Empty' },
    error: { story: 'Error' },
    disabled:
      'A list is not a control. Creating a beneficiary is a button with its own ' +
      'states; the list itself has nothing to disable.',
  },

  'Surfaces/Developers · API keys': {
    default: { story: 'Default' },
    loading: { story: 'Loading' },
    empty: { story: 'Empty' },
    error: { story: 'Error' },
    disabled: { story: 'Creating' },
  },
}
