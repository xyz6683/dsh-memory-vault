/** Same-origin Web route handler tests (mock request/response). */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemoryVaultStore } from '../src/store.ts'
import {
  actionHandler, isTrustedVaultRequest, snapshotHandler, validateTrustedHost,
} from '../src/web-route.ts'
import type { VaultRouteSettings } from '../src/web-route.ts'

function settings(overrides: Partial<VaultRouteSettings> = {}): VaultRouteSettings {
  return {
    refreshMs: 5000,
    trustedHosts: [],
    token: 'test-token',
    exportDirectory: '/tmp/vault-route-export',
    defaults: { autoRecall: true, domains: ['dev', 'general'], defaultDomain: 'general' },
    outboxSize: () => 0,
    ...overrides,
  }
}

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function mockResponse(): MockResponse & { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void } {
  const state = { status: 0, headers: {}, body: '' } as MockResponse
  return {
    get status() { return state.status },
    get headers() { return state.headers },
    get body() { return state.body },
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = headers
    },
    end(body = '') {
      state.body = body
    },
  }
}

function mockRequest(method: string, url: string, headers: Record<string, string> = {}): Record<string, unknown> & { headers: Record<string, string> } {
  return {
    method,
    url,
    headers,
    async * [Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({}))
    },
  }
}

describe('web routes', () => {
  it('rejects non-loopback cross-site reads', () => {
    const request = { headers: { host: 'evil.example.com', 'sec-fetch-site': 'cross-site' } }
    assert.equal(isTrustedVaultRequest(request, []), false)
  })

  it('accepts loopback same-origin reads', () => {
    const request = { headers: { host: '127.0.0.1:3080' } }
    assert.equal(isTrustedVaultRequest(request, []), true)
  })

  it('validates trusted host entries', () => {
    assert.throws(() => validateTrustedHost('http://bad'), /host or host:port/)
    validateTrustedHost('lan.example.com:8080')
  })

  it('serves a snapshot with memories, stats, and suggestions', () => {
    const store = new MemoryVaultStore(':memory:')
    store.remember({
      content: '路由测试记忆。', kind: 'fact', track: 'global', domain: 'general',
      importance: 0.8, confidence: 1, tags: [], entities: [], relations: [],
      status: 'active', now: 1000,
    })
    const handler = snapshotHandler(store, settings())
    const response = mockResponse()
    handler(mockRequest('GET', '/mvault/snapshot?domain=general', { host: '127.0.0.1:3080' }) as never, response as never)
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body) as { memories: unknown[]; stats: { active: number } }
    assert.equal(body.memories.length, 1)
    assert.equal(body.stats.active, 1)
    store.close()
  })

  it('blocks writes without the process token', async () => {
    const store = new MemoryVaultStore(':memory:')
    const handler = actionHandler(store, settings())
    const response = mockResponse()
    const request = mockRequest('POST', '/mvault/action', {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      'x-mvault-token': 'wrong-token',
    })
    await handler(request as never, response as never)
    assert.equal(response.status, 403)
    store.close()
  })

  it('approves suggestions through the guarded action endpoint', async () => {
    const store = new MemoryVaultStore(':memory:')
    const { id } = store.addSuggestion({
      content: '用户偏好测试驱动开发。', kind: 'preference', track: 'user', domain: 'general',
      importance: 0.7, confidence: 0.8, tags: [], entities: [], relations: [],
      reason: '测试', createdAt: 1000,
    })
    const handler = actionHandler(store, settings())
    const response = mockResponse()
    const request = mockRequest('POST', '/mvault/action', {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      'x-mvault-token': 'test-token',
    })
    // Replace the body iterator with the actual action payload.
    Object.assign(request, {
      async * [Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ action: 'resolve-suggestion', suggestionId: id, decision: 'approve' }))
      },
    })
    await handler(request as never, response as never)
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body) as { ok: boolean; memoryId?: string }
    assert.equal(body.ok, true)
    assert.ok(body.memoryId !== undefined)
    store.close()
  })
})
