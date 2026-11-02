/**
 * dsh-memory-vault — local outbox for retryable write failures.
 *
 * Synchronous SQLite writes can fail transiently (SQLITE_BUSY, disk hiccups).
 * Retryable failures land in a private outbox directory as JSONL entries and
 * replay in order at the next startup; entries that fail permanently move to
 * a dead-letter file so they stay visible instead of silently disappearing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryVaultStore } from './store.ts'
import type { RememberInput } from './types.ts'

export type OutboxEntry = { type: 'remember'; payload: RememberInput }

/** True when a thrown store error may succeed on a later retry. */
export function isRetryableStoreError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|disk I\/O error/iu.test(message)
}

export interface ReplayResult {
  replayed: number
  pending: number
  deadLettered: number
}

/** Per-directory append-only retry queue with startup replay. */
export class MemoryOutbox {
  private readonly directory: string
  private readonly deadLetterPath: string

  constructor(directory: string) {
    this.directory = directory
    this.deadLetterPath = join(directory, 'dead-letter.jsonl')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  /** Enqueue one entry for later replay. */
  enqueue(entry: OutboxEntry): void {
    writeFileSync(join(this.directory, 'pending.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a', mode: 0o600 })
  }

  /** Replay pending entries in order; failed ones go to the dead-letter file. */
  replay(store: MemoryVaultStore): ReplayResult {
    const path = join(this.directory, 'pending.jsonl')
    if (!existsSync(path)) return { replayed: 0, pending: 0, deadLettered: 0 }
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
    let replayed = 0
    let deadLettered = 0
    const pending: string[] = []
    for (const line of lines) {
      let entry: OutboxEntry
      try {
        entry = JSON.parse(line) as OutboxEntry
      } catch {
        deadLettered++
        continue
      }
      try {
        if (entry.type === 'remember') {
          store.remember(entry.payload)
        }
        replayed++
      } catch {
        pending.push(line)
      }
    }
    if (pending.length > 0) {
      writeFileSync(path, `${pending.join('\n')}\n`, { mode: 0o600 })
      if (replayed === 0 && deadLettered === 0) return { replayed: 0, pending: pending.length, deadLettered: 0 }
    } else {
      renameSync(path, `${path}.done-${Date.now()}`)
    }
    if (deadLettered > 0) {
      // Preserve the unparseable lines for manual inspection.
      const unparsed = lines.filter(line => { try { JSON.parse(line); return false } catch { return true } })
      if (unparsed.length > 0) writeFileSync(this.deadLetterPath, `${unparsed.join('\n')}\n`, { flag: 'a', mode: 0o600 })
    }
    return { replayed, pending: pending.length, deadLettered }
  }

  /** Number of lines currently pending replay (Web badge). */
  size(): number {
    const path = join(this.directory, 'pending.jsonl')
    if (!existsSync(path)) return 0
    return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').length
  }
}
