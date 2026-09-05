/**
 * DESIGN_SYSTEM.md § 10: "No component is complete until all five exist and are
 * reviewed" — default, loading, empty, error, disabled.
 *
 * Some states are genuinely meaningless for some components: a Divider has
 * nothing to load, a Button has no collection to be empty. Silently skipping
 * them would turn the rule into a formality, so each component declares its
 * coverage and must give a reason for anything it does not implement. A test
 * enforces that every component declares all five, and that every state marked
 * `true` has a matching Storybook story.
 */
export const UI_STATES = ['default', 'loading', 'empty', 'error', 'disabled'] as const
export type UiState = (typeof UI_STATES)[number]

/** `true` = implemented and storied. A string = deliberately not applicable, with the reason. */
export type StateCoverage = Record<UiState, true | string>

export const stateCoverage = <T extends StateCoverage>(c: T): T => c
