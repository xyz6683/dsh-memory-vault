/**
 * dsh-memory-vault — SQLite storage layer.
 *
 * Local-first durable memory store: layered tracks (user / global / project /
 * project-log / daily-log), domain tags, SOP steps, confirmation-gated
 * suggestions, a light knowledge graph, hybrid ranking recall, Markdown
 * export, and JSONL backup. Schema migrations run inside one transaction at
 * startup; an application id refuses databases that belong to other apps.
 *
 * Zero runtime dependencies (node:sqlite, node:fs, node:crypto only).
 * Design borrows the proven external-content FTS5 (trigram) + trigger wiring
 * from dsh-memory-graph (MIT), extended with tracks / domains / steps.
 *
 * @module dsh-memory-vault/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type {
  EntityInput, ExtractionCommitInput, GraphEdge, GraphMemory, GraphNode, GraphResult,
  MemoryKind, MemoryStatus, MemoryTrack, ProfileEntry, RecallOptions, RecallResult,
  RelationInput, RememberInput, RememberResult, Suggestion,
} from './types.ts'

const APPLICATION_ID = 0x4d564c54 // 'MVLT'
const SCHEMA_VERSION = 2

const MEMORY_KINDS = new Set<MemoryKind>([
  'preference', 'fact', 'decision', 'constraint', 'lesson', 'sop', 'event', 'summary',
])
const MEMORY_TRACKS = new Set<MemoryTrack>(['user', 'global', 'project', 'project-log', 'daily-log'])
const MEMORY_STATUSES = new Set<MemoryStatus>(['active', 'pending', 'archived', 'superseded'])

/** Normalize an entity identity while preserving its display spelling separately. */
export function normalizeEntity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function compactEntityIdentity(value: string): string {
  return normalizeEntity(value).replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Normalize graph predicates to lowercase snake_case. */
export function normalizePredicate(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '')
}

function normalizeStableKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '-').toLocaleLowerCase('en-US')
}

function normalizeDomain(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '-').toLocaleLowerCase('en-US')
}

/** Safe filesystem component derived from a project key (no dots, no traversal). */
export function slugify(value: string): string {
  const slug = value.normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/\./g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug === '' ? 'project' : slug
}

/** Trigrams of every letter/number term (works for CJK: each 3-char window). */
function trigrams(value: string): Set<string> {
  const result = new Set<string>()
  const terms = value.normalize('NFKC').trim().toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []
  for (const term of terms) {
    const characters = [...term]
    for (let index = 0; index <= characters.length - 3; index++) {
      result.add(characters.slice(index, index + 3).join(''))
    }
  }
  return result
}

/** Build a safe FTS5 MATCH query from raw text (OR of quoted trigrams). */
function ftsQuery(value: string): string | undefined {
  const values = [...trigrams(value)]
  if (values.length === 0) return undefined
  return values.slice(0, 48).map(item => `"${item.replaceAll('"', '""')}"`).join(' OR ')
}

/** Individual letter/number terms of a query. */
function searchTerms(value: string): string[] {
  return [...new Set(value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])]
}

function parseStringArray(value: string | null): string[] {
  if (value === null) return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function parseNumberArray(value: string): number[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is number => Number.isSafeInteger(item) && item >= 0)
    : []
}

function parseJson(value: string | null): unknown {
  if (value === null || value === '') return undefined
  return JSON.parse(value)
}

/** Short stable project key derived from a session working directory. */
export function projectKeyForCwd(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

interface MemoryRow {
  id: string
  content: string
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  project: string | null
  importance: number
  confidence: number
  stable_key: string | null
  branches: string | null
  steps: string | null
  tags: string
  status: MemoryStatus
  supersedes_id: string | null
  source_session: string | null
  source_turn: number | null
  created_at: number
  updated_at: number
  accessed_at: number | null
  access_count: number
}

interface EntityRow {
  id: string
  normalized: string
  name: string
  kind: string
}

interface RelationRow {
  id: number
  source_id: string
  predicate: string
  target_id: string
  confidence: number
  source_memory_id: string | null
  source_name?: string
  target_name?: string
  mentions?: number
}

interface SuggestionRow {
  id: string
  content: string
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  project: string | null
  importance: number
  confidence: number
  stable_key: string | null
  branches: string | null
  steps: string | null
  tags: string
  entities_json: string
  relations_json: string
  reason: string | null
  source_session: string | null
  source_turn: number | null
  status: 'pending' | 'approved' | 'rejected'
  memory_id: string | null
  created_at: number
  resolved_at: number | null
}

/** Store-level options. */
export interface MemoryVaultStoreOptions {
  predicateAliases?: Readonly<Record<string, string>>
}

function boundedLevenshtein(left: string, right: string, maximum: number): number | undefined {
  const a = [...left]
  const b = [...right]
  if (Math.abs(a.length - b.length) > maximum) return undefined
  const unavailable = maximum + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index <= maximum ? index : unavailable)
  for (let row = 1; row <= a.length; row++) {
    const current = Array<number>(b.length + 1).fill(unavailable)
    if (row <= maximum) current[0] = row
    let minimum = unavailable
    const start = Math.max(1, row - maximum)
    const end = Math.min(b.length, row + maximum)
    for (let column = start; column <= end; column++) {
      const substitution = previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1)
      const value = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution)
      current[column] = value
      minimum = Math.min(minimum, value)
    }
    if (minimum > maximum) return undefined
    previous = current
  }
  const distance = previous[b.length]!
  return distance <= maximum ? distance : undefined
}

interface WalkResult {
  distances: Map<string, number>
  entities: Map<string, EntityRow>
  relations: RelationRow[]
}

/** Local-first SQLite memory vault. */
export class MemoryVaultStore {
  private readonly db: DatabaseSync
  private readonly predicateAliases: Readonly<Record<string, string>>
  private closed = false

  constructor(path: string, options: MemoryVaultStoreOptions = {}) {
    this.predicateAliases = options.predicateAliases ?? {}
    if (path !== ':memory:' && dirname(path) !== '') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      this.db = new DatabaseSync(path, { open: true, readOnly: false })
    } catch (error: unknown) {
      if (path === ':memory:') throw error
      throw new Error(`memory vault: cannot open database at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.migrate()
    } catch (error: unknown) {
      try {
        this.db.close()
      } catch {
        // The schema error remains the actionable failure.
      }
      throw error
    }
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory vault: store is closed')
  }

  private migrate(): void {
    const meta = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const version = meta.user_version
    let appId = 0
    try {
      const application = this.db.prepare('PRAGMA application_id').get() as { application_id: number }
      appId = application.application_id
    } catch {
      // Older SQLite builds may not expose application_id.
    }
    if (version !== 0 && appId !== 0 && appId !== APPLICATION_ID) {
      throw new Error(`memory vault: database has application id ${appId}, expected ${APPLICATION_ID}`)
    }
    if (version !== 0 && version > SCHEMA_VERSION) {
      throw new Error(`memory vault: database schema ${version} is newer than supported ${SCHEMA_VERSION}`)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.createSchema()
      if (version === 0) this.db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      if (version !== SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The schema error remains the actionable failure.
      }
      throw error
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id             TEXT PRIMARY KEY,
        content        TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'fact'
                       CHECK (kind IN ('preference','fact','decision','constraint','lesson','sop','event','summary')),
        track          TEXT NOT NULL DEFAULT 'global'
                       CHECK (track IN ('user','global','project','project-log','daily-log')),
        domain         TEXT NOT NULL DEFAULT 'general',
        project        TEXT,
        importance     REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
        confidence     REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
        stable_key     TEXT,
        branches       TEXT,
        steps          TEXT,
        tags           TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','pending','archived','superseded')),
        supersedes_id  TEXT REFERENCES memories(id) ON DELETE SET NULL,
        source_session TEXT,
        source_turn    INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        accessed_at    INTEGER,
        access_count   INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS memories_active_stable_key
        ON memories(stable_key) WHERE stable_key IS NOT NULL AND status = 'active';
      CREATE INDEX IF NOT EXISTS memories_created_at ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS memories_track_domain ON memories(track, domain);
      CREATE INDEX IF NOT EXISTS memories_project ON memories(project) WHERE project IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content, tags, domain, content='memories', content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, content, tags, domain) VALUES (new.rowid, new.content, new.tags, new.domain);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, tags, domain)
        VALUES ('delete', old.rowid, old.content, old.tags, old.domain);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags, domain ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, tags, domain)
        VALUES ('delete', old.rowid, old.content, old.tags, old.domain);
        INSERT INTO memory_fts(rowid, content, tags, domain) VALUES (new.rowid, new.content, new.tags, new.domain);
      END;

      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        normalized TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY (memory_id, entity_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_entities_entity ON memory_entities(entity_id);

      CREATE TABLE IF NOT EXISTS relations (
        id               INTEGER PRIMARY KEY,
        source_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        predicate        TEXT NOT NULL,
        target_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        UNIQUE (source_id, predicate, target_id, source_memory_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relations_source ON relations(source_id);
      CREATE INDEX IF NOT EXISTS relations_target ON relations(target_id);

      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias_normalized TEXT PRIMARY KEY,
        entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        display_name     TEXT NOT NULL,
        mentions         INTEGER NOT NULL DEFAULT 1 CHECK (mentions >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entity_aliases_entity ON entity_aliases(entity_id);

      CREATE TABLE IF NOT EXISTS turn_archives (
        id                      TEXT PRIMARY KEY,
        session_id              TEXT NOT NULL,
        turn                    INTEGER NOT NULL,
        source_event_seqs       TEXT NOT NULL,
        messages                TEXT NOT NULL,
        truncated               INTEGER NOT NULL DEFAULT 0,
        original_message_count  INTEGER NOT NULL,
        provider                TEXT NOT NULL,
        model                   TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','archived','summarized','failed')),
        error                   TEXT,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        UNIQUE (session_id, turn)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS suggestions (
        id             TEXT PRIMARY KEY,
        content        TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'fact',
        track          TEXT NOT NULL DEFAULT 'global',
        domain         TEXT NOT NULL DEFAULT 'general',
        project        TEXT,
        importance     REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
        confidence     REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
        stable_key     TEXT,
        branches       TEXT,
        steps          TEXT,
        tags           TEXT NOT NULL DEFAULT '[]',
        entities_json  TEXT NOT NULL DEFAULT '[]',
        relations_json TEXT NOT NULL DEFAULT '[]',
        reason         TEXT,
        source_session TEXT,
        source_turn    INTEGER,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        memory_id      TEXT REFERENCES memories(id) ON DELETE SET NULL,
        created_at     INTEGER NOT NULL,
        resolved_at    INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status, created_at DESC);

      -- Audit trail for automatic turn extraction (M2): request/response kept
      -- verbatim so every suggestion can be traced back to its source turn.
      CREATE TABLE IF NOT EXISTS extractions (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        turn           INTEGER NOT NULL,
        summary        TEXT NOT NULL,
        source_event_seqs TEXT NOT NULL,
        provider       TEXT NOT NULL,
        model          TEXT NOT NULL,
        request_json   TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        UNIQUE (session_id, turn)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS extractions_created_at ON extractions(created_at DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
  }

  /** Validate a raw remember input, throwing a descriptive error. */
  static validate(input: RememberInput): void {
    const content = input.content.trim()
    if (content.length === 0) throw new Error('memory vault: content must not be empty')
    if (content.length > 12_000) throw new Error('memory vault: content exceeds 12000 characters')
    if (!MEMORY_KINDS.has(input.kind)) throw new Error(`memory vault: unsupported kind "${input.kind}"`)
    if (!MEMORY_TRACKS.has(input.track)) throw new Error(`memory vault: unsupported track "${input.track}"`)
    if (!MEMORY_STATUSES.has(input.status)) throw new Error(`memory vault: unsupported status "${input.status}"`)
    if (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1) {
      throw new Error('memory vault: importance must be between 0 and 1')
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error('memory vault: confidence must be between 0 and 1')
    }
    if (input.entities.length > 32) throw new Error('memory vault: at most 32 entities per memory')
    if (input.relations.length > 64) throw new Error('memory vault: at most 64 relations per memory')
    if (input.tags.length > 16) throw new Error('memory vault: at most 16 tags per memory')
    if (input.steps !== undefined && input.steps.length > 32) throw new Error('memory vault: at most 32 SOP steps')
    if (input.steps !== undefined && input.steps.some(step => step.trim().length === 0 || step.length > 2_000)) {
      throw new Error('memory vault: each SOP step must be non-empty and at most 2000 characters')
    }
    if (input.branches !== undefined && input.branches.some(branch => !/^[\w./-]{1,120}$/u.test(branch))) {
      throw new Error('memory vault: branch names must match [\\w./-]{1,120}')
    }
  }

  /** Atomically write one memory with its entities and relations. */
  remember(input: RememberInput): RememberResult {
    this.assertOpen()
    MemoryVaultStore.validate(input)
    const content = input.content.trim()
    const domain = normalizeDomain(input.domain) || 'general'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(
        'SELECT id FROM memories WHERE status = ? AND lower(content) = ? LIMIT 1',
      ).get('active', content.toLocaleLowerCase('en-US')) as { id: string } | undefined
      if (existing !== undefined) {
        this.db.exec('ROLLBACK')
        return { memoryId: existing.id, entityCount: 0, relationCount: 0, deduplicated: true, entityConflicts: [] }
      }
      let supersededMemoryId: string | undefined
      if (input.stableKey !== undefined && input.stableKey.trim() !== '' && input.status === 'active') {
        const stableKey = normalizeStableKey(input.stableKey)
        const previous = this.db.prepare(
          "SELECT id FROM memories WHERE status = 'active' AND stable_key = ? LIMIT 1",
        ).get(stableKey) as { id: string } | undefined
        if (previous !== undefined) {
          this.db.prepare(
            "UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?",
          ).run(input.now, previous.id)
          supersededMemoryId = previous.id
        }
      }
      const id = randomUUID()
      this.db.prepare(`
        INSERT INTO memories (
          id, content, kind, track, domain, project, importance, confidence,
          stable_key, branches, steps, tags, status, supersedes_id,
          source_session, source_turn, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, content, input.kind, input.track, domain, input.project ?? null,
        input.importance, input.confidence,
        input.stableKey === undefined || input.stableKey.trim() === '' ? null : normalizeStableKey(input.stableKey),
        input.branches === undefined || input.branches.length === 0 ? null : JSON.stringify(input.branches),
        input.steps === undefined || input.steps.length === 0 ? null : JSON.stringify(input.steps),
        JSON.stringify(input.tags), input.status, supersededMemoryId ?? null,
        input.sourceSession ?? null, input.sourceTurn ?? null, input.now, input.now,
      )
      const { entityCount, relationCount, entityConflicts } = this.linkGraph(id, input.entities, input.relations)
      this.db.exec('COMMIT')
      return { memoryId: id, entityCount, relationCount, deduplicated: false, entityConflicts, ...(supersededMemoryId === undefined ? {} : { supersededMemoryId }) }
    } catch (error: unknown) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original error remains the actionable failure.
      }
      throw error
    }
  }

  /** Upsert entities / aliases / relations for one memory; report identity conflicts. */
  private linkGraph(
    memoryId: string, rawEntities: EntityInput[], rawRelations: RelationInput[],
  ): { entityCount: number; relationCount: number; entityConflicts: Array<{ entityId: string; field: string; kept: string; incoming: string }> } {
    const conflicts: Array<{ entityId: string; field: string; kept: string; incoming: string }> = []
    const upsertEntity = this.db.prepare(`
      INSERT INTO entities (id, normalized, name, kind) VALUES (?, ?, ?, ?)
      ON CONFLICT(normalized) DO NOTHING
    `)
    const resolveEntity = this.db.prepare('SELECT * FROM entities WHERE normalized = ?')
    const upsertAlias = this.db.prepare(`
      INSERT INTO entity_aliases (alias_normalized, entity_id, display_name) VALUES (?, ?, ?)
      ON CONFLICT(alias_normalized) DO UPDATE SET mentions = mentions + 1
    `)
    const linkMemory = this.db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)')
    const upsertRelation = this.db.prepare(`
      INSERT OR IGNORE INTO relations (source_id, predicate, target_id, confidence, source_memory_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    let entityCount = 0
    let relationCount = 0
    const ensureCache = new Map<string, string>()
    const ensure = (name: string, kind?: string, aliases?: string[], canonical?: string): string | undefined => {
      const key = normalizeEntity(name)
      const cached = ensureCache.get(key)
      if (cached !== undefined) return cached
      const id = randomUUID()
      const canonicalNormalized = canonical === undefined || canonical.trim() === '' ? undefined : normalizeEntity(canonical)
      upsertEntity.run(id, canonicalNormalized ?? key, canonicalNormalized !== undefined ? canonical! : name, kind ?? 'entity')
      const resolved = resolveEntity.get(canonicalNormalized ?? key) as EntityRow | undefined
      if (resolved === undefined) return undefined
      ensureCache.set(key, resolved.id)
      if (resolved.name !== name && canonicalNormalized === undefined) {
        conflicts.push({ entityId: resolved.id, field: 'name', kept: resolved.name, incoming: name })
      }
      for (const alias of new Set([...(aliases ?? []), ...(canonicalNormalized === undefined ? [] : [name])])) {
        const trimmed = alias.trim()
        if (trimmed === '') continue
        const aliasNormalized = normalizeEntity(trimmed)
        const owner = this.db.prepare('SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?').get(aliasNormalized) as { entity_id: string } | undefined
        if (owner !== undefined && owner.entity_id !== resolved.id) {
          conflicts.push({ entityId: resolved.id, field: 'alias', kept: owner.entity_id, incoming: trimmed })
          continue
        }
        upsertAlias.run(aliasNormalized, resolved.id, trimmed)
      }
      return resolved.id
    }
    for (const raw of rawEntities) {
      const name = raw.name.trim()
      if (name === '') continue
      const id = ensure(name, raw.kind, raw.aliases, raw.canonical)
      if (id === undefined) continue
      const inserted = linkMemory.run(memoryId, id)
      if (inserted.changes > 0) entityCount++
    }
    for (const raw of rawRelations) {
      const source = normalizeEntity(raw.source)
      const target = normalizeEntity(raw.target)
      if (source === '' || target === '') continue
      // Relation endpoints become entities too (and link to this memory),
      // so a graph edge between only-mentioned concepts stays queryable.
      const sourceId = ensure(raw.source)
      const targetId = ensure(raw.target)
      if (sourceId === undefined || targetId === undefined) continue
      linkMemory.run(memoryId, sourceId)
      linkMemory.run(memoryId, targetId)
      const predicate = this.resolvePredicate(raw.predicate)
      if (predicate === '') continue
      const confidence = raw.confidence === undefined ? 1 : Math.min(1, Math.max(0, raw.confidence))
      const inserted = upsertRelation.run(sourceId, predicate, targetId, confidence, memoryId)
      if (inserted.changes > 0) relationCount++
    }
    return { entityCount, relationCount, entityConflicts: conflicts }
  }

  private resolvePredicate(raw: string): string {
    const normalized = normalizePredicate(raw)
    return this.predicateAliases[normalized] ?? normalized
  }

  /** Fetch one memory row by id. */
  memory(memoryId: string): MemoryRow | undefined {
    this.assertOpen()
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as MemoryRow | undefined
  }

  /** Bounded entity neighbourhood / global overview. */
  graph(entity: string, hops: number, limit: number): GraphResult {
    this.assertOpen()
    const normalized = normalizeEntity(entity)
    const seeds = normalized.length === 0 ? this.globalSeeds(limit) : this.searchEntityIds(normalized, 8)
    if (seeds.length === 0) return { nodes: [], edges: [], memories: [] }
    const walk = this.walk(seeds.map(seed => seed.id), hops, limit)
    const entityIds = [...walk.distances.keys()]
    const placeholders = entityIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT m.* FROM memory_entities me JOIN memories m ON m.id = me.memory_id
      WHERE me.entity_id IN (${placeholders}) AND m.status = 'active'
      ORDER BY m.importance DESC, m.created_at DESC
    `).all(...entityIds) as unknown as MemoryRow[]
    const memoryRows = new Map<string, MemoryRow>()
    rows.forEach(row => memoryRows.set(row.id, row))
    const selectedRows = [...memoryRows.values()].slice(0, limit)
    const entitiesByMemory = this.entitiesForMemories(selectedRows.map(row => row.id))
    return {
      nodes: [...walk.entities.values()].map(row => ({
        id: row.id, name: row.name, kind: row.kind, distance: walk.distances.get(row.id) ?? 0,
      })).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name)),
      edges: walk.relations.map(row => ({
        source: row.source_name ?? '',
        predicate: row.predicate,
        target: row.target_name ?? '',
        confidence: row.confidence,
        ...(row.mentions === undefined ? {} : { mentions: row.mentions }),
      })),
      memories: selectedRows.map(row => this.graphMemory(row, entitiesByMemory.get(row.id) ?? [])),
    }
  }

  private graphMemory(row: MemoryRow, entities: EntityRow[]): GraphMemory {
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      track: row.track,
      domain: row.domain,
      importance: row.importance,
      confidence: row.confidence,
      entities: entities.map(entity => entity.name),
      ...(row.source_session === null ? {} : { sourceSession: row.source_session }),
      ...(row.source_turn === null ? {} : { sourceTurn: row.source_turn }),
    }
  }

  private globalSeeds(limit: number): Array<{ id: string }> {
    return this.db.prepare(`
      SELECT e.id, COUNT(DISTINCT m.id) AS memory_count
      FROM entities e
      JOIN memory_entities me ON me.entity_id = e.id
      JOIN memories m ON m.id = me.memory_id AND m.status = 'active'
      GROUP BY e.id
      ORDER BY memory_count DESC, e.name
      LIMIT ?
    `).all(Math.min(limit, 24)) as Array<{ id: string }>
  }

  private searchEntityIds(normalized: string, limit: number): Array<{ id: string }> {
    const exact = this.db.prepare(`
      SELECT entity_id AS id FROM entity_aliases WHERE alias_normalized = ? LIMIT ?
    `).all(normalized, limit) as Array<{ id: string }>
    if (exact.length > 0) return exact
    return this.db.prepare(`
      SELECT DISTINCT entity_id AS id FROM entity_aliases
      WHERE instr(alias_normalized, ?) > 0 OR instr(?, alias_normalized) > 0
      ORDER BY length(alias_normalized) DESC, alias_normalized LIMIT ?
    `).all(normalized, normalized, limit) as Array<{ id: string }>
  }

  /** Bounded BFS over the entity graph. */
  private walk(seedIds: string[], hops: number, limit: number): WalkResult {
    const distances = new Map<string, number>()
    const entities = new Map<string, EntityRow>()
    const relations: RelationRow[] = []
    seedIds.forEach(id => distances.set(id, 0))
    const frontier = [...seedIds]
    const seen = new Set<string>(seedIds)
    for (let hop = 0; hop <= hops && frontier.length > 0; hop++) {
      const next: string[] = []
      for (const entityId of frontier) {
        if (entities.size >= limit) break
        const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as EntityRow | undefined
        if (row === undefined) continue
        entities.set(row.id, row)
        const edgeRows = this.db.prepare(`
          SELECT r.id, r.source_id, r.predicate, r.target_id, r.confidence, r.source_memory_id,
                 s.name AS source_name, t.name AS target_name,
                 (SELECT COUNT(*) FROM relations r2 WHERE r2.source_id = r.source_id AND r2.predicate = r.predicate AND r2.target_id = r.target_id) AS mentions
          FROM relations r
          JOIN entities s ON s.id = r.source_id
          JOIN entities t ON t.id = r.target_id
          WHERE r.source_id = ? OR r.target_id = ?
          ORDER BY r.id LIMIT 400
        `).all(entityId, entityId) as unknown as RelationRow[]
        for (const edge of edgeRows) {
          if (!relations.some(existing => existing.source_id === edge.source_id && existing.predicate === edge.predicate && existing.target_id === edge.target_id)) {
            relations.push(edge)
          }
          const neighbor = edge.source_id === entityId ? edge.target_id : edge.source_id
          if (!seen.has(neighbor)) {
            seen.add(neighbor)
            distances.set(neighbor, hop + 1)
            next.push(neighbor)
          }
        }
      }
      frontier.length = 0
      frontier.push(...next)
    }
    return { distances, entities, relations }
  }

  /** Hybrid ranking search over active memories. */
  /** True when a memory row is visible under the given git-branch context. */
  private branchAllowed(row: MemoryRow, branch: string | undefined): boolean {
    if (branch === undefined) return true
    // Only project-track memories carry branch scopes; a NULL scope means
    // "all branches". Other tracks are always visible.
    if (row.track !== 'project' || row.branches === null) return true
    return parseStringArray(row.branches).includes(branch)
  }

  recall(query: string, options: RecallOptions): RecallResult[] {
    this.assertOpen()
    const now = options.now ?? Date.now()
    const branch = options.branch
    const candidates = new Map<string, {
      row: MemoryRow
      lexical: number
      graph: number
      reasons: Set<string>
    }>()
    const match = ftsQuery(query)
    const rawFtsRows = match === undefined ? [] : this.db.prepare(`
      SELECT m.*, bm25(memory_fts, 1.0, 0.2) AS rank
      FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.status = 'active'
        AND (? IS NULL OR m.domain = ?)
        AND (? IS NULL OR m.track = ?)
        AND (? IS NULL OR m.kind = ?)
      ORDER BY rank LIMIT ?
    `).all(
      match,
      options.domain ?? null, options.domain ?? null,
      options.track ?? null, options.track ?? null,
      options.kind ?? null, options.kind ?? null,
      Math.max(options.limit * 4, 20),
    ) as unknown as Array<MemoryRow & { rank: number }>
    const queryTrigrams = trigrams(query)
    const ftsRows = rawFtsRows.filter(row => this.branchAllowed(row, branch)).map(row => {
      const text = `${row.content} ${parseStringArray(row.tags).join(' ')}`.normalize('NFKC').toLocaleLowerCase('en-US')
      const searchable = trigrams(text)
      const overlap = [...queryTrigrams].filter(value => searchable.has(value)).length
      const trigramCoverage = queryTrigrams.size === 0 ? 0 : overlap / queryTrigrams.size
      const terms = searchTerms(query)
      const termCoverage = terms.length === 0 ? 0 : terms.filter(term => text.includes(term)).length / terms.length
      return { row, coverage: termCoverage * 0.7 + trigramCoverage * 0.3, trigramCoverage }
    }).filter(value => value.trigramCoverage >= 0.34)
      .sort((a, b) => b.coverage - a.coverage || a.row.rank - b.row.rank)
    const normalizedQuery = normalizeEntity(query)
    // Substring fallback: trigram FTS cannot match terms shorter than 3
    // characters (common in Chinese: 发版, 部署, 偏好…). Match the query's
    // short terms with instr so two-character Chinese queries still recall;
    // for a fully tiny query the whole string becomes the needle.
    const queryTerms = searchTerms(query)
    const shortTerms = queryTerms.filter(term => [...term].length < 3)
    const compactQuery = normalizedQuery.replace(/\s+/g, '')
    const needles = shortTerms.length > 0 ? shortTerms.slice(0, 4) : (compactQuery.length > 0 && compactQuery.length < 3 ? [compactQuery] : [])
    const substringRows = needles.length > 0
      ? this.db.prepare(`
          SELECT * FROM memories
          WHERE status = 'active'
            AND ${needles.map(() => 'instr(lower(content), ?) > 0').join(' AND ')}
            AND (? IS NULL OR domain = ?)
            AND (? IS NULL OR track = ?)
            AND (? IS NULL OR kind = ?)
          ORDER BY created_at DESC LIMIT ?
        `).all(
          ...needles.map(needle => needle.toLocaleLowerCase('en-US')),
          options.domain ?? null, options.domain ?? null,
          options.track ?? null, options.track ?? null,
          options.kind ?? null, options.kind ?? null,
          Math.max(options.limit * 4, 20),
        ) as unknown as MemoryRow[]
      : []
    const branchScopedSubstringRows = substringRows.filter(row => this.branchAllowed(row, branch))
    const lexicalRows = [
      ...ftsRows.map(value => ({ row: value.row, score: value.coverage })),
      ...branchScopedSubstringRows.filter(row => !ftsRows.some(value => value.row.id === row.id)).map(row => ({ row, score: 1 })),
    ]
    lexicalRows.forEach(({ row, score }) => {
      candidates.set(row.id, {
        row, lexical: Math.min(1, score), graph: 0, reasons: new Set(['lexical']),
      })
    })

    // Graph expansion from query entities and lexical hits' entities.
    const seeds = new Set<string>()
    if (normalizedQuery.length > 0) {
      this.searchEntityIds(normalizedQuery, 12).forEach(row => seeds.add(row.id))
    }
    const lexicalMemoryIds = lexicalRows.slice(0, options.limit * 2).map(value => value.row.id)
    if (lexicalMemoryIds.length > 0) {
      const placeholders = lexicalMemoryIds.map(() => '?').join(', ')
      const entityRows = this.db.prepare(`
        SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id IN (${placeholders})
      `).all(...lexicalMemoryIds) as Array<{ entity_id: string }>
      entityRows.forEach(entity => seeds.add(entity.entity_id))
    }
    if (seeds.size > 0) {
      const walk = this.walk([...seeds], options.hops, 160)
      const entityIds = [...walk.distances.keys()]
      const placeholders = entityIds.map(() => '?').join(', ')
      const linkedRows = this.db.prepare(`
        SELECT me.entity_id, m.* FROM memory_entities me JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id IN (${placeholders}) AND m.status = 'active'
          AND (? IS NULL OR m.domain = ?)
          AND (? IS NULL OR m.track = ?)
          AND (? IS NULL OR m.kind = ?)
      `).all(
        options.domain ?? null, options.domain ?? null,
        options.track ?? null, options.track ?? null,
        options.kind ?? null, options.kind ?? null,
      ) as unknown as Array<MemoryRow & { entity_id: string }>
      for (const row of linkedRows) {
        if (!this.branchAllowed(row, branch)) continue
        const distance = walk.distances.get(row.entity_id) ?? options.hops
        const current = candidates.get(row.id) ?? { row, lexical: 0, graph: 0, reasons: new Set<string>() }
        current.graph = Math.max(current.graph, 1 / (distance + 1))
        current.reasons.add(distance === 0 ? 'entity' : `graph:${distance}`)
        candidates.set(row.id, current)
      }
    }

    const totalWeight = Object.values(options.weights).reduce((sum, value) => sum + value, 0)
    const ranked = [...candidates.values()].map((candidate) => {
      const ageDays = Math.max(0, now - candidate.row.created_at) / 86_400_000
      const recency = Math.pow(0.5, ageDays / options.halfLifeDays)
      const access = Math.min(1, Math.log1p(candidate.row.access_count) / Math.log(11))
      const domainScore = Math.min(1, (options.domainScores.get(candidate.row.domain) ?? 0) * (1 + options.domainBoost))
      const baseScore = totalWeight <= 0 ? 0 : (
        candidate.lexical * options.weights.lexical
        + candidate.graph * options.weights.graph
        + candidate.row.importance * options.weights.importance
        + recency * options.weights.recency
        + access * options.weights.access
        + domainScore * options.weights.domain
      ) / totalWeight
      if (domainScore > 0) candidate.reasons.add(`domain:${candidate.row.domain}`)
      return { candidate, score: baseScore }
    }).sort((a, b) => b.score - a.score || b.candidate.row.created_at - a.candidate.row.created_at)
    const seenContent = new Set<string>()
    const deduplicated = ranked.filter(({ candidate }) => {
      const key = compactEntityIdentity(candidate.row.content)
      if (seenContent.has(key)) return false
      seenContent.add(key)
      return true
    }).slice(0, options.limit)

    if (options.reinforce !== false && deduplicated.length > 0) {
      const touch = this.db.prepare('UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        deduplicated.forEach(item => touch.run(now, item.candidate.row.id))
        this.db.exec('COMMIT')
      } catch (error: unknown) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const entitiesByMemory = this.entitiesForMemories(deduplicated.map(item => item.candidate.row.id))
    return deduplicated.map(({ candidate, score }) => ({
      id: candidate.row.id,
      content: candidate.row.content,
      score: Number(Math.min(1, score).toFixed(6)),
      importance: candidate.row.importance,
      confidence: candidate.row.confidence,
      kind: candidate.row.kind,
      track: candidate.row.track,
      domain: candidate.row.domain,
      ...(candidate.row.stable_key === null ? {} : { stableKey: candidate.row.stable_key }),
      hasSteps: candidate.row.steps !== null,
      createdAt: candidate.row.created_at,
      tags: parseStringArray(candidate.row.tags),
      entities: (entitiesByMemory.get(candidate.row.id) ?? []).map(entity => ({ name: entity.name, kind: entity.kind })),
      reasons: [...candidate.reasons].sort(),
    }))
  }

  /** Entity display names attached to one memory. */
  entitiesForMemory(memoryId: string): string[] {
    this.assertOpen()
    const rows = this.db.prepare(`
      SELECT e.name FROM memory_entities me JOIN entities e ON e.id = me.entity_id
      WHERE me.memory_id = ? ORDER BY e.name
    `).all(memoryId) as Array<{ name: string }>
    return rows.map(row => row.name)
  }

  private entitiesForMemories(memoryIds: readonly string[]): Map<string, EntityRow[]> {    const result = new Map<string, EntityRow[]>()
    if (memoryIds.length === 0) return result
    const placeholders = memoryIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT me.memory_id, e.* FROM memory_entities me JOIN entities e ON e.id = me.entity_id
      WHERE me.memory_id IN (${placeholders}) ORDER BY e.name
    `).all(...memoryIds) as unknown as Array<EntityRow & { memory_id: string }>
    rows.forEach(row => {
      const list = result.get(row.memory_id) ?? []
      list.push({ id: row.id, normalized: row.normalized, name: row.name, kind: row.kind })
      result.set(row.memory_id, list)
    })
    return result
  }

  /** Delete one memory and graph facts whose provenance is that memory. */
  forget(memoryId: string): boolean {
    this.assertOpen()
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
    if (result.changes === 0) return false
    this.collectOrphanEntities()
    return true
  }

  private collectOrphanEntities(): number {
    return Number(this.db.prepare(`
      DELETE FROM entities
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_entities me JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id = entities.id AND m.status = 'active'
      ) AND NOT EXISTS (
        SELECT 1 FROM relations r LEFT JOIN memories m ON m.id = r.source_memory_id
        WHERE (r.source_id = entities.id OR r.target_id = entities.id)
          AND (r.source_memory_id IS NULL OR m.status = 'active')
      )
    `).run().changes)
  }

  /** Restore the directly previous version of an active stable memory. */
  revert(memoryId: string): { restoredMemoryId: string; supersededMemoryId: string } {
    this.assertOpen()
    const current = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(memoryId) as MemoryRow | undefined
    if (current === undefined || current.supersedes_id === null) {
      throw new Error('memory vault: memory is not an active stable fact with a previous version')
    }
    const previous = this.db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'superseded'").get(current.supersedes_id) as MemoryRow | undefined
    if (previous === undefined) throw new Error('memory vault: previous version not found')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(Date.now(), current.id)
      this.db.prepare("UPDATE memories SET status = 'active', supersedes_id = NULL, updated_at = ? WHERE id = ?").run(Date.now(), previous.id)
      this.db.exec('COMMIT')
      return { restoredMemoryId: previous.id, supersededMemoryId: current.id }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Mark one memory as archived (out of recall, reversible). */
  archive(memoryId: string): boolean {
    this.assertOpen()
    const result = this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'").run(Date.now(), memoryId)
    return result.changes > 0
  }

  /** Reactivate an archived memory. */
  unarchive(memoryId: string): boolean {
    this.assertOpen()
    const result = this.db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ? AND status = 'archived'").run(Date.now(), memoryId)
    return result.changes > 0
  }

  /** Bounded filtered listing for the Web UI and export. */
  list(options: {
    status?: MemoryStatus
    track?: MemoryTrack
    domain?: string
    kind?: MemoryKind
    query?: string
    limit: number
    offset?: number
  }): Array<{ id: string; content: string; kind: MemoryKind; track: MemoryTrack; domain: string; importance: number; confidence: number; tags: string[]; createdAt: number }> {
    this.assertOpen()
    const clauses: string[] = []
    const args: Array<string | number> = []
    if (options.status !== undefined) { clauses.push('status = ?'); args.push(options.status) }
    if (options.track !== undefined) { clauses.push('track = ?'); args.push(options.track) }
    if (options.domain !== undefined) { clauses.push('domain = ?'); args.push(options.domain) }
    if (options.kind !== undefined) { clauses.push('kind = ?'); args.push(options.kind) }
    if (options.query !== undefined && options.query.trim() !== '') { clauses.push('instr(lower(content), ?) > 0'); args.push(options.query.toLocaleLowerCase('en-US')) }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    args.push(options.limit, options.offset ?? 0)
    const rows = this.db.prepare(`
      SELECT id, content, kind, track, domain, importance, confidence, tags, created_at
      FROM memories ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...args) as unknown as Array<{ id: string; content: string; kind: MemoryKind; track: MemoryTrack; domain: string; importance: number; confidence: number; tags: string; created_at: number }>
    return rows.map(row => ({
      id: row.id, content: row.content, kind: row.kind, track: row.track, domain: row.domain,
      importance: row.importance, confidence: row.confidence, tags: parseStringArray(row.tags), createdAt: row.created_at,
    }))
  }

  /** Count of pending suggestions (Web UI badge). */
  pendingSuggestionCount(): number {
    this.assertOpen()
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM suggestions WHERE status = 'pending'").get() as { count: number }
    return Number(row.count)
  }

  /** Add one confirmation-gated suggestion. */
  addSuggestion(input: Omit<Suggestion, 'id' | 'status' | 'memoryId' | 'createdAt'> & { createdAt: number }): { id: string } {
    this.assertOpen()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO suggestions (
        id, content, kind, track, domain, project, importance, confidence,
        stable_key, branches, steps, tags, entities_json, relations_json,
        reason, source_session, source_turn, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id, input.content, input.kind, input.track, input.domain, input.project ?? null,
      input.importance, input.confidence,
      input.stableKey === undefined || input.stableKey === '' ? null : normalizeStableKey(input.stableKey),
      input.branches === undefined || input.branches.length === 0 ? null : JSON.stringify(input.branches),
      input.steps === undefined || input.steps.length === 0 ? null : JSON.stringify(input.steps),
      JSON.stringify(input.tags),
      JSON.stringify(input.entities ?? []),
      JSON.stringify(input.relations ?? []),
      input.reason ?? null, input.sourceSession ?? null, input.sourceTurn ?? null,
      input.createdAt,
    )
    return { id }
  }

  /** List suggestions by status (pending first). */
  suggestions(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending', limit = 50): Suggestion[] {
    this.assertOpen()
    const rows = (status === 'all'
      ? this.db.prepare('SELECT * FROM suggestions ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)) as unknown as SuggestionRow[]
    return rows.map(row => ({
      id: row.id,
      content: row.content,
      kind: row.kind,
      track: row.track,
      domain: row.domain,
      importance: row.importance,
      confidence: row.confidence,
      ...(row.stable_key === null ? {} : { stableKey: row.stable_key }),
      ...(row.branches === null ? {} : { branches: parseStringArray(row.branches) }),
      ...(row.steps === null ? {} : { steps: parseStringArray(row.steps) }),
      tags: parseStringArray(row.tags),
      entities: (parseJson(row.entities_json) as EntityInput[] | undefined) ?? [],
      relations: (parseJson(row.relations_json) as RelationInput[] | undefined) ?? [],
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.source_session === null ? {} : { sourceSession: row.source_session }),
      ...(row.source_turn === null ? {} : { sourceTurn: row.source_turn }),
      createdAt: row.created_at,
      status: row.status,
      ...(row.memory_id === null ? {} : { memoryId: row.memory_id }),
    }))
  }

  /** Approve or reject one pending suggestion. Approving writes an active memory. */
  resolveSuggestion(suggestionId: string, decision: 'approve' | 'reject', now = Date.now()): { ok: boolean; memoryId?: string } {
    this.assertOpen()
    const row = this.db.prepare("SELECT * FROM suggestions WHERE id = ? AND status = 'pending'").get(suggestionId) as SuggestionRow | undefined
    if (row === undefined) return { ok: false }
    if (decision === 'reject') {
      this.db.prepare("UPDATE suggestions SET status = 'rejected', resolved_at = ? WHERE id = ?").run(now, suggestionId)
      return { ok: true }
    }
    const result = this.remember({
      content: row.content,
      kind: row.kind,
      track: row.track,
      domain: row.domain,
      importance: row.importance,
      confidence: row.confidence,
      ...(row.stable_key === null ? {} : { stableKey: row.stable_key }),
      ...(row.branches === null ? {} : { branches: parseStringArray(row.branches) }),
      ...(row.steps === null ? {} : { steps: parseStringArray(row.steps) }),
      tags: parseStringArray(row.tags),
      entities: (parseJson(row.entities_json) as EntityInput[] | undefined) ?? [],
      relations: (parseJson(row.relations_json) as RelationInput[] | undefined) ?? [],
      status: 'active',
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.source_session === null ? {} : { sourceSession: row.source_session }),
      ...(row.source_turn === null ? {} : { sourceTurn: row.source_turn }),
      now,
    })
    this.db.prepare("UPDATE suggestions SET status = 'approved', memory_id = ?, resolved_at = ? WHERE id = ?").run(result.memoryId, now, suggestionId)
    return { ok: true, memoryId: result.memoryId }
  }

  /** Memory kinds/tracks/domains observed in the store (UI filters). */
  facets(): { kinds: string[]; tracks: string[]; domains: string[] } {
    this.assertOpen()
    const collect = (column: string, table = 'memories') =>
      (this.db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`).all() as Array<{ value: string }>).map(row => row.value)
    return { kinds: collect('kind'), tracks: collect('track'), domains: collect('domain') }
  }

  /** Stats for profile analysis (M3) and the Web badge. */
  stats(): { total: number; active: number; pending: number; archived: number; byDomain: Record<string, number>; byTrack: Record<string, number> } {    this.assertOpen()
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count)
    const active = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get() as { count: number }).count)
    const archived = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'archived'").get() as { count: number }).count)
    const pending = this.pendingSuggestionCount()
    const byDomain: Record<string, number> = {}
    ;(this.db.prepare("SELECT domain, COUNT(*) AS count FROM memories WHERE status = 'active' GROUP BY domain").all() as Array<{ domain: string; count: number }>)
      .forEach(row => { byDomain[row.domain] = Number(row.count) })
    const byTrack: Record<string, number> = {}
    ;(this.db.prepare("SELECT track, COUNT(*) AS count FROM memories WHERE status = 'active' GROUP BY track").all() as Array<{ track: string; count: number }>)
      .forEach(row => { byTrack[row.track] = Number(row.count) })
    return { total, active, pending, archived, byDomain, byTrack }
  }

  /** One aggregated memory entry for the profile report. */
  private profileEntry(row: { id: string; content: string; kind: MemoryKind; track: MemoryTrack; domain: string; importance: number; confidence: number; created_at: number; updated_at: number; steps: string | null }): ProfileEntry {
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      domain: row.domain,
      importance: row.importance,
      confidence: row.confidence,
      stepCount: row.steps === null ? 0 : (JSON.parse(row.steps) as string[]).length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Domain-scoped aggregation for personal-profile analysis: what the vault
   * knows about the user, split by kind, plus recent activity.
   */
  profileData(domain: string | undefined, limit: number): {
    domain: string | undefined
    overview: {
      total: number
      byKind: Record<string, number>
      byTrack: Record<string, number>
      byDomain: Record<string, number>
      monthly: Array<{ month: string; count: number }>
      firstCreatedAt: number | undefined
      lastCreatedAt: number | undefined
    }
    preferences: ProfileEntry[]
    sops: ProfileEntry[]
    lessons: ProfileEntry[]
    decisions: ProfileEntry[]
    constraints: ProfileEntry[]
    recentLogs: Array<{ content: string; createdAt: number }>
  } {
    this.assertOpen()
    const domainFilter = domain === undefined ? '' : normalizeDomain(domain)
    const where = domainFilter === '' ? "status = 'active'" : "status = 'active' AND domain = ?"
    const args = domainFilter === '' ? [] : [domainFilter]
    const rows = this.db.prepare(`
      SELECT id, content, kind, track, domain, importance, confidence, created_at, updated_at, steps
      FROM memories WHERE ${where}
    `).all(...args) as unknown as Array<{
      id: string; content: string; kind: MemoryKind; track: MemoryTrack; domain: string; importance: number; confidence: number; created_at: number; updated_at: number; steps: string | null
    }>
    const byKind: Record<string, number> = {}
    const byTrack: Record<string, number> = {}
    const byDomain: Record<string, number> = {}
    const monthlyMap = new Map<string, number>()
    let firstCreatedAt: number | undefined
    let lastCreatedAt: number | undefined
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
      byTrack[row.track] = (byTrack[row.track] ?? 0) + 1
      byDomain[row.domain] = (byDomain[row.domain] ?? 0) + 1
      const month = new Date(row.created_at).toISOString().slice(0, 7)
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + 1)
      firstCreatedAt = firstCreatedAt === undefined ? row.created_at : Math.min(firstCreatedAt, row.created_at)
      lastCreatedAt = lastCreatedAt === undefined ? row.created_at : Math.max(lastCreatedAt, row.created_at)
    }
    const pick = (kind: MemoryKind) => rows
      .filter(row => row.kind === kind && row.track !== 'project-log' && row.track !== 'daily-log')
      .sort((a, b) => b.importance - a.importance || b.updated_at - a.updated_at)
      .slice(0, limit)
      .map(row => this.profileEntry(row))
    const logRows = this.db.prepare(`
      SELECT content, created_at FROM memories
      WHERE status = 'active' AND (track = 'daily-log' OR track = 'project-log')
        ${domainFilter === '' ? '' : 'AND domain = ?'}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args, Math.min(limit, 20)) as unknown as Array<{ content: string; created_at: number }>
    return {
      domain: domain === undefined ? undefined : domainFilter,
      overview: {
        total: rows.length,
        byKind,
        byTrack,
        byDomain,
        monthly: [...monthlyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count })),
        firstCreatedAt,
        lastCreatedAt,
      },
      preferences: pick('preference'),
      sops: pick('sop'),
      lessons: pick('lesson'),
      decisions: pick('decision'),
      constraints: pick('constraint'),
      recentLogs: logRows.map(row => ({ content: row.content, createdAt: row.created_at })),
    }
  }

  /** Export all active non-log memories as Hermes-compatible Markdown files. */
  exportMarkdown(directory: string): { files: string[]; entries: number } {
    this.assertOpen()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const files: string[] = []
    let entries = 0
    const renderEntry = (row: MemoryRow): string => {
      const date = new Date(row.created_at).toISOString().slice(0, 10)
      const parts = [`[${date}]`]
      if (row.branches !== null) parts.push(`[branch:${parseStringArray(row.branches).join(',')}]`)
      if (row.domain !== 'general') parts.push(`[domain:${row.domain}]`)
      if (row.kind !== 'fact') parts.push(`[kind:${row.kind}]`)
      parts.push(row.steps === null ? row.content : `${row.content}\n${parseStringArray(row.steps).map((step, index) => `${index + 1}. ${step}`).join('\n')}`)
      return parts.join(' ')
    }
    const writeTrack = (track: MemoryTrack, fileName: string): void => {
      const rows = this.db.prepare(
        "SELECT * FROM memories WHERE track = ? AND status IN ('active','archived') ORDER BY created_at ASC",
      ).all(track) as unknown as MemoryRow[]
      if (rows.length === 0) return
      const path = join(directory, fileName)
      writeFileSync(path, `${rows.map(renderEntry).join('\n§\n')}\n`, 'utf8')
      files.push(path)
      entries += rows.length
    }
    writeTrack('user', 'USER.md')
    writeTrack('global', 'MEMORY.md')

    const projectRows = this.db.prepare(
      "SELECT DISTINCT project FROM memories WHERE project IS NOT NULL AND track IN ('project','project-log') AND status IN ('active','archived') ORDER BY project",
    ).all() as Array<{ project: string }>
    for (const { project } of projectRows) {
      const slug = slugify(project)
      const projectDir = join(directory, 'projects', slug)
      mkdirSync(projectDir, { recursive: true, mode: 0o700 })
      for (const [track, fileName] of [['project', 'KEY.md'], ['project-log', 'LOG.md']] as const) {
        const rows = this.db.prepare(
          "SELECT * FROM memories WHERE project = ? AND track = ? AND status IN ('active','archived') ORDER BY created_at ASC",
        ).all(project, track) as unknown as MemoryRow[]
        if (rows.length === 0) continue
        const path = join(projectDir, fileName)
        writeFileSync(path, `${rows.map(renderEntry).join('\n§\n')}\n`, 'utf8')
        files.push(path)
        entries += rows.length
      }
    }

    const dailyRows = this.db.prepare(
      "SELECT * FROM memories WHERE track = 'daily-log' AND status IN ('active','archived') ORDER BY created_at ASC",
    ).all() as unknown as MemoryRow[]
    if (dailyRows.length > 0) {
      const byDay = new Map<string, MemoryRow[]>()
      dailyRows.forEach(row => {
        const day = new Date(row.created_at).toISOString().slice(0, 10)
        const list = byDay.get(day) ?? []
        list.push(row)
        byDay.set(day, list)
      })
      const dailyDir = join(directory, 'daily')
      mkdirSync(dailyDir, { recursive: true, mode: 0o700 })
      for (const [day, rows] of [...byDay.entries()].sort()) {
        const path = join(dailyDir, `${day}.md`)
        writeFileSync(path, `${rows.map(renderEntry).join('\n§\n')}\n`, 'utf8')
        files.push(path)
        entries += rows.length
      }
    }

    const domainRows = this.db.prepare(
      "SELECT DISTINCT domain FROM memories WHERE status = 'active' AND track NOT IN ('project-log','daily-log') ORDER BY domain",
    ).all() as Array<{ domain: string }>
    if (domainRows.length > 0) {
      const domainDir = join(directory, 'domains')
      mkdirSync(domainDir, { recursive: true, mode: 0o700 })
      for (const { domain } of domainRows) {
        const rows = this.db.prepare(
          "SELECT * FROM memories WHERE domain = ? AND status = 'active' AND track NOT IN ('project-log','daily-log') ORDER BY created_at ASC",
        ).all(domain) as unknown as MemoryRow[]
        if (rows.length === 0) continue
        const path = join(domainDir, `${slugify(domain)}.md`)
        writeFileSync(path, `${rows.map(renderEntry).join('\n§\n')}\n`, 'utf8')
        files.push(path)
        entries += rows.length
      }
    }
    return { files, entries }
  }

  /** Export the full database as JSONL lines of {table, row}. */
  exportJsonl(path: string): { path: string; records: number } {
    this.assertOpen()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tables = ['memories', 'entities', 'entity_aliases', 'memory_entities', 'relations', 'turn_archives', 'suggestions', 'meta'] as const
    let records = 0
    const lines: string[] = []
    for (const table of tables) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>
      for (const row of rows) {
        lines.push(JSON.stringify({ table, row }))
        records++
      }
    }
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    return { path, records }
  }

  /** Restore a JSONL backup into an empty database. */
  importJsonl(path: string): { path: string; records: number } {
    this.assertOpen()
    const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count)
    if (count > 0) throw new Error('memory vault: import requires an empty database')
    const resolved = realpathSync(path)
    const lines = readFileSync(resolved, 'utf8').split('\n').filter(line => line.trim() !== '')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const line of lines) {
        const parsed = JSON.parse(line) as { table: string; row: Record<string, unknown> }
        const table = parsed.table
        if (!/^[a-z_]+$/u.test(table)) throw new Error(`memory vault: invalid backup table "${table}"`)
        const columns = Object.keys(parsed.row)
        const placeholders = columns.map(() => '?').join(', ')
        const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
        insert.run(...columns.map(column => parsed.row[column] as SQLInputValue))
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { path, records: lines.length }
  }

  /** Compact: prune old turn archives beyond the retention window (M2 hook). */
  pruneArchives(retentionDays: number): number {
    this.assertOpen()
    const cutoff = Date.now() - retentionDays * 86_400_000
    return Number(this.db.prepare('DELETE FROM turn_archives WHERE created_at < ?').run(cutoff).changes)
  }

  // ---- M2: turn archives + automatic extraction ---------------------------

  /** Persist one reconstructed turn for offline re-extraction. */
  archiveTurn(input: {
    sessionId: string
    turn: number
    sourceEventSeqs: number[]
    messages: Array<{ seq: number; role: string; text: string; toolName?: string }>
    truncated: boolean
    originalMessageCount: number
    provider: string
    model: string
    status: 'pending' | 'archived'
    now?: number
  }): { id: string } {
    this.assertOpen()
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO turn_archives (
        id, session_id, turn, source_event_seqs, messages, truncated,
        original_message_count, provider, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET
        source_event_seqs = excluded.source_event_seqs,
        messages = excluded.messages,
        truncated = excluded.truncated,
        original_message_count = excluded.original_message_count,
        provider = excluded.provider,
        model = excluded.model,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      id, input.sessionId, input.turn, JSON.stringify(input.sourceEventSeqs),
      JSON.stringify(input.messages), input.truncated ? 1 : 0, input.originalMessageCount,
      input.provider, input.model, input.status, now, now,
    )
    return { id }
  }

  /** Fetch one turn archive by id, or by sessionId + turn. */
  turnArchive(idOrSessionId: string, turn?: number): {
    id: string
    sessionId: string
    turn: number
    sourceEventSeqs: number[]
    messages: Array<{ seq: number; role: string; text: string; toolName?: string }>
    truncated: boolean
    originalMessageCount: number
    provider: string
    model: string
    status: 'pending' | 'archived' | 'summarized' | 'failed'
    error?: string
    createdAt: number
    updatedAt: number
  } | undefined {
    this.assertOpen()
    const row = (turn === undefined
      ? this.db.prepare('SELECT * FROM turn_archives WHERE id = ?').get(idOrSessionId)
      : this.db.prepare('SELECT * FROM turn_archives WHERE session_id = ? AND turn = ?').get(idOrSessionId, turn)) as {
      id: string
      session_id: string
      turn: number
      source_event_seqs: string
      messages: string
      truncated: number
      original_message_count: number
      provider: string
      model: string
      status: 'pending' | 'archived' | 'summarized' | 'failed'
      error: string | null
      created_at: number
      updated_at: number
    } | undefined
    if (row === undefined) return undefined
    return {
      id: row.id,
      sessionId: row.session_id,
      turn: row.turn,
      sourceEventSeqs: parseNumberArray(row.source_event_seqs),
      messages: JSON.parse(row.messages) as Array<{ seq: number; role: string; text: string; toolName?: string }>,
      truncated: row.truncated === 1,
      originalMessageCount: row.original_message_count,
      provider: row.provider,
      model: row.model,
      status: row.status,
      ...(row.error === null ? {} : { error: row.error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** Transition one archive's status. */
  markArchive(id: string, status: 'pending' | 'archived' | 'summarized' | 'failed', error?: string): void {
    this.assertOpen()
    this.db.prepare('UPDATE turn_archives SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error ?? null, Date.now(), id)
  }

  /** True when the turn already has a committed extraction. */
  hasExtraction(sessionId: string, turn: number): boolean {
    this.assertOpen()
    return this.db.prepare('SELECT 1 FROM extractions WHERE session_id = ? AND turn = ?').get(sessionId, turn) !== undefined
  }

  /** Oldest failed archives, for bounded startup retry. */
  failedArchives(limit: number): Array<{ id: string; sessionId: string; turn: number }> {
    this.assertOpen()
    const rows = this.db.prepare(`
      SELECT id, session_id, turn FROM turn_archives WHERE status = 'failed'
      ORDER BY updated_at ASC LIMIT ?
    `).all(limit) as Array<{ id: string; session_id: string; turn: number }>
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, turn: row.turn }))
  }

  /** Status histogram of turn archives (dashboard). */
  archiveStatusCounts(): { pending: number; archived: number; summarized: number; failed: number } {
    this.assertOpen()
    const counts = { pending: 0, archived: 0, summarized: 0, failed: 0 }
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM turn_archives GROUP BY status').all() as Array<{ status: keyof typeof counts; count: number }>
    rows.forEach(row => { counts[row.status] = Number(row.count) })
    return counts
  }

  /** Active stable facts, for extraction dedup reuse. */
  stableFacts(limit: number): Array<{ stableKey: string; content: string }> {
    this.assertOpen()
    const rows = this.db.prepare(`
      SELECT stable_key, content FROM memories WHERE status = 'active' AND stable_key IS NOT NULL
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as Array<{ stable_key: string; content: string }>
    return rows.map(row => ({ stableKey: row.stable_key, content: row.content }))
  }

  /**
   * Commit one extraction round: store the audit record and file the
   * candidates into the confirmation queue (nothing becomes active without
   * explicit approval). Returns the created suggestion ids.
   */
  commitExtraction(input: {
    sessionId: string
    turn: number
    sourceEventSeqs: number[]
    summary: string
    candidates: Array<{
      content: string
      kind: MemoryKind
      track: MemoryTrack
      domain: string
      importance: number
      confidence: number
      stableKey?: string
      steps?: string[]
      tags: string[]
      entities: EntityInput[]
      relations: RelationInput[]
    }>
    provider: string
    model: string
    requestJson: string
    responseJson: string
    reason: string
    now: number
  }): { extractionId: string; suggestionIds: string[] } {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const extractionId = randomUUID()
      this.db.prepare(`
        INSERT OR IGNORE INTO extractions (
          id, session_id, turn, summary, source_event_seqs, provider, model,
          request_json, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        extractionId, input.sessionId, input.turn, input.summary, JSON.stringify(input.sourceEventSeqs),
        input.provider, input.model, input.requestJson, input.responseJson, input.now,
      )
      const suggestionIds: string[] = []
      // Dedup guard: never file a candidate that duplicates an active memory
      // or an already-pending suggestion (normalized content identity).
      const activeKeys = new Set((this.db.prepare("SELECT content FROM memories WHERE status = 'active'").all() as Array<{ content: string }>)
        .map(row => compactEntityIdentity(row.content)))
      const pendingKeys = new Set((this.db.prepare("SELECT content FROM suggestions WHERE status = 'pending'").all() as Array<{ content: string }>)
        .map(row => compactEntityIdentity(row.content)))
      for (const candidate of input.candidates) {
        const key = compactEntityIdentity(candidate.content)
        if (activeKeys.has(key) || pendingKeys.has(key)) continue
        pendingKeys.add(key)
        const { id } = this.addSuggestion({
          content: candidate.content,
          kind: candidate.kind,
          track: candidate.track,
          domain: candidate.domain,
          importance: candidate.importance,
          confidence: candidate.confidence,
          ...(candidate.stableKey === undefined ? {} : { stableKey: candidate.stableKey }),
          ...(candidate.steps === undefined ? {} : { steps: candidate.steps }),
          tags: candidate.tags,
          entities: candidate.entities,
          relations: candidate.relations,
          reason: input.reason,
          sourceSession: input.sessionId,
          sourceTurn: input.turn,
          createdAt: input.now,
        })
        suggestionIds.push(id)
      }
      this.db.exec('COMMIT')
      return { extractionId, suggestionIds }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- M2: entity maintenance ----------------------------------------------

  /** Merge a duplicate source entity into the canonical target entity. */
  mergeEntities(target: string, source: string): { entityId: string; mergedEntityId?: string; memoryLinksMoved: number; relationsMoved: number } {
    this.assertOpen()
    const targetId = this.resolveEntityId(target)
    const sourceId = this.resolveEntityId(source)
    if (targetId === undefined || sourceId === undefined) throw new Error('memory vault: entity not found')
    if (targetId === sourceId) return { entityId: targetId, memoryLinksMoved: 0, relationsMoved: 0 }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const memoryLinksMoved = Number(this.db.prepare(`
        INSERT OR IGNORE INTO memory_entities (memory_id, entity_id)
        SELECT memory_id, ? FROM memory_entities WHERE entity_id = ?
      `).run(targetId, sourceId).changes)
      const relationsMoved = Number(this.db.prepare(`
        INSERT OR IGNORE INTO relations (source_id, predicate, target_id, confidence, source_memory_id)
        SELECT CASE WHEN source_id = ? THEN ? ELSE source_id END,
               predicate,
               CASE WHEN target_id = ? THEN ? ELSE target_id END,
               confidence, source_memory_id
        FROM relations WHERE source_id = ? OR target_id = ?
      `).run(sourceId, targetId, sourceId, targetId, sourceId, sourceId).changes)
      this.db.prepare('UPDATE entity_aliases SET entity_id = ?, mentions = mentions + 1 WHERE entity_id = ?').run(targetId, sourceId)
      this.db.prepare('DELETE FROM relations WHERE source_id = ? OR target_id = ?').run(sourceId, sourceId)
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(sourceId)
      this.db.exec('COMMIT')
      return { entityId: targetId, mergedEntityId: sourceId, memoryLinksMoved, relationsMoved }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Change an entity display name, keeping the previous spelling as an alias. */
  renameEntity(entity: string, name: string): { entityId: string; previousName: string; name: string } {
    this.assertOpen()
    const id = this.resolveEntityId(entity)
    if (id === undefined) throw new Error('memory vault: entity not found')
    const row = this.db.prepare('SELECT name FROM entities WHERE id = ?').get(id) as { name: string }
    const normalized = normalizeEntity(name)
    const conflict = this.db.prepare('SELECT id FROM entities WHERE normalized = ? AND id != ?').get(normalized, id) as { id: string } | undefined
    if (conflict !== undefined) throw new Error(`memory vault: name "${name}" already belongs to another entity`)
    this.db.prepare('UPDATE entities SET name = ?, normalized = ? WHERE id = ?').run(name, normalized, id)
    this.db.prepare('INSERT OR IGNORE INTO entity_aliases (alias_normalized, entity_id, display_name) VALUES (?, ?, ?)').run(normalizeEntity(row.name), id, row.name)
    return { entityId: id, previousName: row.name, name }
  }

  /** Delete one entity and its graph links without touching memory texts. */
  deleteEntity(entity: string): { deleted: boolean; memoryLinksDeleted: number; relationsDeleted: number } {
    this.assertOpen()
    const id = this.resolveEntityId(entity)
    if (id === undefined) return { deleted: false, memoryLinksDeleted: 0, relationsDeleted: 0 }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const memoryLinksDeleted = Number(this.db.prepare('DELETE FROM memory_entities WHERE entity_id = ?').run(id).changes)
      const relationsDeleted = Number(this.db.prepare('DELETE FROM relations WHERE source_id = ? OR target_id = ?').run(id, id).changes)
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return { deleted: true, memoryLinksDeleted, relationsDeleted }
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Entities with no active memory or relation references. */
  listOrphans(limit: number): Array<{ id: string; name: string; kind: string }> {
    this.assertOpen()
    return this.db.prepare(`
      SELECT id, name, kind FROM entities
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_entities me JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id = entities.id AND m.status = 'active'
      ) AND NOT EXISTS (
        SELECT 1 FROM relations r LEFT JOIN memories m ON m.id = r.source_memory_id
        WHERE (r.source_id = entities.id OR r.target_id = entities.id)
          AND (r.source_memory_id IS NULL OR m.status = 'active')
      )
      ORDER BY name LIMIT ?
    `).all(limit) as Array<{ id: string; name: string; kind: string }>
  }

  /** Conservative duplicate-entity candidates (separator-insensitive + edit distance). */
  findDuplicateEntities(entity: string | undefined, limit: number, minScore: number): Array<{ left: { id: string; name: string; kind: string }; right: { id: string; name: string; kind: string }; score: number; reason: string }> {
    this.assertOpen()
    const rows = (entity === undefined
      ? this.db.prepare('SELECT id, name, kind FROM entities ORDER BY name LIMIT 400').all()
      : this.db.prepare('SELECT id, name, kind FROM entities ORDER BY name LIMIT 400').all()) as Array<{ id: string; name: string; kind: string }>
    const candidates: Array<{ left: { id: string; name: string; kind: string }; right: { id: string; name: string; kind: string }; score: number; reason: string }> = []
    const targetIds = entity === undefined ? undefined : new Set(this.searchEntityIds(normalizeEntity(entity), 8).map(row => row.id))
    const pool = targetIds === undefined ? rows : rows.filter(row => targetIds.has(row.id))
    for (let i = 0; i < pool.length && candidates.length < limit; i++) {
      for (let j = i + 1; j < pool.length && candidates.length < limit; j++) {
        const left = pool[i]!
        const right = pool[j]!
        const leftKey = compactEntityIdentity(left.name)
        const rightKey = compactEntityIdentity(right.name)
        if (leftKey === rightKey) {
          candidates.push({ left, right, score: 1, reason: 'identical-after-normalization' })
          continue
        }
        const maxLength = Math.max(leftKey.length, rightKey.length)
        if (maxLength === 0 || Math.min(leftKey.length, rightKey.length) < 2) continue
        const distance = boundedLevenshtein(leftKey, rightKey, Math.ceil(maxLength * 0.25))
        if (distance === undefined) continue
        const score = 1 - distance / maxLength
        if (score >= minScore) candidates.push({ left, right, score: Number(score.toFixed(3)), reason: 'edit-distance' })
      }
    }
    return candidates.sort((a, b) => b.score - a.score)
  }

  private resolveEntityId(value: string): string | undefined {
    const direct = this.db.prepare('SELECT id FROM entities WHERE id = ?').get(value) as { id: string } | undefined
    if (direct !== undefined) return direct.id
    const alias = this.db.prepare('SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?')
      .get(normalizeEntity(value)) as { entity_id: string } | undefined
    return alias?.entity_id
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

/** Keep tests tidy: remove a directory tree if it exists. */
export function removeDirIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}
