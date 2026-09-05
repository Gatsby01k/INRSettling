/**
 * Loading versioned preflight reference data.
 *
 * The rule sets live as files under `reference/preflight/`. They are parsed and
 * validated by the domain, then written to `preflight_rule_sets` — which is
 * read-only to the application role, so this runs as the migration/owner
 * credential and never at request time.
 *
 * The point of the round trip is that a rule set in the database can always be
 * proved identical to the file that produced it: the checksum travels with it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type postgres from 'postgres'
import { parseRuleSet, ruleSetChecksum, toRuleJson, type PreflightRuleSet } from '@inrsettle/domain'

export class ReferenceDataError extends Error {
  constructor(message: string, readonly file: string, readonly defects: unknown) {
    super(message)
    this.name = 'ReferenceDataError'
  }
}

export function readRuleSetFile(path: string): { ruleSet: PreflightRuleSet; checksum: string } {
  const parsed = parseRuleSet(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.ok) {
    // Loud and specific: a malformed rule set must never be loaded and then
    // discovered later as a blank requirement card in front of a customer.
    throw new ReferenceDataError(`rule set ${path} is invalid`, path, parsed.defects)
  }
  return { ruleSet: parsed.ruleSet, checksum: parsed.checksum }
}

/**
 * Load every rule set in a directory. Idempotent: re-running with an unchanged
 * file is a no-op, and re-running with a *changed* file under the same version
 * is an error rather than a silent overwrite — a version is supposed to be
 * immutable, and a preflight result that cites it has to stay explainable.
 */
export async function loadReferenceData(
  admin: postgres.Sql,
  dir: string,
): Promise<readonly { version: string; checksum: string; loaded: boolean }[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const results: { version: string; checksum: string; loaded: boolean }[] = []

  for (const file of files) {
    const { ruleSet, checksum } = readRuleSetFile(join(dir, file))

    const existing = await admin<{ checksum: string }[]>`
      SELECT checksum FROM preflight_rule_sets WHERE version = ${ruleSet.version}`

    const previous = existing[0]
    if (previous) {
      if (previous.checksum !== checksum) {
        throw new ReferenceDataError(
          `rule set version ${ruleSet.version} is already loaded with a different checksum; ` +
            'publish a new version rather than editing a published one',
          file,
          { stored: previous.checksum, file: checksum },
        )
      }
      results.push({ version: ruleSet.version, checksum, loaded: false })
      continue
    }

    await admin.begin(async (tx) => {
      await tx`
        INSERT INTO preflight_rule_sets (version, source, description, rules, checksum)
        VALUES (${ruleSet.version}, ${ruleSet.source}, ${ruleSet.description},
                ${admin.json(ruleSet.rules.map(toRuleJson) as never)}, ${checksum})`
      for (const p of ruleSet.purposeCodes) {
        await tx`
          INSERT INTO purpose_codes (rule_set_version, code, label, regulatory_code, source)
          VALUES (${ruleSet.version}, ${p.code}, ${p.label}, ${p.regulatoryCode}, ${ruleSet.source})`
      }
    })
    results.push({ version: ruleSet.version, checksum, loaded: true })
  }

  return results
}

interface RuleSetRow {
  version: string
  source: string
  description: string
  rules: unknown
  checksum: string
}

/**
 * Read a rule set back out for evaluation, re-validating it on the way.
 *
 * Re-parsing is not paranoia about the database: it means a rule set can never
 * reach the evaluator without having satisfied the same four-field check that
 * CI applies, whatever route it took into the table.
 */
export async function loadRuleSetFromDatabase(
  sql: postgres.Sql,
  version: string,
): Promise<{ ruleSet: PreflightRuleSet; checksum: string } | null> {
  const rows = await sql<RuleSetRow[]>`
    SELECT version, source, description, rules, checksum
    FROM preflight_rule_sets WHERE version = ${version}`
  const row = rows[0]
  if (!row) return null

  const purposeRows = await sql<{ code: string; label: string; regulatory_code: string | null }[]>`
    SELECT code, label, regulatory_code FROM purpose_codes
    WHERE rule_set_version = ${version} ORDER BY code`

  const parsed = parseRuleSet({
    version: row.version,
    source: row.source,
    description: row.description,
    purpose_codes: purposeRows.map((p) => ({
      code: p.code,
      label: p.label,
      regulatory_code: p.regulatory_code,
    })),
    // postgres.js gives jsonb back parsed; a string here would mean the column
    // was written double-encoded, which is worth failing loudly on.
    rules: typeof row.rules === 'string' ? JSON.parse(row.rules) : row.rules,
  })
  if (!parsed.ok) {
    throw new ReferenceDataError(
      `rule set ${version} in the database is invalid`,
      version,
      parsed.defects,
    )
  }

  const recomputed = ruleSetChecksum(parsed.ruleSet)
  if (recomputed !== row.checksum) {
    throw new ReferenceDataError(
      `rule set ${version} does not match its stored checksum`,
      version,
      { stored: row.checksum, recomputed },
    )
  }
  return { ruleSet: parsed.ruleSet, checksum: row.checksum }
}

/**
 * Which rule set a preflight run should use.
 *
 * The newest set whose `effective_from` has passed, preferring a real
 * `ad_bank` or `provider` set over a sandbox fixture when both are eligible —
 * so the day `D-06` is answered, live stops using the simulator's rules without
 * anything in the application changing.
 */
export async function activeRuleSetVersion(
  sql: postgres.Sql,
  environment: 'sandbox' | 'live',
  now: Date,
): Promise<string | null> {
  const rows = await sql<{ version: string }[]>`
    SELECT version FROM preflight_rule_sets
    WHERE effective_from <= ${now}
      AND (${environment} = 'sandbox' OR source <> 'sandbox_fixture')
    ORDER BY (source <> 'sandbox_fixture') DESC, effective_from DESC, version DESC
    LIMIT 1`
  return rows[0]?.version ?? null
}
