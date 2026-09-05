/**
 * Internal Operations view models — `PRODUCT.md § 14`.
 *
 * > **The internal tool may expose complexity. The customer product must not.**
 *
 * That sentence is the design brief for this file, and it inverts almost every
 * rule the customer view models follow. `apps/app` turns seventeen states into
 * five and a reassuring sentence; this turns them into seventeen, beside the
 * transition that produced them and the provider code that caused it. An
 * operator debugging a stalled payout at 2am does not need reassurance — they
 * need the raw fact and the next legal action.
 *
 * What does **not** invert:
 *
 * **Money is a string.** `INV-04` is not a customer-facing nicety. A facility
 * limit read as a JSON number above 2^53 arrives rounded, and a rounded figure
 * on an ops screen is one somebody makes a decision from.
 *
 * **Account numbers stay masked.** `SECURITY.md § 8` has no ops exception, and
 * the ciphertext is not granted to the ops role at all — so there is nothing
 * here to unmask even if someone wanted to.
 *
 * **Every action states what it will do before it does it.** An ops surface is
 * where the irreversible actions live, so the confirmation copy is part of the
 * product rather than decoration.
 */

/* ── Shared ─────────────────────────────────────────────────────────────── */

export interface OpsAmountInput {
  readonly currency: string
  readonly minorUnits: string
}

/**
 * `500000000` → `5,000,000.00 INR`.
 *
 * Formatted from the string, digit by digit, without ever becoming a number.
 * `Number(minorUnits)` here would be the same defect `INV-01` bans in the money
 * path, arriving through the display layer instead.
 */
export function formatMinor(amount: OpsAmountInput, scale = 2): string {
  const negative = amount.minorUnits.startsWith('-')
  const digits = (negative ? amount.minorUnits.slice(1) : amount.minorUnits).padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${fraction} ${amount.currency}`
}

export function shortAge(at: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

/* ── The exception queue ────────────────────────────────────────────────── */

export interface ExceptionRowInput {
  readonly id: string
  readonly settlementId: string
  readonly workspaceId: string
  readonly environment: 'sandbox' | 'live'
  readonly code: string
  readonly enteredFrom: string
  readonly openedAt: Date
  readonly recipientAmount: OpsAmountInput
  readonly pastPointOfNoReturn: boolean
  readonly providerRawCode: string | null
  readonly classification: string | null
}

export interface ExceptionRow {
  readonly id: string
  readonly settlementId: string
  readonly workspace: string
  readonly code: string
  readonly amount: string
  readonly age: string
  /** Where a resume would put it. Data, not a choice. */
  readonly resumesTo: string
  readonly available: readonly ('resume' | 'fail' | 'cancel')[]
  /** Why the unavailable ones are unavailable, said plainly. */
  readonly unavailableBecause: string | null
  /** True when the provider said something our mapping table did not cover. */
  readonly unmapped: boolean
  readonly severity: 'live' | 'sandbox'
}

/**
 * One row of the queue an operator lives in.
 *
 * The `available` list is the interesting part. Past the point of no return,
 * `fail` and `cancel` are both gone — `fail` because we do not know that no
 * money moved, and `cancel` because the instruction is out. Showing them
 * greyed with a reason beats showing them enabled and refusing at the click,
 * and beats hiding them and leaving an operator wondering.
 */
export function exceptionRow(input: ExceptionRowInput, now: Date): ExceptionRow {
  const available: ('resume' | 'fail' | 'cancel')[] = ['resume']
  if (!input.pastPointOfNoReturn) available.push('fail', 'cancel')

  return {
    id: input.id,
    settlementId: input.settlementId,
    workspace: `${input.workspaceId} · ${input.environment}`,
    code: input.code,
    amount: formatMinor(input.recipientAmount),
    age: shortAge(input.openedAt, now),
    resumesTo: input.enteredFrom,
    available,
    unavailableBecause: input.pastPointOfNoReturn
      ? 'The payout is out. It may already have credited, so this cannot be ' +
        'called failed or cancelled — resume it and find out what happened.'
      : null,
    unmapped: input.classification === 'unmapped' || input.providerRawCode !== null,
    // Live before sandbox, always. A sandbox exception is somebody testing.
    severity: input.environment === 'live' ? 'live' : 'sandbox',
  }
}

/** Live first, then oldest first. What is actually urgent, in order. */
export function orderQueue(rows: readonly ExceptionRow[]): readonly ExceptionRow[] {
  const ageRank = (age: string): number => {
    const unit = age.slice(-1)
    const value = Number.parseInt(age.slice(0, -1), 10)
    const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1
    return -(value * seconds)
  }
  return [...rows].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'live' ? -1 : 1
    return ageRank(a.age) - ageRank(b.age)
  })
}

/* ── Facilities ─────────────────────────────────────────────────────────── */

export interface FacilityCardInput {
  readonly id: string
  readonly workspaceId: string
  readonly environment: 'sandbox' | 'live'
  readonly providerId: string
  readonly currency: string
  readonly limit: OpsAmountInput
  readonly available: OpsAmountInput
  readonly reserved: OpsAmountInput
  readonly drawn: OpsAmountInput
  readonly status: string
}

export interface FacilityCard {
  readonly id: string
  readonly workspace: string
  readonly providerId: string
  readonly limit: string
  readonly available: string
  readonly reserved: string
  readonly drawn: string
  readonly status: string
  /** The floor a limit cannot go below: drawn + reserved. */
  readonly committed: string
  readonly headroom: 'healthy' | 'tight' | 'exhausted' | 'suspended'
  readonly headroomLabel: string
}

export function facilityCard(input: FacilityCardInput): FacilityCard {
  const limit = BigInt(input.limit.minorUnits)
  const available = BigInt(input.available.minorUnits)
  const committed = BigInt(input.drawn.minorUnits) + BigInt(input.reserved.minorUnits)

  const headroom = ((): FacilityCard['headroom'] => {
    if (input.status !== 'ACTIVE') return 'suspended'
    if (available <= 0n) return 'exhausted'
    // A tenth of the limit left. A threshold, not a rule from the documents —
    // it exists so a screen can say "look at this one" before a settlement
    // fails rather than after.
    return limit > 0n && available * 10n < limit ? 'tight' : 'healthy'
  })()

  return {
    id: input.id,
    workspace: `${input.workspaceId} · ${input.environment}`,
    providerId: input.providerId,
    limit: formatMinor(input.limit),
    available: formatMinor(input.available),
    reserved: formatMinor(input.reserved),
    drawn: formatMinor(input.drawn),
    status: input.status,
    committed: formatMinor({ currency: input.currency, minorUnits: committed.toString() }),
    headroom,
    headroomLabel: {
      healthy: 'Healthy',
      tight: 'Running low',
      exhausted: 'No headroom — settlements will stall here',
      suspended: `Not accepting reservations (${input.status})`,
    }[headroom],
  }
}

/* ── Provider events ────────────────────────────────────────────────────── */

export interface ProviderEventRowInput {
  readonly id: string
  readonly providerId: string
  readonly eventType: string
  readonly receivedAt: Date
  readonly signatureValid: boolean
  readonly interpretation: string | null
  readonly unmappedCode: string | null
  readonly subjectId: string | null
}

export interface ProviderEventRow {
  readonly id: string
  readonly providerId: string
  readonly eventType: string
  readonly age: string
  readonly subjectId: string | null
  readonly verdict: 'interpreted' | 'unmapped' | 'unsigned' | 'pending'
  readonly verdictLabel: string
}

/**
 * What happened to one provider event.
 *
 * The `unmapped` verdict is the reason this screen exists. It is the difference
 * between "the provider is misbehaving" and "our mapping table is out of date",
 * which are different incidents with different fixes and which look identical
 * from the settlement's side — the settlement just sits in `EXCEPTION` either
 * way. `INV-43` exists because the second kind used to be invisible.
 */
export function providerEventRow(input: ProviderEventRowInput, now: Date): ProviderEventRow {
  const verdict = ((): ProviderEventRow['verdict'] => {
    if (!input.signatureValid) return 'unsigned'
    if (input.unmappedCode !== null) return 'unmapped'
    if (input.interpretation === null) return 'pending'
    return 'interpreted'
  })()

  return {
    id: input.id,
    providerId: input.providerId,
    eventType: input.eventType,
    age: shortAge(input.receivedAt, now),
    subjectId: input.subjectId,
    verdict,
    verdictLabel: {
      interpreted: input.interpretation ?? 'Interpreted',
      unmapped: `We do not know what "${input.unmappedCode ?? ''}" means — the mapping table needs it`,
      unsigned: 'Signature did not verify. This event changed nothing.',
      pending: 'Received, not yet interpreted',
    }[verdict],
  }
}

/* ── Confirmations ──────────────────────────────────────────────────────── */

export interface ActionConfirmation {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  /** What the operator must type a reason into before confirming. */
  readonly reasonPrompt: string
}

/**
 * What an operator is told before they do something irreversible.
 *
 * Every one of these names the consequence rather than the action. "Resolve
 * exception" is what the button does; "this settlement goes back to
 * LIQUIDITY_RESERVED and carries on" is what happens, and the second is the one
 * somebody needs at 2am.
 */
export function confirmResolution(
  resolution: 'resume' | 'fail' | 'cancel', resumesTo: string,
): ActionConfirmation {
  switch (resolution) {
    case 'resume':
      return {
        title: 'Resume this settlement?',
        body:
          `It goes back to ${resumesTo} — where it was when it stalled — and carries on ` +
          'from there. If whatever blocked it is still blocking it, it will stall again, ' +
          'which is the honest outcome rather than a hidden one.',
        confirmLabel: 'Resume settlement',
        reasonPrompt: 'Why is it safe to resume? This is recorded permanently.',
      }
    case 'fail':
      return {
        title: 'Mark this settlement failed?',
        body:
          'This tells the customer no money reached their beneficiary and releases the ' +
          'liquidity held for it. It is final: a failed settlement cannot be resumed, and ' +
          'a new one has to be created.',
        confirmLabel: 'Mark failed',
        reasonPrompt: 'How do you know no value was delivered? This is recorded permanently.',
      }
    case 'cancel':
      return {
        title: 'Cancel this settlement?',
        body:
          'The instruction is withdrawn and the liquidity held for it is released or ' +
          'repaid. It is final, and the customer sees it as cancelled.',
        confirmLabel: 'Cancel settlement',
        reasonPrompt: 'Why is this being cancelled? This is recorded permanently.',
      }
  }
}

export function confirmFacilityLimit(
  previous: OpsAmountInput, next: OpsAmountInput, committed: OpsAmountInput,
): ActionConfirmation {
  const raising = BigInt(next.minorUnits) > BigInt(previous.minorUnits)
  return {
    title: raising ? 'Raise this facility limit?' : 'Lower this facility limit?',
    body: raising
      ? `Headroom goes from ${formatMinor(previous)} to ${formatMinor(next)}. No money moves; ` +
        'this changes how much can be reserved against the facility.'
      : `Headroom goes from ${formatMinor(previous)} to ${formatMinor(next)}. ` +
        `${formatMinor(committed)} is already drawn or reserved and is not affected — ` +
        'settlements already funded carry on.',
    confirmLabel: raising ? 'Raise limit' : 'Lower limit',
    reasonPrompt: 'Why is the limit changing? This is recorded permanently.',
  }
}
