import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { isRetryableStoreError, MemoryOutbox } from '../src/outbox.ts'
import { MemoryVaultStore } from '../src/store.ts'

function rememberPayload(content: string) {
  return {
    content, kind: 'fact' as const, track: 'global' as const, domain: 'general',
    importance: 0.8, confidence: 1, tags: [], entities: [], relations: [],
    status: 'active' as const, now: 1000,
  }
}

describe('MemoryOutbox', () => {
  it('classifies retryable store errors', () => {
    assert.equal(isRetryableStoreError(new Error('SQLITE_BUSY: database is locked')), true)
    assert.equal(isRetryableStoreError(new Error('disk I/O error')), true)
    assert.equal(isRetryableStoreError(new Error('content must not be empty')), false)
  })

  it('replays pending entries in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-outbox-'))
    const outbox = new MemoryOutbox(dir)
    outbox.enqueue({ type: 'remember', payload: rememberPayload('第一条重放记忆') })
    outbox.enqueue({ type: 'remember', payload: rememberPayload('第二条重放记忆') })
    const store = new MemoryVaultStore(':memory:')
    const result = outbox.replay(store)
    assert.equal(result.replayed, 2)
    assert.equal(result.pending, 0)
    assert.equal(store.list({ limit: 10 }).length, 2)
    // Second replay finds nothing pending.
    assert.equal(outbox.replay(store).replayed, 0)
    store.close()
  })
})
