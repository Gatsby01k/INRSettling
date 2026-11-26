import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export class SaberUncertainOperation extends Error {
  constructor(readonly operationId: string) {
    super('Saber operation has an uncertain outcome. Reconcile with Saber before any new submission.')
    this.name = 'SaberUncertainOperation'
  }
}
export interface SaberOperationJournal {
  execute(operationId: string, fingerprint: string, submit: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type RecordEntry = { version: 1; fingerprint: string; state: 'started' | 'succeeded'; result?: Record<string, unknown> }

/** One journal per merchant and machine. Exclusive create + fsync happens
 * BEFORE sending. A crash or error leaves `started`: it can only be queried,
 * never retried. This is a local guard, not a claim of provider idempotency. */
export function createSaberFileJournal(root: string, clientId: string): SaberOperationJournal {
  const directory = join(resolve(root), hash(clientId))
  const syncDirectory = async () => { const d = await open(directory, 'r'); try { await d.sync() } finally { await d.close() } }
  const saved = async (path: string, fingerprint: string, operationId: string) => {
    const record = JSON.parse(await readFile(path, 'utf8')) as RecordEntry
    if (record.version !== 1 || record.fingerprint !== fingerprint) throw new Error('Saber operation ID was reused with different terms or journal is invalid')
    if (record.state !== 'succeeded' || !record.result || typeof record.result !== 'object' || Array.isArray(record.result)) throw new SaberUncertainOperation(operationId)
    return record.result
  }
  return {
    async execute(operationId, fingerprint, submit) {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(operationId)) throw new Error('Saber operation ID must be a stable local reference')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, hash(operationId) + '.json')
      let file
      try { file = await open(path, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A simultaneous creator may still be writing. Refuse rather than submit.
        try { return await saved(path, fingerprint, operationId) }
        catch (error) { if (error instanceof SyntaxError) throw new SaberUncertainOperation(operationId); throw error }
      }
      try {
        await file.writeFile(JSON.stringify({ version: 1, fingerprint, state: 'started' } satisfies RecordEntry))
        await file.sync()
      } finally { await file.close() }
      await syncDirectory()
      const result = await submit()
      const temporary = path + '.' + randomUUID() + '.tmp'
      const completed = await open(temporary, 'wx', 0o600)
      try {
        await completed.writeFile(JSON.stringify({ version: 1, fingerprint, state: 'succeeded', result } satisfies RecordEntry))
        await completed.sync()
      } finally { await completed.close() }
      await rename(temporary, path)
      await syncDirectory()
      return result
    },
  }
}
