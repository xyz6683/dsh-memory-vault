/** In-process integration test: real cordis context with real DSH services. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as MemoryVault from '../src/index.ts'
import type { Config } from '../src/index.ts'

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    path: ':memory:',
    outboxDirectory: join(mkdtempSync(join(tmpdir(), 'vault-outbox-')), 'outbox'),
    exportDirectory: mkdtempSync(join(tmpdir(), 'vault-export-')),
    autoRecall: true,
    autoRecallLimit: 5,
    autoRecallMinScore: 0,
    maxContextChars: 2000,
    maxContextTokens: 1000,
    recallPreviewTokens: 220,
    maxQueryChars: 1000,
    halfLifeDays: 30,
    maxGraphHops: 2,
    domainBoost: 0.1,
    domains: ['dev', 'career', 'workflow', 'english', 'investment', 'general'],
    defaultDomain: 'general',
    explicitWritesActive: true,
    autoExtract: false,
    extractMinConfidence: 0.65,
    archiveRetentionDays: 30,
    extractEveryTurns: 1,
    extractMaxInputChars: 16_000,
    extractMaxInputTokens: 6000,
    extractMaxOutputTokens: 3200,
    extractTimeoutMs: 60_000,
    extractMaxMemories: 8,
    extractConcurrency: 2,
    extractMaxAttempts: 2,
    extractRetryBaseMs: 0,
    captureToolResults: false,
    toolResultMaxTokens: 500,
    profileMaxOutputTokens: 2400,
    profileTimeoutMs: 60_000,
    visualizationEnabled: true,
    visualizationTrustedHosts: [],
    weights: { lexical: 0.4, graph: 0.25, importance: 0.2, recency: 0.1, access: 0.05, domain: 0.1 },
    ...overrides,
  }
}

async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(MemoryVault, config(overrides))
  return { ctx, fiber }
}

let callIndex = 0
function call(ctx: Context, tool: string, args: unknown) {
  return ctx.tools.execute({
    callId: `vault-test-${++callIndex}` as unknown as ToolCallId,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
  })
}

interface RememberValue { memoryId: string; deduplicated: boolean }
interface RecallValue { results: Array<{ id: string; content: string }> }
interface ReviewValue { ok: boolean; suggestions: Array<{ id: string }> }

describe('dsh-memory-vault plugin', () => {
  it('registers tools: vault_add then vault_recall finds the memory', async () => {
    const { ctx, fiber } = await setup()
    const added = await call(ctx, 'vault_add', {
      content: '项目部署端口是 8080，使用 docker compose 启动。',
      kind: 'fact', track: 'global', domain: 'dev', tags: ['deploy'],
    })
    assert.equal(added.isError, false)
    const data = added.value as unknown as RememberValue
    assert.equal(data.deduplicated, false)
    const recalled = await call(ctx, 'vault_recall', { query: '部署端口是多少' })
    assert.equal(recalled.isError, false)
    const recallData = recalled.value as unknown as RecallValue
    assert.ok(recallData.results.some(result => result.id === data.memoryId))
    await fiber.dispose()
  })

  it('injects recall context on the first pre-step only', async () => {
    const { ctx, fiber } = await setup()
    await call(ctx, 'vault_add', {
      content: 'The user prefers concise answers.',
      kind: 'preference', importance: 1,
    })
    const agent = { id: 'vault-agent' } as unknown as Agent
    const message = createUserMessage({
      content: [{ type: 'text', text: 'How should I answer this user?' }],
      source: { kind: 'user' },
    })
    const dispatch = agentEvents(ctx, agent)
    const first = await dispatch.waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    assert.equal(first.kind, 'enter')
    assert.equal(first.messages.length, 2)
    const injected = first.messages[1]!
    const source = injected.source as { kind: string; form: string }
    assert.equal(source.kind, 'memory-vault')
    assert.equal(source.form, 'snapshot')
    const text = (injected.content[0] as { text: string }).text
    assert.ok(text.includes('concise answers'))
    assert.ok(text.includes('memory_vault_context'))
    // Step 2 must not inject again.
    const second = await dispatch.waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    assert.deepEqual(second, { kind: 'enter', messages: [message] })
    await fiber.dispose()
  })

  it('exposes the confirmation queue tools (empty until M2 extraction)', async () => {
    const { ctx, fiber } = await setup()
    const listed = await call(ctx, 'vault_review', { action: 'list' })
    assert.equal(listed.isError, false)
    const listData = listed.value as unknown as ReviewValue
    assert.equal(listData.ok, true)
    assert.equal(listData.suggestions.length, 0)
    const bogus = await call(ctx, 'vault_review', { action: 'approve', suggestionId: 'does-not-exist' })
    assert.equal(bogus.isError, false)
    const bogusData = bogus.value as unknown as ReviewValue
    assert.equal(bogusData.ok, false)
    await fiber.dispose()
  })

  it('rejects unknown domains on write', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'vault_add', { content: 'test', domain: 'unknown-domain' })
    assert.equal(result.isError, true)
    await fiber.dispose()
  })

  it('validates config: unknown default domain fails loudly', async () => {
    // All injected services must be present or cordis defers assembly without
    // running apply (declared injections are a precondition, not an error).
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await assert.rejects(async () => { await ctx.plugin(MemoryVault, config({ defaultDomain: 'not-listed' })) }, /defaultDomain/)
    await ctx.fiber.dispose()
  })

  it('vault_profile aggregates the vault without a narrative', async () => {
    const { ctx, fiber } = await setup()
    await call(ctx, 'vault_add', { content: '用户偏好先结论后细节。', kind: 'preference', track: 'user', domain: 'general' })
    await call(ctx, 'vault_add', { content: '部署用 docker compose。', kind: 'fact', domain: 'dev' })
    const result = await call(ctx, 'vault_profile', {})
    assert.equal(result.isError, false)
    const value = result.value as unknown as { profile: { overview: { total: number; byDomain: Record<string, number> }; preferences: unknown[] } }
    assert.equal(value.profile.overview.total, 2)
    assert.equal(value.profile.preferences.length, 1)
    assert.ok(value.profile.overview.byDomain.dev === 1)
    await fiber.dispose()
  })
})
