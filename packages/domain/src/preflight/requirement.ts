/**
 * Requirements — `PRODUCT.md § 7.1`, `API_CONTRACT.md § 7.4`.
 *
 * A requirement is the only way preflight is allowed to say "not yet". It
 * carries exactly four things, and the type system is the first place that is
 * enforced: a stable machine `code`, a one-line human `title`, a sentence of
 * `detail`, and a single named `action`.
 *
 * There is deliberately no `validation_failed` code and no free-form message
 * field. A rule that cannot express all four does not ship
 * (`IMPLEMENTATION_PLAN.md` Stage 2 exit criteria).
 */

export type RequirementSeverity = 'blocking' | 'advisory'

/**
 * The named action a requirement resolves through.
 *
 * This is a closed union on purpose. "One named action" means the UI can render
 * a real button for every requirement it is ever handed; an open string would
 * let a rule ship with an action nothing knows how to offer.
 */
export type RequirementAction =
  | { type: 'verify_beneficiary'; beneficiaryId: string; destinationVersionId: string }
  | { type: 'edit_beneficiary'; beneficiaryId: string; field: string }
  | { type: 'add_payout_destination'; beneficiaryId: string }
  | { type: 'upload_document'; documentType: string }
  | { type: 'select_purpose' }
  | { type: 'contact_support'; topic: string }
  | { type: 'set_up_liquidity_facility' }

export const REQUIREMENT_ACTION_TYPES = [
  'verify_beneficiary',
  'edit_beneficiary',
  'add_payout_destination',
  'upload_document',
  'select_purpose',
  'contact_support',
  'set_up_liquidity_facility',
] as const satisfies readonly RequirementAction['type'][]

export interface Requirement {
  /** Stable machine code. Never shown to a human, never reused for a new meaning. */
  readonly code: string
  readonly severity: RequirementSeverity
  /** One line, sentence case, states the missing thing — not the failure. */
  readonly title: string
  /** One sentence of context: why this is needed, or what happens next. */
  readonly detail: string
  readonly action: RequirementAction
}

/** Copy that would let a generic error reach a customer (`PRODUCT.md § 7.1`). */
const BANNED_COPY = [
  'validation failed', // copy-check:allow — named here in order to be rejected
  'invalid input', // copy-check:allow
  'bad request', // copy-check:allow
  'an error occurred', // copy-check:allow
  'something went wrong', // copy-check:allow
  'unknown error', // copy-check:allow
]

export type RequirementDefect =
  | { code: string; problem: 'code_missing' }
  | { code: string; problem: 'code_malformed' }
  | { code: string; problem: 'title_missing' }
  | { code: string; problem: 'title_not_a_sentence' }
  | { code: string; problem: 'detail_missing' }
  | { code: string; problem: 'detail_too_short' }
  | { code: string; problem: 'action_missing' }
  | { code: string; problem: 'action_unknown_type' }
  | { code: string; problem: 'generic_copy'; phrase: string }

const CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/

/**
 * Structural check applied to every requirement a rule can emit.
 *
 * This runs in CI over the whole rule set, not just over requirements that
 * happen to fire, so an unreachable rule with missing copy still fails the
 * build.
 */
export type RequirementDraft = { [K in keyof Requirement]?: Requirement[K] | undefined }

export function inspectRequirement(r: RequirementDraft | undefined): RequirementDefect[] {
  const code = typeof r?.code === 'string' ? r.code : ''
  const defects: RequirementDefect[] = []

  if (code.trim() === '') defects.push({ code: '(unnamed)', problem: 'code_missing' })
  else if (!CODE_PATTERN.test(code)) defects.push({ code, problem: 'code_malformed' })

  const title = typeof r?.title === 'string' ? r.title.trim() : ''
  if (title === '') defects.push({ code, problem: 'title_missing' })
  else if (title.length < 12 || !/[a-z]/.test(title)) {
    defects.push({ code, problem: 'title_not_a_sentence' })
  }

  const detail = typeof r?.detail === 'string' ? r.detail.trim() : ''
  if (detail === '') defects.push({ code, problem: 'detail_missing' })
  else if (detail.length < 24) defects.push({ code, problem: 'detail_too_short' })

  const action = r?.action
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    defects.push({ code, problem: 'action_missing' })
  } else if (!(REQUIREMENT_ACTION_TYPES as readonly string[]).includes(action.type)) {
    defects.push({ code, problem: 'action_unknown_type' })
  }

  const copy = `${title} ${detail}`.toLowerCase()
  for (const phrase of BANNED_COPY) {
    if (copy.includes(phrase)) defects.push({ code, problem: 'generic_copy', phrase })
  }

  return defects
}

export function isWellFormedRequirement(r: RequirementDraft | undefined): r is Requirement {
  return inspectRequirement(r).length === 0
}

/**
 * Stable ordering so two runs of the same input produce byte-identical output.
 * Blocking before advisory, then by code.
 */
export function sortRequirements(rs: readonly Requirement[]): Requirement[] {
  return [...rs].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })
}
