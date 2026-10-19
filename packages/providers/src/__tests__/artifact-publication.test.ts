import { expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesystemArtifactStore } from '../artifacts/filesystem-store.js'

it('publishes one complete artifact under racing writers and readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inrsettle-publication-'))
  const store = createFilesystemArtifactStore({ root })
  const key = 'receipts/concurrent.pdf'
  const payloads = [Buffer.alloc(2 * 1024 * 1024, 0x41), Buffer.alloc(2 * 1024 * 1024, 0x42)]
  try {
    const writes = Promise.all(payloads.map(bytes => store.putIfAbsent({ key, bytes, contentType: 'application/pdf' })))
    for (let i = 0; i < 20; i++) {
      const read = await store.get(key)
      if (read) expect(payloads.some(bytes => bytes.equals(Buffer.from(read.bytes)))).toBe(true)
    }
    const results = await writes
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const saved = (await store.get(key))!
    expect(payloads.some(bytes => bytes.equals(Buffer.from(saved.bytes)))).toBe(true)
    expect(await readdir(join(root, 'receipts'))).toEqual(['concurrent.pdf'])
    expect((await store.putIfAbsent({ key, bytes: Buffer.from('replacement'), contentType: 'application/pdf' })).ok).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
