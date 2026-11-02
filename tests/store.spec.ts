import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MemoryVaultStore, normalizeEntity, normalizePredicate, slugify } from '../src/store.ts'
import type { RetrievalWeights } from '../src/types.ts'

const weights: RetrievalWeights = {
  lexical: 0.4,
  graph: 0.25,
  importance: 0.2,
  recency: 0.1,
  access: 0.05,
  domain: 0.1,
}

function recall(store: MemoryVaultStore, query: string, options: Partial<Parameters<MemoryVaultStore['recall']>[1]> = {}) {
  return store.recall(query, {
    limit: 10, hops: 2, halfLifeDays: 30, weights, domainBoost: 0.1,
    domainScores: new Map(), now: 1_800_000_000_000, ...options,
  })
}

function add(store: MemoryVaultStore, content: string, extra: Partial<Parameters<MemoryVaultStore['remember']>[0]> = {}) {
  return store.remember({
    content, kind: 'fact', track: 'global', domain: 'general', importance: 0.8, confidence: 1,
    tags: [], entities: [], relations: [], status: 'active', now: 1_800_000_000_000, ...extra,
  })
}

describe('MemoryVaultStore', () => {
  it('stores memories and recalls them with hybrid ranking', () => {
    const store = new MemoryVaultStore(':memory:')
    add(store, 'The project deploys on port 8080.', { domain: 'dev', tags: ['deploy'] })
    add(store, '用户偏好简洁的中文回答。', { kind: 'preference', track: 'user', domain: 'general' })
    const results = recall(store, 'deployment port')
    assert.ok(results.length > 0)
    assert.ok(results[0]!.content.includes('8080'))
    assert.ok(results[0]!.reasons.includes('lexical'))
    // Short Chinese terms hit the substring fallback.
    const preference = recall(store, '偏好 回答')
    assert.ok(preference.some(result => result.kind === 'preference'))
    store.close()
  })

  it('recalls Chinese content through trigram FTS', () => {
    const store = new MemoryVaultStore(':memory:')
    add(store, '项目部署端口是 8080，使用 docker compose 启动。', { domain: 'dev' })
    const results = recall(store, '部署端口是多少')
    assert.ok(results.some(result => result.content.includes('8080')))
    store.close()
  })

  it('supersedes stable facts and supports revert', () => {
    const store = new MemoryVaultStore(':memory:')
    const first = add(store, 'The API gateway URL is http://old.local.', { stableKey: 'api-gateway-url' })
    const second = add(store, 'The API gateway URL is http://new.local.', { stableKey: 'api-gateway-url' })
    assert.equal(second.supersededMemoryId, first.memoryId)
    const results = recall(store, 'api gateway url')
    assert.equal(results.length, 1)
    assert.ok(results[0]!.content.includes('new.local'))
    const reverted = store.revert(second.memoryId)
    assert.equal(reverted.restoredMemoryId, first.memoryId)
    const after = recall(store, 'api gateway url')
    assert.ok(after[0]!.content.includes('old.local'))
    store.close()
  })

  it('stores SOP steps and round-trips them', () => {
    const store = new MemoryVaultStore(':memory:')
    const result = add(store, '发版流程 SOP', {
      kind: 'sop', domain: 'workflow',
      steps: ['跑测试', '打 tag', '推送远端'],
    })
    const row = store.memory(result.memoryId)
    assert.deepEqual(JSON.parse(row!.steps!), ['跑测试', '打 tag', '推送远端'])
    const found = recall(store, '发版流程')
    assert.equal(found[0]!.hasSteps, true)
    store.close()
  })

  it('builds entities, aliases, and relations', () => {
    const store = new MemoryVaultStore(':memory:')
    const first = add(store, 'dsh-memory-vault uses SQLite for storage.', {
      entities: [{ name: 'dsh-memory-vault', kind: 'plugin', aliases: ['vault'] }],
      relations: [{ source: 'dsh-memory-vault', predicate: 'uses', target: 'SQLite' }],
    })
    assert.ok(first.entityCount > 0)
    const graph = store.graph('dsh-memory-vault', 2, 20)
    assert.ok(graph.nodes.some(node => node.name === 'SQLite'))
    assert.ok(graph.edges.some(edge => edge.predicate === 'uses'))
    store.close()
  })

  it('deduplicates identical active content', () => {
    const store = new MemoryVaultStore(':memory:')
    const first = add(store, 'The CI pipeline uses GitHub Actions.')
    const second = add(store, 'The CI pipeline uses GitHub Actions.')
    assert.equal(second.deduplicated, true)
    assert.equal(second.memoryId, first.memoryId)
    store.close()
  })

  it('runs the confirmation queue: pending → approve lands active', () => {
    const store = new MemoryVaultStore(':memory:')
    const { id } = store.addSuggestion({
      content: '用户希望代码注释用中文。', kind: 'preference', track: 'user', domain: 'general',
      importance: 0.7, confidence: 0.8, tags: [], entities: [], relations: [],
      reason: '提取自对话', sourceSession: 's1', sourceTurn: 3, createdAt: 1000,
    })
    assert.equal(store.pendingSuggestionCount(), 1)
    const rejected = store.resolveSuggestion(id, 'reject')
    assert.equal(rejected.ok, true)
    assert.equal(store.pendingSuggestionCount(), 0)
    const second = store.addSuggestion({
      content: '用户偏好先给结论再给细节。', kind: 'preference', track: 'user', domain: 'general',
      importance: 0.7, confidence: 0.8, tags: [], entities: [], relations: [],
      reason: '提取自对话', createdAt: 2000,
    })
    const approved = store.resolveSuggestion(second.id, 'approve')
    assert.equal(approved.ok, true)
    assert.ok(approved.memoryId !== undefined)
    const results = recall(store, '先给结论')
    assert.ok(results.some(result => result.id === approved.memoryId))
    store.close()
  })

  it('exports Markdown tracks and domain views', () => {
    const store = new MemoryVaultStore(':memory:')
    add(store, '用户是网页开发者。', { kind: 'preference', track: 'user', domain: 'career' })
    add(store, '部署端口 8080。', { track: 'project', domain: 'dev', project: 'my-site', branches: ['main'] })
    add(store, '今天完成召回模块。', { track: 'daily-log', domain: 'general' })
    const dir = mkdtempSync(join(tmpdir(), 'vault-export-'))
    const exported = store.exportMarkdown(dir)
    // Track files: 3 entries; domain views repeat the two non-log entries: 5 total.
    assert.equal(exported.entries, 5)
    const userText = readFileSync(join(dir, 'USER.md'), 'utf8')
    assert.ok(userText.includes('网页开发者'))
    const keyText = readFileSync(join(dir, 'projects', 'my-site', 'KEY.md'), 'utf8')
    assert.ok(keyText.includes('[branch:main]'))
    assert.ok(keyText.includes('8080'))
    store.close()
  })

  it('round-trips a JSONL backup into an empty database', () => {
    const store = new MemoryVaultStore(':memory:')
    add(store, 'Backup round-trip fact.', { tags: ['backup'] })
    const dir = mkdtempSync(join(tmpdir(), 'vault-backup-'))
    const path = join(dir, 'snapshot.jsonl')
    store.exportJsonl(path)
    const restored = new MemoryVaultStore(':memory:')
    restored.importJsonl(path)
    const results = recall(restored, 'backup round-trip')
    assert.equal(results.length, 1)
    assert.throws(() => restored.importJsonl(path), /empty database/)
    restored.close()
    store.close()
  })

  it('aggregates profile data by domain', () => {
    const store = new MemoryVaultStore(':memory:')
    add(store, '用户偏好简洁回答。', { kind: 'preference', track: 'user', domain: 'general' })
    add(store, '发版 SOP', { kind: 'sop', domain: 'workflow', steps: ['跑测试', '打 tag'] })
    add(store, '教训：先备份再迁移。', { kind: 'lesson', domain: 'dev' })
    const profile = store.profileData(undefined, 10)
    assert.equal(profile.overview.total, 3)
    assert.equal(profile.preferences.length, 1)
    assert.equal(profile.sops[0]!.stepCount, 2)
    assert.ok(profile.overview.byDomain.workflow === 1)
    const devProfile = store.profileData('dev', 10)
    assert.equal(devProfile.overview.total, 1)
    assert.equal(devProfile.lessons.length, 1)
    store.close()
  })

  it('normalizes entities, predicates, and slugs', () => {
    assert.equal(normalizeEntity('  DeepSeek Harness '), 'deepseek harness')
    assert.equal(normalizePredicate('Developed By'), 'developed_by')
    assert.equal(slugify('../安全 目录/name'), '安全-目录-name')
  })
})
