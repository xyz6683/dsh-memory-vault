/** Shared domain types for dsh-memory-vault. */

// DSH 0.2.x removed the catch-all `plugin` message source: each producer
// declares its own kind. Augment the merge-extensible MessageSourceMap with
// this plugin's kind; the `snapshot` form marks the injected recall context
// as current-state context that supersedes earlier snapshots from us.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-vault': { kind: 'memory-vault' } & import('@deepseek-ai/dsh-llm').ContextFormed
  }
}

/** What kind of durable information one memory holds. */
export const MEMORY_KINDS = [
  'preference', 'fact', 'decision', 'constraint', 'lesson', 'sop', 'event', 'summary',
] as const
export type MemoryKind = typeof MEMORY_KINDS[number]

/** Layered memory tracks. */
export const MEMORY_TRACKS = ['user', 'global', 'project', 'project-log', 'daily-log'] as const
export type MemoryTrack = typeof MEMORY_TRACKS[number]

/** Lifecycle status of one memory row. */
export const MEMORY_STATUSES = ['active', 'pending', 'archived', 'superseded'] as const
export type MemoryStatus = typeof MEMORY_STATUSES[number]

/** An entity mentioned by a memory. */
export interface EntityInput {
  name: string
  kind?: string
  canonical?: string
  aliases?: string[]
}

/** A directed knowledge-graph edge supported by a memory. */
export interface RelationInput {
  source: string
  predicate: string
  target: string
  confidence?: number
}

/** Input for one memory write. */
export interface RememberInput {
  content: string
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  project?: string
  importance: number
  confidence: number
  stableKey?: string
  branches?: string[]
  steps?: string[]
  tags: string[]
  entities: EntityInput[]
  relations: RelationInput[]
  status: 'active' | 'pending'
  sourceSession?: string
  sourceTurn?: number
  now: number
}

/** Result of one atomic memory write. */
export interface RememberResult {
  memoryId: string
  entityCount: number
  relationCount: number
  deduplicated: boolean
  supersededMemoryId?: string
  entityConflicts: Array<{ entityId: string; field: string; kept: string; incoming: string }>
}

/** Retrieval weights for hybrid ranking. */
export interface RetrievalWeights {
  lexical: number
  graph: number
  importance: number
  recency: number
  access: number
  domain: number
}

/** Options controlling one hybrid search. */
export interface RecallOptions {
  limit: number
  hops: number
  halfLifeDays: number
  weights: RetrievalWeights
  domainBoost: number
  domainScores: ReadonlyMap<string, number>
  domain?: string
  track?: MemoryTrack
  kind?: MemoryKind
  reinforce?: boolean
  now?: number
}

/** One ranked recall hit. */
export interface RecallResult {
  id: string
  content: string
  score: number
  importance: number
  confidence: number
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  stableKey?: string
  hasSteps: boolean
  createdAt: number
  tags: string[]
  entities: Array<{ name: string; kind: string }>
  reasons: string[]
}

/** One entity node in a graph view. */
export interface GraphNode {
  id: string
  name: string
  kind: string
  distance: number
}

/** One directed edge in a graph view. */
export interface GraphEdge {
  source: string
  predicate: string
  target: string
  confidence: number
  mentions?: number
}

/** A memory shown inside a graph view. */
export interface GraphMemory {
  id: string
  content: string
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  importance: number
  confidence: number
  entities: string[]
  sourceSession?: string
  sourceTurn?: number
}

/** A graph neighbourhood or global overview. */
export interface GraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  memories: GraphMemory[]
}

/** A pending suggestion waiting for user confirmation. */
export interface Suggestion {
  id: string
  content: string
  kind: MemoryKind
  track: MemoryTrack
  domain: string
  project?: string
  importance: number
  confidence: number
  stableKey?: string
  branches?: string[]
  steps?: string[]
  tags: string[]
  entities: EntityInput[]
  relations: RelationInput[]
  reason?: string
  sourceSession?: string
  sourceTurn?: number
  createdAt: number
  status: 'pending' | 'approved' | 'rejected'
  memoryId?: string
}

/** Where automatic turn extraction writes candidate memories (M2). */
export interface ExtractCandidate {
  content: string
  kind: MemoryKind
  domain: string
  importance: number
  confidence: number
  stableKey?: string
  tags: string[]
  entities: EntityInput[]
  relations: RelationInput[]
}

/** One aggregated memory entry in a profile report. */
export interface ProfileEntry {
  id: string
  content: string
  kind: MemoryKind
  domain: string
  importance: number
  confidence: number
  stepCount: number
  createdAt: number
  updatedAt: number
}

/** Input to commit one automatic extraction round. */
export interface ExtractionCommitInput {
  sessionId: string
  turn: number
  sourceEventSeqs: number[]
  candidates: ExtractCandidate[]
  provider: string
  model: string
  now: number
}
