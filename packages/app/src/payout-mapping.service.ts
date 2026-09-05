/**
 * Loading versioned provider mapping tables — `INV-43`.
 *
 * The tables live as files under `reference/payout-mappings/`, are validated
 * against the closed exception taxonomy at load time, and are written to
 * `provider_mapping_tables` — read-only to the application role, so this runs
 * as the owner credential and never at request time.
 *
 * Exactly the shape of the Stage 2 preflight rule-set loader, and for the same
 * reasons. A published version is immutable: re-running with an unchanged file
 * is a no-op, and re-running with a *changed* file under the same version is an
 * error rather than a silent overwrite. An interpretation that cites a version
 * has to stay explainable, and it cannot be if the version can be edited under
 * it.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type postgres from 'postgres'
import { eq } from 'drizzle-orm'
import type { Db } from '@inrsettle/db'
import { schema } from '@inrsettle/db'
import {
  RETURN_REASON_CODES,
  isExceptionCode,
  validateMappingTable,
  type ProviderCodeMapping,
  type ProviderMappingTable,
  type ReturnReasonCode,
} from '@inrsettle/domain'

export class MappingTableError extends Error {
  constructor(message: string, readonly file: string, readonly problems: readonly string[]) {
    super(`${message}: ${problems.join('; ')}`)
    this.name = 'MappingTableError'
  }
}

interface MappingFile {
  version?: unknown
  provider_id?: unknown
  source?: unknown
  description?: unknown
  codes?: unknown
}

const SOURCES = new Set(['sandbox_fixture', 'provider_documentation', 'provider_contract'])

export function parseMappingTable(
  raw: unknown,
  file: string,
): { table: ProviderMappingTable; checksum: string } {
  const doc = (raw ?? {}) as MappingFile
  const problems: string[] = []

  if (typeof doc.version !== 'string' || doc.version.trim().length === 0) {
    problems.push('missing "version"')
  }
  if (typeof doc.provider_id !== 'string' || doc.provider_id.trim().length === 0) {
    problems.push('missing "provider_id"')
  }
  if (typeof doc.source !== 'string' || !SOURCES.has(doc.source)) {
    // The same guard the preflight rule sets carry: a sandbox fixture must
    // never be able to present itself as a provider's documented contract.
    problems.push('"source" must be sandbox_fixture, provider_documentation or provider_contract')
  }
  if (typeof doc.description !== 'string' || doc.description.trim().length < 20) {
    problems.push('"description" must say what this table is and where it came from')
  }
  if (!Array.isArray(doc.codes)) problems.push('"codes" must be an array')

  if (problems.length > 0) throw new MappingTableError(`mapping table ${file} is invalid`, file, problems)

  const codes: ProviderCodeMapping[] = (doc.codes as Record<string, unknown>[]).map((c) => {
    const exceptionCode = c['exception_code']
    const returnReason = c['return_reason']
    let entry: ProviderCodeMapping = {
      providerCode: String(c['provider_code'] ?? ''),
      outcome: c['outcome'] as ProviderCodeMapping['outcome'],
      note: String(c['note'] ?? ''),
    }
    // Spread rather than assign `undefined`: `exactOptionalPropertyTypes` draws
    // a real distinction between "absent" and "present and undefined", and an
    // entry with no exception code should be the former.
    if (typeof exceptionCode === 'string' && isExceptionCode(exceptionCode)) {
      entry = { ...entry, exceptionCode }
    }
    // An unrecognised return reason is dropped rather than passed through, so
    // it lands on RETURN_REASON_UNMAPPED and escalates. `validateMappingTable`
    // is what tells the author their string was not a member of the taxonomy;
    // silently trusting it here would widen the taxonomy from a data file.
    if (
      typeof returnReason === 'string' &&
      (RETURN_REASON_CODES as readonly string[]).includes(returnReason)
    ) {
      entry = { ...entry, returnReason: returnReason as ReturnReasonCode }
    }
    return entry
  })

  const table: ProviderMappingTable = {
    providerId: doc.provider_id as string,
    version: doc.version as string,
    source: doc.source as ProviderMappingTable['source'],
    codes,
  }

  // The load-time check that keeps the taxonomy closed against a *data* file.
  // Without it, "the enum stays closed" would be true only of code.
  const defects = validateMappingTable(table, isExceptionCode)
  if (defects.length > 0) {
    throw new MappingTableError(`mapping table ${file} is invalid`, file, defects)
  }

  const checksum = createHash('sha256')
    .update(JSON.stringify({ v: table.version, p: table.providerId, c: table.codes }))
    .digest('hex')
  return { table, checksum }
}

export async function loadPayoutMappings(
  admin: postgres.Sql,
  dir: string,
): Promise<readonly { version: string; checksum: string; loaded: boolean }[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  const results: { version: string; checksum: string; loaded: boolean }[] = []

  for (const file of files) {
    const path = join(dir, file)
    const { table, checksum } = parseMappingTable(JSON.parse(readFileSync(path, 'utf8')), path)

    const existing = await admin<{ checksum: string }[]>`
      SELECT checksum FROM provider_mapping_tables WHERE version = ${table.version}`
    const previous = existing[0]
    if (previous) {
      if (previous.checksum !== checksum) {
        throw new MappingTableError(
          `mapping table version ${table.version} is already loaded with a different checksum`,
          path,
          ['publish a new version rather than editing a published one'],
        )
      }
      results.push({ version: table.version, checksum, loaded: false })
      continue
    }

    await admin`
      INSERT INTO provider_mapping_tables
        (version, provider_id, source, description, codes, checksum)
      VALUES (${table.version}, ${table.providerId}, ${table.source},
              ${String((JSON.parse(readFileSync(path, 'utf8')) as MappingFile).description)},
              ${JSON.stringify(table.codes)}::jsonb, ${checksum})`
    results.push({ version: table.version, checksum, loaded: true })
  }
  return results
}

/** The table in force for a provider, newest effective first. */
export async function activeMappingTable(
  tx: Db,
  providerId: string,
): Promise<ProviderMappingTable | null> {
  const rows = await tx
    .select()
    .from(schema.providerMappingTables)
    .where(eq(schema.providerMappingTables.providerId, providerId))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    providerId: row.providerId,
    version: row.version,
    source: row.source as ProviderMappingTable['source'],
    codes: row.codes as ProviderCodeMapping[],
  }
}
