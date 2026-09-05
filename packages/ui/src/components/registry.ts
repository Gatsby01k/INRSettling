/**
 * The implemented primitive registry.
 *
 * `DESIGN_SYSTEM.md § 5` names the primitive catalogue. The coverage test parses
 * that sentence out of the frozen document and compares it against this map, so
 * a primitive that is never implemented fails CI rather than quietly leaving the
 * test universe — which is exactly what happened when ten of them were missing
 * and the suite still reported full coverage.
 */
import type { StateCoverage } from './state-coverage.js'
import {
  buttonStates, checkboxStates, dividerStates, emptyStateStates, iconButtonStates,
  inputStates, modalStates, selectStates, skeletonStates, spinnerStates, switchStates,
  textareaStates, tooltipStates,
} from './index.js'
import {
  amountInputStates, comboboxStates, datePickerStates, fileDropStates, radioStates,
} from './inputs.js'
import {
  breadcrumbStates, drawerStates, popoverStates, tabsStates, toastStates,
} from './overlays.js'
import {
  beneficiaryPickerStates, requirementCardStates, statusIndicatorStates,
} from './beneficiary.js'
import {
  amountDisplayStates, quoteSummaryStates, referenceStates, settlementProgressStates,
} from './settlement.js'
import { desktopTaskStates, eventRowStates, metricTileStates } from './overview.js'

export const PRIMITIVES = {
  // Stage 3 domain components from the § 5 table — the four the settlement
  // surfaces need. EventRow, ReceiptDocument and MetricTile stay deferred.
  AmountDisplay: amountDisplayStates,
  AmountInput: amountInputStates,
  // Stage 2 domain components from the DESIGN_SYSTEM.md § 5 table. Only the
  // three the beneficiary and preflight surfaces need; the rest stay deferred.
  BeneficiaryPicker: beneficiaryPickerStates,
  Breadcrumb: breadcrumbStates,
  Button: buttonStates,
  Checkbox: checkboxStates,
  Combobox: comboboxStates,
  DatePicker: datePickerStates,
  // The 8 monitoring experience: what a desktop-only surface renders
  // instead of itself on a phone.
  DesktopTask: desktopTaskStates,
  Divider: dividerStates,
  Drawer: drawerStates,
  // Stage 10 closes the two § 5 domain components earlier stages deferred.
  // `§ 12`: a component that exists in an app but not in packages/ui is a bug.
  EventRow: eventRowStates,
  // Not in the § 5 primitives sentence but specified in the same document's
  // component table, and generic. Declared here so the extras check passes it.
  EmptyState: emptyStateStates,
  FileDrop: fileDropStates,
  IconButton: iconButtonStates,
  Input: inputStates,
  MetricTile: metricTileStates,
  Modal: modalStates,
  Popover: popoverStates,
  QuoteSummary: quoteSummaryStates,
  Radio: radioStates,
  Reference: referenceStates,
  RequirementCard: requirementCardStates,
  Select: selectStates,
  SettlementProgress: settlementProgressStates,
  Skeleton: skeletonStates,
  Spinner: spinnerStates,
  StatusIndicator: statusIndicatorStates,
  Switch: switchStates,
  Tabs: tabsStates,
  Textarea: textareaStates,
  Toast: toastStates,
  Tooltip: tooltipStates,
} as const satisfies Record<string, StateCoverage>

export type PrimitiveName = keyof typeof PRIMITIVES

/** Implemented but absent from the § 5 sentence; each needs a reason. */
export const DOCUMENTED_EXTRAS: Record<string, string> = {
  EmptyState: 'specified in the DESIGN_SYSTEM.md component table rather than the § 5 primitives sentence',
  StatusIndicator: 'DESIGN_SYSTEM.md § 5 domain component table; needed by the Stage 2 beneficiary surfaces',
  RequirementCard: 'DESIGN_SYSTEM.md § 5 domain component table; the preflight surface is Stage 2 scope',
  BeneficiaryPicker: 'DESIGN_SYSTEM.md § 5 domain component table; beneficiaries are Stage 2 scope',
  AmountDisplay: 'DESIGN_SYSTEM.md § 5 domain component table; Stage 3 renders Money and must never accept a number',
  SettlementProgress: 'DESIGN_SYSTEM.md § 5 domain component table; the Ready → Settling → Settled rail is Stage 3 scope',
  QuoteSummary: 'DESIGN_SYSTEM.md § 5 domain component table; quotes are Stage 3 scope',
  Reference: 'DESIGN_SYSTEM.md § 5 domain component table; settlement detail shows technical references',
  EventRow:
    'DESIGN_SYSTEM.md § 5 domain component table; the Developers event log built ' +
    'its own rows in apps/app from Stage 8, which § 12 calls a bug — Stage 10 closes it',
  MetricTile:
    'DESIGN_SYSTEM.md § 5 domain component table; Overview only, and Overview ' +
    'is Stage 10 scope',
  DesktopTask:
    'not in the § 5 catalogue: it is what § 8 requires of the <768px monitoring ' +
    'experience — "desktop tasks … say so plainly rather than degrading" — and ' +
    'the plain saying needs somewhere to live',
}
