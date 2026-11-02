# dsh-memory-vault

**Local-first long-term memory and personal-profile plugin for DeepSeek Harness.**

Distill SOPs, best practices, and personal preferences across conversations; recall them automatically in new sessions; aggregate everything into a personal profile by life domain. All data stays in a local SQLite file — zero external services, zero runtime dependencies.

[中文文档](README.zh-CN.md) · Design docs in [`docs/`](docs/)

## What it does

| Capability | Detail |
| --- | --- |
| Structured memory | Seven kinds: `preference / fact / decision / constraint / lesson / sop / event / summary`; SOPs carry ordered steps |
| Layered tracks | `user` (personal profile) · `global` (facts & SOPs) · `project` (project key facts, git-branch scoped) · `project-log` · `daily-log` |
| Automatic recall | Before each first step, hybrid ranking (Chinese-friendly FTS5 trigram + knowledge-graph distance + importance + time decay + domain weighting) injects the most relevant memories into context, marked as reference data, under a hard token budget |
| Domain dimension | First-class `domain` tags (defaults: dev / career / workflow / english / investment / general), used for recall weighting, Web filtering, and profile aggregation |
| Write gates | Explicit `vault_add` writes land directly; automatic turn extraction files candidates into a **confirmation queue** — nothing becomes active memory without your approval; progress logs are written automatically but never auto-injected |
| Automatic extraction | Completed turns are archived locally and distilled by an LLM into structured candidates (audit trail kept); failures retry and never block your turn |
| Knowledge graph | Entities / aliases / directed relations with conflict reporting; stable facts supersede and can be reverted; merge / rename / duplicate detection / orphan GC |
| Personal profile | `vault_profile` aggregates preferences, SOP inventory, lessons, decisions, and constraints per domain, with an optional LLM narrative — the basis for development and strategy planning |
| Portability | `vault_export` writes human-readable Markdown (`USER.md` / `MEMORY.md` / `projects/` / `daily/` / `domains/`); `vault_backup` exports/restores an exact JSONL snapshot |
| Web UI | In-app "Memory Vault" panel: browse/search memories, approve/reject the confirmation queue, view the profile, one-click Markdown export |

## Requirements

- DeepSeek Harness with a usable profile (built against DSH `0.2.0-rc.2`)
- Node.js `^22.19.0` or `>=24.0.0`

## Install

```bash
git clone https://github.com/yanggao/dsh-memory-vault.git
cd dsh-memory-vault
npm install
npm run check
dsh plugin --profile web add "$PWD"
dsh web            # restart the running dsh web if it was already up
```

Verify:

```bash
dsh --profile web --dump-config | grep -A3 memory-vault
```

Then, in a session, ask the agent: "哪些工具以 vault 开头？" — you should see `vault_add`, `vault_recall`, `vault_expand`, `vault_forget`, `vault_revert`, `vault_graph`, `vault_profile`, `vault_review`, `vault_export`, `vault_backup`, `vault_archive_*`, `vault_entity_*`.

**Cross-conversation check**: in session A say "记一下：这个项目的部署端口是 8080" — the agent calls `vault_add`. Open a new session B and ask "项目的部署端口是多少？" — the answer starts from the injected `<memory_vault_context>` recall block.

## Configuration

All defaults ship in [`cordis.patch.yml`](cordis.patch.yml). Key options:

| Option | Default | Meaning |
| --- | ---: | --- |
| `autoRecall` | `true` | Recall before the first step of every turn |
| `autoRecallLimit` / `autoRecallMinScore` | `5` / `0.18` | How many memories, minimum score |
| `maxContextChars` / `maxContextTokens` | `2600` / `1300` | Hard budget of the injected recall block |
| `domains` / `defaultDomain` | 6 domains | Domain dimension (editable) |
| `weights` | six weights | Hybrid ranking mix |
| `explicitWritesActive` | `true` | Explicit `vault_add` writes land directly |
| `autoExtract` | `false` | Turn on automatic extraction (candidates go to the confirmation queue; requires a working model route) |
| `extractMinConfidence` | `0.65` | Minimum confidence for extraction candidates |
| `profileProvider` / `profileModel` | — | Optional route for the narrative profile; omitted = reuse the session route |

## Data & security

- Database at `$DSH_HOME/dsh-memory-vault.sqlite`, `0600` permissions, WAL mode; `application_id` rejects foreign databases.
- Automatic recall is explicitly marked as reference data, not instructions, and is recorded in the session log.
- Extraction transcripts are bounded (100K chars / 30K tokens per turn) and pruned after `archiveRetentionDays` (30).
- Failed writes go to a local outbox and replay at startup; permanent failures go to a dead-letter file.
- Dashboard API is loopback/trusted-host only, mutations require a process-random token; sensitive data never leaves the machine unless you enable semantic or LLM features.
- Uninstalling (`dsh plugin remove dsh-memory-vault`) removes the plugin but never deletes your database.

## Known limitations

- Single-writer: one writable database should be held by one DSH process (SQLite WAL + busy_timeout protects normal transactions; no distributed coordination).
- Lexical recall matches wording (trigram overlap); cross-language semantic matching is not bundled — optional embeddings are on the roadmap.
- `node:sqlite` may print an experimental-API warning on some Node versions.
- Cross-device sync is not bundled; use `vault_export` / `vault_backup` + git for portability.

## Development

```bash
npm run typecheck   # host + client
npm test            # 28 tests, node's built-in test runner
npm run build       # tsc + tsdown client bundle
```

## License

[MIT](LICENSE) © dsh-memory-vault contributors. The storage layer's FTS5/trigger wiring pattern is adapted from [dsh-memory-graph](https://github.com/zmh2000829/dsh-memory-graph) (MIT); see LICENSE.
