/** dsh-memory-vault client: sidebar Memory Vault panel (memories / queue / profile / export). */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

const SNAPSHOT_PATH = '/mvault/snapshot'
const ACTION_PATH = '/mvault/action'

interface SnapshotMemory {
  id: string
  content: string
  kind: string
  track: string
  domain: string
  importance: number
  confidence: number
  tags: string[]
  createdAt: number
}

interface SuggestionRow {
  id: string
  content: string
  kind: string
  domain: string
  reason?: string
  importance: number
  confidence: number
  sourceTurn?: number
}

interface ProfileEntryRow {
  id: string
  content: string
  kind: string
  domain: string
  importance: number
  stepCount: number
  updatedAt: number
}

interface VaultSnapshot {
  memories: SnapshotMemory[]
  stats: { total: number; active: number; pending: number; archived: number; byDomain: Record<string, number> }
  facets: { kinds: string[]; tracks: string[]; domains: string[] }
  suggestions: SuggestionRow[]
  profile: {
    overview: { total: number; byDomain: Record<string, number>; byKind: Record<string, number> }
    preferences: ProfileEntryRow[]
    sops: ProfileEntryRow[]
    lessons: ProfileEntryRow[]
    decisions: ProfileEntryRow[]
    constraints: ProfileEntryRow[]
  }
  config: {
    refreshMs: number
    autoRecall: boolean
    domains: string[]
    defaultDomain: string
    outboxPending: number
    token: string
  }
}

const card: CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
  borderRadius: 12,
  background: 'color-mix(in srgb, currentColor 4%, transparent)',
}

const button: CSSProperties = {
  padding: '5px 10px',
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: 8,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: '12px var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)',
}

/** One-line compact title derived from a memory's full content. */
function titleOf(content: string, max = 36): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

/** One memory row: compact title + collapsible details. */
function MemoryRow(props: { memory: SnapshotMemory; onForget: (id: string) => void }) {
  const { memory, onForget } = props
  const [expanded, setExpanded] = useState(false)
  return <article style={{ padding: 8, borderRadius: 8, background: 'color-mix(in srgb, currentColor 6%, transparent)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={memory.content}>
        {titleOf(memory.content)}
      </span>
      <span style={{ opacity: 0.55, fontSize: 11, flex: 'none' }}>{memory.kind} · {memory.domain}</span>
      <button type="button" style={button} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '详情'}</button>
      <button type="button" style={button} onClick={() => onForget(memory.id)}>删除</button>
    </div>
    {expanded && <>
      <div style={{ marginTop: 6, overflowWrap: 'anywhere', opacity: 0.88, whiteSpace: 'pre-wrap' }}>{memory.content}</div>
      <small style={{ display: 'block', opacity: 0.55, marginTop: 4 }}>
        {memory.track} · 重要度 {memory.importance}{memory.tags.length > 0 ? ` · ${memory.tags.join(' ')}` : ''} · {new Date(memory.createdAt).toLocaleDateString()}
      </small>
    </>}
  </article>
}

async function readSnapshot(query = '', domain = ''): Promise<VaultSnapshot> {
  const params = new URLSearchParams({ limit: '100' })
  if (query !== '') params.set('query', query)
  if (domain !== '') params.set('domain', domain)
  const response = await fetch(`${SNAPSHOT_PATH}?${params.toString()}`)
  if (!response.ok) throw new Error(`snapshot ${response.status}`)
  return await response.json() as VaultSnapshot
}

async function mutate(token: string, action: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(ACTION_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mvault-token': token,
    },
    body: JSON.stringify(action),
  })
  if (!response.ok) throw new Error(`action ${response.status}`)
  return await response.json() as unknown
}

type Tab = 'memories' | 'queue' | 'profile' | 'export'

function MemoryVaultPanel({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<VaultSnapshot>()
  const [tab, setTab] = useState<Tab>('memories')
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('')
  const [error, setError] = useState('')
  const [exportResult, setExportResult] = useState('')

  const refresh = async (): Promise<void> => {
    try {
      setSnapshot(await readSnapshot(query, domain))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, domain])

  const act = async (action: Record<string, unknown>, onDone?: () => void): Promise<void> => {
    if (snapshot === undefined) return
    try {
      await mutate(snapshot.config.token, action)
      setError('')
      onDone?.()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = useMemo(() => [
    { id: 'memories', label: '记忆' },
    { id: 'queue', label: `待确认${snapshot?.suggestions.length ? ` (${snapshot.suggestions.length})` : ''}` },
    { id: 'profile', label: '画像' },
    { id: 'export', label: '导出' },
  ], [snapshot?.suggestions.length])

  const total = snapshot?.stats.active ?? 0

  return <div style={{ position: 'relative', width: '100%', height: wide ? 44 : 36, flex: 'none' }}>
    {open && <section aria-label="Memory Vault" data-testid="memory-vault-panel" style={{ position: 'fixed', left: 12, bottom: 116, zIndex: 40, width: 'min(960px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 140px)', overflow: 'auto', padding: 10, boxSizing: 'border-box', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)', borderRadius: 14, background: 'Canvas', color: 'CanvasText', boxShadow: '0 18px 55px rgba(0,0,0,.22)', fontFamily: 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 8px' }}>
        <span style={{ flex: 1 }}><strong>Memory Vault</strong><small style={{ display: 'block', opacity: 0.58 }}>长期记忆 · 跨会话召回 · 个人画像</small></span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{total} active · {snapshot?.stats.pending ?? 0} pending</span>
        <button type="button" style={button} onClick={() => { void refresh() }}>Refresh</button>
        <button type="button" aria-label="Close memory vault" style={button} onClick={() => setOpen(false)}>×</button>
      </header>
      {error !== '' && <div role="alert" style={{ padding: 8, color: '#c94848' }}>{error}</div>}
      {snapshot === undefined
        ? <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>Loading…</div>
        : <>
          <nav style={{ display: 'flex', gap: 6, padding: '2px 4px 8px' }}>
            {tabs.map(item => <button key={item.id} type="button" onClick={() => setTab(item.id)} style={{ ...button, background: tab === item.id ? 'color-mix(in srgb, #6d5dfc 14%, transparent)' : 'transparent', borderColor: tab === item.id ? '#6d5dfc' : undefined }}>{item.label}</button>)}
          </nav>
          {tab === 'memories' && <MemoriesTab snapshot={snapshot} query={query} domain={domain} setQuery={setQuery} setDomain={setDomain} act={act} />}
          {tab === 'queue' && <QueueTab snapshot={snapshot} act={act} />}
          {tab === 'profile' && <ProfileTab snapshot={snapshot} />}
          {tab === 'export' && <ExportTab snapshot={snapshot} act={act} result={exportResult} setResult={setExportResult} />}
        </>}
    </section>}
    <button type="button" aria-label="Memory Vault" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: 8, padding: wide ? '0 8px' : 0, border: 0, borderRadius: 10, background: open ? 'color-mix(in srgb, #6d5dfc 14%, transparent)' : 'transparent', color: 'inherit', cursor: 'pointer', font: '13px var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)' }}>
      <span style={{ color: '#6d5dfc', fontSize: 18 }}>◈</span>
      {wide && <><span style={{ flex: 1, textAlign: 'left' }}>Memory Vault</span><span style={{ opacity: 0.55 }}>{total}</span></>}
    </button>
  </div>
}

function MemoriesTab(props: {
  snapshot: VaultSnapshot
  query: string
  domain: string
  setQuery: (value: string) => void
  setDomain: (value: string) => void
  act: (action: Record<string, unknown>) => Promise<void>
}) {
  const { snapshot, query, domain, setQuery, setDomain, act } = props
  const memories = snapshot.memories
  return <>
    <section style={{ ...card, padding: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记忆…" style={{ flex: 1, minWidth: 160, padding: '6px 10px', borderRadius: 8, border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent', color: 'inherit' }} />
      <select value={domain} onChange={event => setDomain(event.target.value)} style={{ ...button }}>
        <option value="">全部领域</option>
        {snapshot.config.domains.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <small style={{ opacity: 0.6 }}>
        {Object.entries(snapshot.stats.byDomain).map(([key, value]) => `${key} ${value}`).join(' · ') || '还没有记忆'}
      </small>
    </section>
    <section style={{ ...card, padding: 10, marginTop: 8, display: 'grid', gap: 6 }}>
      {memories.map(memory => <MemoryRow key={memory.id} memory={memory} onForget={id => { void act({ action: 'forget-memory', memoryId: id }) }} />)}
      {memories.length === 0 && <div style={{ padding: 18, textAlign: 'center', opacity: 0.62 }}>还没有匹配的记忆。对 AI 说「记一下：…」即可沉淀。</div>}
    </section>
  </>
}

function QueueTab(props: { snapshot: VaultSnapshot; act: (action: Record<string, unknown>) => Promise<void> }) {
  const { snapshot, act } = props
  if (snapshot.suggestions.length === 0) {
    return <section style={{ ...card, padding: 24, marginTop: 8, textAlign: 'center', opacity: 0.62 }}>
      确认队列为空。开启 autoExtract 后，AI 从对话提炼的候选记忆会出现在这里——批准才入库。
    </section>
  }
  return <section style={{ ...card, padding: 10, marginTop: 8, display: 'grid', gap: 6 }}>
    {snapshot.suggestions.map(item => <article key={item.id} style={{ padding: 10, borderRadius: 8, background: 'color-mix(in srgb, currentColor 6%, transparent)' }}>
      <div style={{ overflowWrap: 'anywhere' }}>{item.content}</div>
      <small style={{ display: 'block', opacity: 0.55, marginTop: 4 }}>
        {item.kind} · {item.domain} · confidence {item.confidence.toFixed(2)}{item.reason === undefined ? '' : ` · ${item.reason}`}{item.sourceTurn === undefined ? '' : ` · 第 ${item.sourceTurn} 轮`}
      </small>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={{ ...button, background: 'color-mix(in srgb, #0f9d8a 16%, transparent)', borderColor: '#0f9d8a' }} onClick={() => { void act({ action: 'resolve-suggestion', suggestionId: item.id, decision: 'approve' }) }}>批准</button>
        <button type="button" style={button} onClick={() => { void act({ action: 'resolve-suggestion', suggestionId: item.id, decision: 'reject' }) }}>拒绝</button>
      </div>
    </article>)}
  </section>
}

function ProfileTab(props: { snapshot: VaultSnapshot }) {
  const { profile, stats } = props.snapshot
  const list = (title: string, rows: ProfileEntryRow[]) => <details style={{ ...card, padding: 10, marginTop: 8 }}>
    <summary style={{ cursor: 'pointer' }}><strong>{title}</strong><small style={{ opacity: 0.55 }}> · {rows.length} 条</small></summary>
    <div style={{ display: 'grid', gap: 6, paddingTop: 8 }}>
      {rows.map(row => <article key={row.id} style={{ padding: 8, borderRadius: 8, background: 'color-mix(in srgb, currentColor 6%, transparent)' }}>
        <div style={{ overflowWrap: 'anywhere' }}>{row.content}</div>
        <small style={{ opacity: 0.55 }}>{row.domain}{row.stepCount > 0 ? ` · ${row.stepCount} 步` : ''} · 更新于 {new Date(row.updatedAt).toLocaleDateString()}</small>
      </article>)}
      {rows.length === 0 && <div style={{ opacity: 0.55 }}>暂无</div>}
    </div>
  </details>
  return <>
    <section style={{ ...card, padding: 12, marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
      <div><strong style={{ fontSize: 22 }}>{stats.active}</strong><div style={{ opacity: 0.6 }}>活跃记忆</div></div>
      {Object.entries(profile.overview.byDomain).map(([key, value]) => <div key={key}><strong style={{ fontSize: 22 }}>{value}</strong><div style={{ opacity: 0.6 }}>{key}</div></div>)}
    </section>
    {list('偏好 Preferences', profile.preferences)}
    {list('SOP 流程', profile.sops)}
    {list('经验教训 Lessons', profile.lessons)}
    {list('关键决策 Decisions', profile.decisions)}
    {list('约束 Constraints', profile.constraints)}
    <small style={{ display: 'block', padding: '6px 4px', opacity: 0.55 }}>对 AI 说「分析我的画像」或调用 mvault_profile 可生成叙述性画像报告。</small>
  </>
}

function ExportTab(props: {
  snapshot: VaultSnapshot
  act: (action: Record<string, unknown>, onDone?: () => void) => Promise<void>
  result: string
  setResult: (value: string) => void
}) {
  const { act, result, setResult } = props
  return <section style={{ ...card, padding: 12, marginTop: 8 }}>
    <p style={{ opacity: 0.75, marginTop: 0 }}>把所有活跃记忆导出为人可读的 Markdown（USER.md / MEMORY.md / projects/ / daily/ / domains/），可直接用编辑器查看或 git 版本化。</p>
    <button type="button" style={button} onClick={() => {
      void act({ action: 'export-markdown' }, () => setResult('导出完成'))
    }}>导出 Markdown</button>
    {result !== '' && <div role="status" style={{ marginTop: 8, color: '#0f9d8a' }}>{result}（目录：$DSH_HOME/dsh-memory-vault-export）</div>}
  </section>
}

/** Client runtime dependencies. */
export const inject = ['slots']

/** Register the sidebar Memory Vault entry. */
export async function apply(ctx: Context): Promise<void> {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'mvault', order: 85, label: 'Memory Vault',
  }, MemoryVaultPanel))
}
