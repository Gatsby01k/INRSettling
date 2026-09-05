/**
 * Dated API versions — `API_CONTRACT.md § 2` and `§ 12`.
 *
 * > Version pinning is date-based and per workspace, overridable per request:
 * > `INRSettle-Version: 2026-08-31`
 *
 * One version exists. The registry is here anyway, because the alternative —
 * comparing a header against a string literal at the point of use — is how a
 * second version becomes a search-and-replace across the codebase instead of a
 * line of data.
 *
 * `§ 12` decides what belongs in this list and what does not: a new field, a new
 * event type or a new enum value on an extensible field ships **without** a
 * version. So a version appears here only when something was removed, retyped or
 * narrowed. An empty second entry would be a lie about the change policy.
 */

export const API_VERSIONS = ['2026-08-31'] as const
export type ApiVersion = (typeof API_VERSIONS)[number]

/** What a workspace gets if it has never pinned one. */
export const DEFAULT_API_VERSION: ApiVersion = '2026-08-31'

export function isApiVersion(value: string): value is ApiVersion {
  return (API_VERSIONS as readonly string[]).includes(value)
}

export type VersionResolution =
  | { readonly ok: true; readonly version: ApiVersion; readonly source: 'header' | 'workspace' }
  | {
      readonly ok: false
      readonly requested: string
      readonly supported: readonly ApiVersion[]
    }

/**
 * Which version this request speaks.
 *
 * An unknown header is refused rather than ignored. Silently serving the
 * workspace's pin to a client that explicitly asked for something else would
 * mean the client believes it is talking to a version that does not exist, and
 * would find out at the first field that moved.
 */
export function resolveApiVersion(
  header: string | null | undefined,
  workspacePin: string,
): VersionResolution {
  if (header !== null && header !== undefined && header !== '') {
    if (!isApiVersion(header)) {
      return { ok: false, requested: header, supported: API_VERSIONS }
    }
    return { ok: true, version: header, source: 'header' }
  }
  if (!isApiVersion(workspacePin)) {
    // A pin that is no longer a version is a data problem, not a client
    // problem: serve the default rather than failing every request in the
    // workspace, and let the mismatch be visible in the response header.
    return { ok: true, version: DEFAULT_API_VERSION, source: 'workspace' }
  }
  return { ok: true, version: workspacePin, source: 'workspace' }
}
