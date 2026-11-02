# Changelog

## 0.1.0 (unreleased)

Initial release.

### M1 — core loop

- SQLite storage (schema v2): memories / entities / relations / aliases / turn archives / suggestions / extraction audit.
- Hybrid recall: FTS5 trigram (external-content + triggers), short-term `instr` fallback for <3-char Chinese terms, graph BFS, importance, half-life recency, access log, domain weighting.
- Automatic first-step recall via `agent/pre-step` with hard char/token budget, injected as reference data.
- Tools: `vault_add`, `vault_recall`, `vault_expand`, `vault_forget`, `vault_revert`, `vault_graph`, `vault_export` (Markdown), `vault_backup` (JSONL), `vault_review`.
- Failure handling: local outbox replay, dead-letter file, fail-open recall.

### M2 — automatic distillation

- Turn archives with bounded retention; offline re-extraction without replaying conversations.
- LLM extraction of structured candidates (strict schema validation) filed into the confirmation queue; deterministic domain assignment; content dedup against active and pending memories; full audit trail (`extractions` table).
- Entity maintenance tools: `vault_entity_merge`, `vault_entity_rename`, `vault_entity_find_duplicates`, `vault_entity_delete`, `vault_entity_orphans`; archive tools: `vault_archive_expand`, `vault_archive_retry`.

### M3 — domains & profile

- First-class domain dimension (dev / career / workflow / english / investment / general), keyword-based detection for extraction, weighting for recall.
- `vault_profile`: per-domain aggregation (preferences, SOP inventory, lessons, decisions, constraints, activity timeline) with optional LLM narrative.
- Web UI panel (sidebar "Memory Vault"): memories browser with filters/search, confirmation queue with approve/reject, profile view, one-click Markdown export.
