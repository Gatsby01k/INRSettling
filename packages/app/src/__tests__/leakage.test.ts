/**
 * `INV-12` — full account details never leave the encryption boundary.
 *
 * This suite is deliberately paranoid and deliberately broad. Rather than
 * asserting that one function masks correctly, it drives a realistic flow —
 * create, verify, edit, re-verify, receive a callback — and then sweeps **every
 * surface a value could escape through**: the customer DTOs, the UI props
 * derived from them, every event payload, every audit record, the provider
 * event store, and anything written to the log.
 *
 * The sweep looks for the secrets themselves rather than for known field names,
 * so a *new* field added later that happens to carry an account number fails
 * this test without anyone remembering to update it.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedWorkspace, type Harness } from '@inrsettle/testing'
import { withTenant } from '@inrsettle/db'
import type { PayoutDetails } from '@inrsettle/domain'
import { SANDBOX_NAME_MATCH_POLICIES, createSandboxVerificationProvider } from '@inrsettle/providers'
import { createFieldCipher } from '../crypto/field-encryption.js'
import { createDestinationFingerprinter } from '../crypto/destination-fingerprint.js'
import {
  createBeneficiary,
  editPayoutDestination,
  getBeneficiary,
  listBeneficiaries,
  listDestinationVersions,
} from '../beneficiary.service.js'
import { ingestVerificationCallback, listVerifications, requestVerification } from '../verification.service.js'

let h: Harness
const WS = 'ws_leak'
const scope = { workspaceId: WS, environment: 'live' as const }
const actor = { type: 'user' as const, id: 'usr_admin' }

const crypto = {
  cipher: createFieldCipher({ activeKeyId: 'k1', keks: { k1: randomBytes(32) } }),
  fingerprinter: createDestinationFingerprinter(randomBytes(32)),
}
const provider = createSandboxVerificationProvider()
const policies = SANDBOX_NAME_MATCH_POLICIES
const live = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.db, scope, fn)

/**
 * The values that must never appear anywhere but the ciphertext. Distinctive on
 * purpose, so a substring search cannot match them by accident.
 */
const ACCOUNT_ONE = '50100987654321'
const ACCOUNT_TWO = '50100112233447'
const PAN = 'ABCDE1234F'
const VPA = 'aarti.secret.handle@okhdfcbank'
const SECRETS = [ACCOUNT_ONE, ACCOUNT_TWO, PAN]

const FIRST: PayoutDetails = {
  kind: 'bank_account',
  accountNumber: ACCOUNT_ONE,
  ifsc: 'HDFC0000123',
  accountType: 'savings',
  accountHolderName: 'Aarti Sharma',
}
/** Suffix 47 matches no scenario, so it confirms with an exact name. */
const SECOND: PayoutDetails = { ...FIRST, accountNumber: ACCOUNT_TWO }

let beneficiaryId = ''
let firstVersionId = ''
let secondVersionId = ''
let upiBeneficiaryId = ''

function containsSecret(haystack: string): string | null {
  for (const secret of SECRETS) if (haystack.includes(secret)) return secret
  // The last four digits are permitted; anything longer is not. This catches a
  // partial leak that a whole-string search would miss.
  for (const secret of [ACCOUNT_ONE, ACCOUNT_TWO]) {
    for (let len = 5; len <= secret.length; len += 1) {
      const tail = secret.slice(-len)
      if (haystack.includes(tail)) return tail
    }
  }
  return null
}

beforeAll(async () => {
  h = await createTestDatabase('leakage')
  await seedWorkspace(h.admin, {
    workspaceId: WS, userId: 'usr_admin', email: 'a@example.test', roles: ['admin'],
  })

  // A realistic flow, so the sweep below runs over rows produced by every
  // Stage 2 write path rather than by one contrived call.
  const created = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'Aarti Sharma', type: 'individual', country: 'IN', taxId: PAN },
      destination: FIRST,
      actor,
    }),
  )
  beneficiaryId = created.id
  firstVersionId = created.destinations[0]!.currentVersion!.id
  const destinationId = created.destinations[0]!.id

  await requestVerification(h.db, scope, provider, crypto.cipher, policies, {
      destinationVersionId: firstVersionId,
      actor,
    })

  const edited = await live((tx) =>
    editPayoutDestination(tx, scope, crypto, { destinationId, details: SECOND, actor }),
  )
  secondVersionId = edited.destination.currentVersion!.id

  await requestVerification(h.db, scope, provider, crypto.cipher, policies, {
      destinationVersionId: secondVersionId,
      actor,
    })

  // A provider callback whose raw payload contains an account number. Providers
  // do echo details back; the raw event is kept (INV-33) but must not seed a
  // leak into any interpreted surface.
  await live((tx) =>
    ingestVerificationCallback(tx, scope, provider, policies, {
      providerEventId: 'evt_leak_probe',
      payload: {
        request_id: 'req_unknown',
        destination_version_id: secondVersionId,
        event_id: 'evt_leak_probe',
        result: 'account_confirmed',
        account_number: ACCOUNT_TWO,
        registry_name: 'AARTI SHARMA',
      },
      signatureValid: true,
      actor: { type: 'provider', id: 'sandbox' },
    }),
  )

  const upi = await live((tx) =>
    createBeneficiary(tx, scope, crypto, {
      identity: { displayName: 'UPI Person', type: 'individual', country: 'IN' },
      destination: { kind: 'upi', vpa: VPA },
      actor,
    }),
  )
  upiBeneficiaryId = upi.id
})
afterAll(async () => { await h.close() })

describe('the sweep detector itself works', () => {
  it('finds a secret when one is present', () => {
    expect(containsSecret(`prefix ${ACCOUNT_ONE} suffix`)).toBe(ACCOUNT_ONE)
    expect(containsSecret(`pan is ${PAN}`)).toBe(PAN)
  })

  it('finds a partial leak longer than the permitted last four', () => {
    expect(containsSecret(ACCOUNT_ONE.slice(-6))).toBeTruthy()
  })

  it('permits the masked last four', () => {
    expect(containsSecret(`HDFC •••• ${ACCOUNT_ONE.slice(-4)}`)).toBeNull()
  })
})

describe('customer DTOs', () => {
  it('the beneficiary read model carries no account number or PAN', async () => {
    const view = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    expect(containsSecret(JSON.stringify(view))).toBeNull()
    expect(view?.taxIdLast4).toBe('234F')
    expect(view?.destinations[0]?.currentVersion?.accountNumberLast4).toBe(ACCOUNT_TWO.slice(-4))
  })

  it('the list read model carries none either', async () => {
    const rows = await live((tx) => listBeneficiaries(tx, scope))
    expect(containsSecret(JSON.stringify(rows))).toBeNull()
  })

  it('destination history carries none, across every version', async () => {
    const view = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    const history = await live((tx) =>
      listDestinationVersions(tx, scope, view!.destinations[0]!.id),
    )
    expect(history).toHaveLength(2)
    expect(containsSecret(JSON.stringify(history))).toBeNull()
    // Both versions still render, masked.
    expect(history.map((v) => v.accountNumberLast4).sort()).toEqual(
      [ACCOUNT_ONE.slice(-4), ACCOUNT_TWO.slice(-4)].sort(),
    )
  })

  it('the read model has no field that could carry one', async () => {
    const view = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    const version = view!.destinations[0]!.currentVersion!
    // Structural, not value-based: no `accountNumber`, and no fingerprint —
    // the fingerprint is keyed but is still an oracle if handed to a caller.
    expect(Object.keys(version)).not.toContain('accountNumber')
    expect(Object.keys(version)).not.toContain('accountNumberCiphertext')
    expect(Object.keys(version)).not.toContain('contentHash')
    expect(Object.keys(version)).not.toContain('detailsFingerprint')
  })

  it('the verification record carries no account details', async () => {
    const verifications = await live((tx) => listVerifications(tx, scope, secondVersionId))
    expect(containsSecret(JSON.stringify(verifications))).toBeNull()
  })
})

describe('events and audit records', () => {
  it('no event payload in the whole database contains a secret', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`SELECT type, payload::text AS body FROM events`),
    ) as unknown as { type: string; body: string }[]
    expect(rows.length).toBeGreaterThan(4)
    for (const row of rows) {
      expect(containsSecret(row.body), `event ${row.type}`).toBeNull()
    }
  })

  it('no audit record contains a secret, before or after', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT action, coalesce(before::text, '') || ' ' || coalesce(after::text, '') AS body
        FROM audit_log`),
    ) as unknown as { action: string; body: string }[]
    expect(rows.length).toBeGreaterThan(4)
    for (const row of rows) {
      expect(containsSecret(row.body), `audit ${row.action}`).toBeNull()
    }
  })

  it('the audit trail still explains what happened', async () => {
    // Masking must not have been achieved by recording nothing.
    const rows = await live((tx) =>
      tx.execute(sql`SELECT DISTINCT action FROM audit_log ORDER BY action`),
    ) as unknown as { action: string }[]
    const actions = rows.map((r) => r.action)
    for (const expected of [
      'beneficiary.created',
      'payout_destination.created',
      'payout_destination.version_created',
      'beneficiary.verification_requested',
      'beneficiary.verified',
    ]) {
      expect(actions, expected).toContain(expected)
    }
  })

  it('the keyed fingerprint is not in any event or audit payload', async () => {
    const [version] = await live((tx) =>
      tx.execute(sql`
        SELECT details_fingerprint AS fp FROM payout_destination_versions WHERE id = ${secondVersionId}`),
    ) as unknown as { fp: string }[]
    expect(version?.fp).toBeTruthy()
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT body FROM (
          SELECT payload::text AS body FROM events
          UNION ALL SELECT coalesce(after::text, '') FROM audit_log
          UNION ALL SELECT coalesce(before::text, '') FROM audit_log
        ) t`),
    ) as unknown as { body: string }[]
    for (const row of rows) expect(row.body).not.toContain(version!.fp)
  })
})

describe('the database itself', () => {
  it('stores the account number only as ciphertext', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT account_number_ciphertext AS ct, account_number_last4 AS last4, vpa
        FROM payout_destination_versions ORDER BY version_number`),
    ) as unknown as { ct: string | null; last4: string | null; vpa: string | null }[]
    for (const row of rows) {
      if (row.ct) expect(containsSecret(row.ct)).toBeNull()
    }
    expect(rows.map((r) => r.last4).filter(Boolean)).toContain(ACCOUNT_TWO.slice(-4))
  })

  it('stores the PAN only as ciphertext', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`SELECT tax_id_ciphertext AS ct, tax_id_last4 AS last4 FROM beneficiaries`),
    ) as unknown as { ct: string | null; last4: string | null }[]
    for (const row of rows) {
      if (row.ct) expect(containsSecret(row.ct)).toBeNull()
    }
  })

  it('keeps the raw provider payload — evidence is not redacted away', async () => {
    // The deliberate exception, and the reason the sweep above is scoped to
    // *interpreted* surfaces: INV-33 requires the raw event verbatim. It lives
    // in a tenant-scoped, RLS-protected table and is never rendered to a
    // customer or copied into an event.
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT payload::text AS body FROM provider_events WHERE provider_event_id = 'evt_leak_probe'`),
    ) as unknown as { body: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toContain(ACCOUNT_TWO)
  })

  it('and that raw payload did not seed a leak into any interpreted surface', async () => {
    const rows = await live((tx) =>
      tx.execute(sql`
        SELECT body FROM (
          SELECT payload::text AS body FROM events
          UNION ALL SELECT coalesce(after::text, '') FROM audit_log
        ) t`),
    ) as unknown as { body: string }[]
    for (const row of rows) expect(containsSecret(row.body)).toBeNull()
  })
})

describe('logs', () => {
  const captured: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    captured.length = 0
  })

  it('a full create-verify-edit cycle writes no secret to any console channel', async () => {
    for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(' '))
      })
    }

    const created = await live((tx) =>
      createBeneficiary(tx, scope, crypto, {
        identity: { displayName: 'Log Probe', type: 'individual', country: 'IN', taxId: PAN },
        destination: FIRST,
        actor,
      }),
    )
    const versionId = created.destinations[0]!.currentVersion!.id
    await requestVerification(h.db, scope, provider, crypto.cipher, policies, {
        destinationVersionId: versionId,
        actor,
      })

    await live((tx) =>
      editPayoutDestination(tx, scope, crypto, {
        destinationId: created.destinations[0]!.id,
        details: SECOND,
        actor,
      }),
    )

    for (const line of captured) expect(containsSecret(line)).toBeNull()
  })

  it('an error thrown on invalid details does not carry the account number', async () => {
    await expect(
      live((tx) =>
        createBeneficiary(tx, scope, crypto, {
          identity: { displayName: 'Bad Details', type: 'individual', country: 'IN' },
          destination: { ...FIRST, accountNumber: `${ACCOUNT_ONE}XX`, ifsc: 'nope' },
          actor,
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      // A validation error names the *field*, never the value — an exception
      // message is the classic accidental egress into a log aggregator.
      const serialised = `${String((e as Error).message)} ${JSON.stringify(e)}`
      return containsSecret(serialised) === null
    })
  })
})

describe('the UI props derived from these DTOs', () => {
  it('carry no secret either', async () => {
    const view = await live((tx) => getBeneficiary(tx, scope, upiBeneficiaryId))
    // The summary is the only destination string a surface renders, and for UPI
    // it is the handle itself — which is not secret, unlike an account number.
    expect(view?.destinations[0]?.currentVersion?.summary).toBe(VPA)
    expect(containsSecret(JSON.stringify(view))).toBeNull()
  })

  it('a bank summary is the masked form and nothing more', async () => {
    const view = await live((tx) => getBeneficiary(tx, scope, beneficiaryId))
    expect(view?.destinations[0]?.currentVersion?.summary).toBe(`HDFC •••• ${ACCOUNT_TWO.slice(-4)}`)
  })
})
