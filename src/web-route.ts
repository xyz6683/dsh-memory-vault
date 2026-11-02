/**
 * dsh-memory-vault — same-origin Web routes for the memory dashboard.
 *
 * GET  /memory-vault/snapshot  — memory list + stats + settings (ETag-cached).
 * POST /memory-vault/action    — token-guarded mutations (approve/reject
 *                                suggestion, forget, archive, unarchive).
 *
 * Reads are fenced behind a loopback/trusted-host + fetch-metadata check so a
 * remote page cannot silently read local memories; mutations additionally
 * require the process-random token and a JSON content type.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryVaultStore } from './store.ts'
import type { MemoryKind, MemoryStatus, MemoryTrack } from './types.ts'

export const SNAPSHOT_PATH = '/mvault/snapshot'
export const ACTION_PATH = '/mvault/action'

const STATUS_VALUES = new Set<MemoryStatus>(['active', 'pending', 'archived', 'superseded'])
const TRACK_VALUES = new Set<MemoryTrack>(['user', 'global', 'project', 'project-log', 'daily-log'])
const KIND_VALUES = new Set<MemoryKind>(['preference', 'fact', 'decision', 'constraint', 'lesson', 'sop', 'event', 'summary'])

export interface VaultRouteSettings {
  refreshMs: number
  trustedHosts: readonly string[]
  token: string
  exportDirectory: string
  defaults: {
    autoRecall: boolean
    domains: readonly string[]
    defaultDomain: string
  }
  outboxSize: () => number
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function authority(value: string): URL | undefined {
  try {
    return new URL(`http://${value}`)
  } catch {
    return undefined
  }
}

function loopback(hostname: string): boolean {
  const value = hostname.toLocaleLowerCase('en-US')
  if (value === 'localhost' || value.endsWith('.localhost') || value === '[::1]') return true
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part))
}

/** Validate one explicit non-loopback authority at configuration load. */
export function validateTrustedHost(value: string): void {
  if (value.trim() !== value || value === '' || /[/@]/.test(value)) {
    throw new Error(`memory vault: visualizationTrustedHosts entry ${JSON.stringify(value)} must be host or host:port`)
  }
  const parsed = authority(value)
  if (parsed === undefined || parsed.hostname === '') {
    throw new Error(`memory vault: visualizationTrustedHosts entry ${JSON.stringify(value)} must be host or host:port`)
  }
}

/** Same-origin and Host fence for local memory reads. */
export function isTrustedVaultRequest(
  request: { headers: IncomingHttpHeaders },
  trustedHosts: readonly string[],
): boolean {
  const rawHost = header(request.headers, 'host')
  if (rawHost === undefined) return false
  const host = authority(rawHost)
  if (host === undefined) return false
  const allowed = loopback(host.hostname) || trustedHosts.some((entry) => {
    const trusted = authority(entry)
    if (trusted === undefined) return false
    return trusted.port === '' ? trusted.hostname === host.hostname : trusted.host === host.host
  })
  if (!allowed || header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const value = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(value)),
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(value)
}

/** GET-only snapshot: memory list, stats, facets, and dashboard settings. */
export function snapshotHandler(store: MemoryVaultStore, settings: VaultRouteSettings) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    if (!isTrustedVaultRequest(request, settings.trustedHosts)) {
      response.writeHead(403)
      response.end('forbidden')
      return
    }
    const url = new URL(request.url ?? SNAPSHOT_PATH, 'http://mvault.local')
    const rawStatus = url.searchParams.get('status')?.slice(0, 20)
    const rawTrack = url.searchParams.get('track')?.slice(0, 20)
    const rawDomain = url.searchParams.get('domain')?.slice(0, 80)
    const rawKind = url.searchParams.get('kind')?.slice(0, 20)
    const rawQuery = url.searchParams.get('query')?.slice(0, 200)
    const query = rawQuery === undefined || rawQuery === '' ? undefined : rawQuery
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100))
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0)
    const status = rawStatus !== null && STATUS_VALUES.has(rawStatus as MemoryStatus) ? rawStatus as MemoryStatus : undefined
    const track = rawTrack !== null && TRACK_VALUES.has(rawTrack as MemoryTrack) ? rawTrack as MemoryTrack : undefined
    const kind = rawKind !== null && KIND_VALUES.has(rawKind as MemoryKind) ? rawKind as MemoryKind : undefined
    const domain = rawDomain !== null && rawDomain !== '' && rawDomain !== 'all' ? rawDomain : undefined
    const etag = `"vault-${Date.now().toString(36)}"`
    const body = JSON.stringify({
      memories: store.list({
        ...(status === undefined ? {} : { status }),
        ...(track === undefined ? {} : { track }),
        ...(domain === undefined ? {} : { domain }),
        ...(kind === undefined ? {} : { kind }),
        ...(query === undefined ? {} : { query }),
        limit,
        offset,
      }),
      stats: store.stats(),
      facets: store.facets(),
      suggestions: store.suggestions('pending', 50),
      profile: store.profileData(undefined, 30),
      config: {
        refreshMs: settings.refreshMs,
        ...settings.defaults,
        outboxPending: settings.outboxSize(),
        token: settings.token,
      },
    })
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      etag,
      'x-content-type-options': 'nosniff',
    })
    response.end(body)
  }
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (Buffer.byteLength(body) > 8192) throw new Error('request body exceeds 8192 bytes')
  }
  return JSON.parse(body) as unknown
}

/** Same-origin, token-guarded mutation endpoint. */
export function actionHandler(store: MemoryVaultStore, settings: VaultRouteSettings) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isTrustedVaultRequest(request, settings.trustedHosts)
      || header(request.headers, 'x-mvault-token') !== settings.token
      || !header(request.headers, 'content-type')?.toLocaleLowerCase('en-US').startsWith('application/json')) {
      response.writeHead(403)
      response.end('forbidden')
      return
    }
    try {
      const body = await requestBody(request)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('request must be an object')
      const record = body as Record<string, unknown>
      if (record.action === 'resolve-suggestion') {
        if (typeof record.suggestionId !== 'string' || record.suggestionId.trim() === '' || record.suggestionId.length > 100) {
          throw new Error('suggestionId is invalid')
        }
        const decision = record.decision === 'approve' || record.decision === 'reject' ? record.decision : undefined
        if (decision === undefined) throw new Error('decision must be approve or reject')
        json(response, 200, store.resolveSuggestion(record.suggestionId, decision))
        return
      }
      if (record.action === 'forget-memory') {
        if (typeof record.memoryId !== 'string' || record.memoryId.trim() === '' || record.memoryId.length > 100) {
          throw new Error('memoryId is invalid')
        }
        json(response, 200, { ok: true, deleted: store.forget(record.memoryId) })
        return
      }
      if (record.action === 'archive-memory') {
        if (typeof record.memoryId !== 'string' || record.memoryId.trim() === '' || record.memoryId.length > 100) {
          throw new Error('memoryId is invalid')
        }
        json(response, 200, { ok: true, archived: store.archive(record.memoryId) })
        return
      }
      if (record.action === 'unarchive-memory') {
        if (typeof record.memoryId !== 'string' || record.memoryId.trim() === '' || record.memoryId.length > 100) {
          throw new Error('memoryId is invalid')
        }
        json(response, 200, { ok: true, unarchived: store.unarchive(record.memoryId) })
        return
      }
      if (record.action === 'export-markdown') {
        const result = store.exportMarkdown(settings.exportDirectory)
        json(response, 200, { ok: true, ...result })
        return
      }
      throw new Error('action is unsupported')
    } catch (error: unknown) {
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
