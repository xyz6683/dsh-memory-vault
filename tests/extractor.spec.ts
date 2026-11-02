/** M2: extraction pipeline unit + end-to-end integration tests. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as MemoryVault from '../src/index.ts'
import type { Config } from '../src/index.ts'
import {
  clipArchivedMessages, parseExtractedSummary, trackForKind,
} from '../src/extractor.ts'
import { MemoryVaultStore } from '../src/store.ts'

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
    autoExtract: true,
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
    extractProvider: 'extractor-test',
    extractModel: 'extractor',
    captureToolResults: false,
    toolResultMaxTokens: 500,
    profileMaxOutputTokens: 2400,
    profileTimeoutMs: 60_000,
    visualizationEnabled: false,
    visualizationTrustedHosts: [],
    weights: { lexical: 0.4, graph: 0.25, importance: 0.2, recency: 0.1, access: 0.05, domain: 0.1 },
    ...overrides,
  }
}

describe('extraction primitives', () => {
  it('parses a valid model response with an SOP candidate', () => {
    const parsed = parseExtractedSummary(JSON.stringify({
      summary: '用户确定了发版流程。',
      memories: [{
        content: '用户的标准发版流程。', kind: 'sop', importance: 0.9, confidence: 0.95,
        stableKey: 'release-sop', steps: ['跑测试', '打 tag', '推送'],
        tags: ['release'], entities: [{ name: 'dsh-memory-vault', kind: 'plugin' }],
        relations: [],
      }],
    }), 8)
    assert.equal(parsed.memories.length, 1)
    assert.equal(parsed.memories[0]!.kind, 'sop')
    assert.deepEqual(parsed.memories[0]!.steps, ['跑测试', '打 tag', '推送'])
  })

  it('rejects malformed and schema-violating responses', () => {
    assert.throws(() => parseExtractedSummary('not json at all', 8), /no JSON object/)
    const base = { tags: [], entities: [], relations: [] }
    assert.throws(() => parseExtractedSummary(JSON.stringify({ summary: 'x', memories: [{ ...base, content: '', kind: 'fact', importance: 0.9, confidence: 0.9 }] }), 8), /content/)
    assert.throws(() => parseExtractedSummary(JSON.stringify({ summary: 'x', memories: [{ ...base, content: 'a', kind: 'fact', importance: 2, confidence: 0.9 }] }), 8), /importance/)
    assert.throws(() => parseExtractedSummary(JSON.stringify({ summary: 'x', memories: [{ ...base, content: 'a', kind: 'sop', importance: 0.9, confidence: 0.9, steps: [''] }] }), 8), /steps/)
  })

  it('maps kinds to tracks deterministically', () => {
    assert.equal(trackForKind('preference'), 'user')
    assert.equal(trackForKind('event'), 'daily-log')
    assert.equal(trackForKind('summary'), 'daily-log')
    assert.equal(trackForKind('sop'), 'global')
    assert.equal(trackForKind('lesson'), 'global')
  })

  it('clips archive tails to a character budget', () => {
    const messages = [
      { seq: 1, role: 'user', text: 'x'.repeat(3000) },
      { seq: 2, role: 'assistant', text: 'y'.repeat(3000) },
    ]
    const clipped = clipArchivedMessages(messages, 1000, 10_000)
    assert.equal(clipped.truncated, true)
    assert.ok(clipped.messages.length >= 1)
  })

  it('deduplicates extraction candidates against active and pending content', () => {
    const store = new MemoryVaultStore(':memory:')
    const candidate = (content: string) => ({
      content, kind: 'fact' as const, track: 'global' as const, domain: 'general',
      importance: 0.8, confidence: 0.9, tags: [] as string[],
      entities: [] as Array<{ name: string }>, relations: [] as Array<{ source: string; predicate: string; target: string }>,
    })
    const first = store.commitExtraction({
      sessionId: 's1', turn: 1, sourceEventSeqs: [1], summary: 'sum',
      candidates: [candidate('端口是 8080。')], provider: 'p', model: 'm',
      requestJson: '{}', responseJson: '{}', reason: '测试', now: 1000,
    })
    assert.equal(first.suggestionIds.length, 1)
    // Same content again (another turn): no duplicate suggestion.
    const second = store.commitExtraction({
      sessionId: 's1', turn: 2, sourceEventSeqs: [2], summary: 'sum',
      candidates: [candidate('端口是 8080。')], provider: 'p', model: 'm',
      requestJson: '{}', responseJson: '{}', reason: '测试', now: 2000,
    })
    assert.equal(second.suggestionIds.length, 0)
    // After approval the content is active: extraction dedups against it too.
    store.resolveSuggestion(first.suggestionIds[0]!, 'approve', 3000)
    const third = store.commitExtraction({
      sessionId: 's1', turn: 3, sourceEventSeqs: [3], summary: 'sum',
      candidates: [candidate('端口是 8080。')], provider: 'p', model: 'm',
      requestJson: '{}', responseJson: '{}', reason: '测试', now: 4000,
    })
    assert.equal(third.suggestionIds.length, 0)
    store.close()
  })
})

/** Fake adapter returning one high-confidence preference candidate. */
class ExtractorAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const value = JSON.stringify({
      summary: '用户确认了回答风格偏好。',
      memories: [{
        content: '用户偏好先给结论再给细节。', kind: 'preference', importance: 0.9, confidence: 0.96,
        stableKey: 'user.pref.answer-style', tags: ['style'],
        entities: [], relations: [],
      }],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let callIndex = 0
function call(ctx: Context, tool: string, args: unknown) {
  return ctx.tools.execute({
    callId: `vault-extract-${++callIndex}` as unknown as ToolCallId,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
  })
}

interface ReviewValue { ok: boolean; suggestions: Array<{ id: string; content: string }> }
interface RecallValue { results: Array<{ id: string; content: string }> }

describe('automatic extraction end to end', () => {
  it('completed turn → extraction → confirmation queue → approve → recallable', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const adapter = new ExtractorAdapter()
    ctx.llm.registerAdapter(['extractor-test'], adapter)
    await ctx.plugin(MemoryVault, config())

    // Build one completed turn with durable events.
    const session = ctx.sessions.create(SessionId('extract-session'))
    session.append('request/header', {
      header: { config: { provider: 'extractor-test', model: 'extractor' } }, reason: 'initial',
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '以后回答我问题时，请先给结论再给细节。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '好的，我记住了：先结论后细节。' }],
        source: { provider: 'extractor-test', model: 'extractor' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Wait for the background extraction to file the candidate.
    const deadline = Date.now() + 8000
    let pending: ReviewValue = { ok: true, suggestions: [] }
    while (Date.now() < deadline) {
      const listed = await call(ctx, 'mvault_review', { action: 'list' })
      pending = listed.value as unknown as ReviewValue
      if (pending.suggestions.length > 0) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(adapter.requests.length, 1)
    assert.equal(pending.suggestions.length, 1)
    assert.ok(pending.suggestions[0]!.content.includes('先给结论'))

    // Approve through the tool; the memory must become recallable.
    const approved = await call(ctx, 'mvault_review', { action: 'approve', suggestionId: pending.suggestions[0]!.id })
    const approvedValue = approved.value as unknown as { ok: boolean; memoryId?: string }
    assert.equal(approvedValue.ok, true)
    assert.ok(approvedValue.memoryId !== undefined)
    const recalled = await call(ctx, 'mvault_recall', { query: '先给结论' })
    const recallData = recalled.value as unknown as RecallValue
    assert.ok(recallData.results.some(result => result.id === approvedValue.memoryId))

    // The extraction is idempotent: a second run for the same turn must not duplicate.
    await ctx.fiber.dispose()
  })
})
