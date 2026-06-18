# pi-memory-stone

A global pi extension that preserves and retrieves useful memory across pi sessions. Raw pi session JSONL files remain the source of truth; the extension builds a searchable, privacy-safe SQLite+FTS5 index with backreferences to exact session entries.

## Status

**MVP vertical slice** — deterministic indexing, FTS5 search, conservative injection, commands, tools, and tests are complete. LLM extraction, embeddings, and historical backfill are deferred.

## Quick Start

Install globally from npm:

```bash
pi install npm:pi-memory-stone
```

Package page: https://www.npmjs.com/package/pi-memory-stone

Then restart pi or run `/reload`, and verify it is active:

```bash
/memory-status
```

Alternative installs:

```bash
# Install directly from GitHub
pi install git:github.com/nikolasp/pi-memory-stone

# Manual global extension checkout
git clone https://github.com/nikolasp/pi-memory-stone ~/.pi/agent/extensions/pi-memory-stone
```

> Scope note: `pi install -l ...` / `pi install --local ...` writes to the current project's `.pi/settings.json` and only loads there. For all projects, run `pi install npm:pi-memory-stone` without `--local` (user settings) or use `~/.pi/agent/extensions/`.

## Architecture

```
~/.pi/agent/memory/memory.db      # SQLite + FTS5 (WAL mode)
pi-memory-stone package source
├── src/
│   ├── index.ts                  # Entry point: hooks, lifecycle
│   ├── db/                       # SQLite connection, migrations, CRUD
│   ├── indexing/                 # Deterministic JSONL parser, agent_end handler
│   ├── retrieval/                # FTS search, hybrid ranking, injection builder
│   ├── commands/                 # /memory-* slash commands
│   ├── tools/                    # LLM-callable tools
│   ├── vault/                    # Optional Obsidian-compatible markdown vaults
│   ├── privacy/                  # Secret redaction, sensitive path filtering
│   └── config/                   # Project identity, settings
└── test/                         # tests across memory, privacy, portable, and vault helpers
```

## How It Works

### 1. Indexing (agent_end)

Every time the agent finishes a response, the extension:

- Reads new session entries since the last indexed position
- Parses turns deterministically (no LLM): extracts user prompts, assistant responses, tool calls, errors
- Redacts secrets (API keys, tokens, passwords, private keys) before storage
- Skips sensitive files (`.env`, keys, certs, `node_modules`, `.git`)
- Stores structured `turn_summary` and `error_resolution` records in SQLite
- Maintains `index_state` per session file so indexing is incremental

### 2. Retrieval (before_agent_start)

Before each agent turn, the extension:

- Builds a focused query from the user's prompt
- Uses `memory.injectionMode` to choose automatic or manual injection
- In `auto` mode, searches records via FTS5
- Ranks by hybrid score: FTS match + same-project boost + recency decay + kind weight + confidence
- Injects top results (max 5, threshold-limited) plus any refs selected with `/memory-inject`
- In `manual` mode, skips search and injects only refs selected with `/memory-inject`
- Tracks auto-injected refs to prevent feedback loops
- Logs every injection for audit via `/memory-last`

### 3. Storage Model

**Records:**
| Kind | Description |
|---|---|
| `turn_summary` | Concatenated user prompt + assistant response + tools used |
| `error_resolution` | Tool errors with context |
| `decision` | Explicitly remembered decisions (LLM/tool) |
| `preference` | User preferences (LLM/tool) |
| `task` | Tracked tasks (LLM/tool) |
| `session_summary` | Session-level summary (future) |

**Scopes:**
| Scope | Visibility |
|---|---|
| `project` | Visible within the same project (git repo root) |
| `global` | Visible across all projects (explicit opt-in only) |

**Statuses:** `active`, `soft_forgotten`, `hard_forgotten`, `superseded`

## Commands

| Command | Alias | Description |
|---|---|---|
| `/memory-status` | `/stone-status` | Show index statistics, record counts by kind, config |
| `/memory-status --verbose` | | Include per-kind record breakdown |
| `/memory-search <query>` | `/stone-search` | Search memory for relevant records |
| `/memory-open <id>` | `/stone-open` | Open a specific memory record by reference ID |
| `/memory-inject <id> [id ...]` | `/stone-inject` | Manually inject specific refs into future turns this session |
| `/memory-clear-injected` | `/stone-clear-injected` | Clear manually injected refs for this session |
| `/memory-mode <auto\|manual>` | `/stone-mode` | Override injection mode for this session |
| `/memory-last` | `/stone-last` | Show the last memory injection packet |
| `/memory-forget <id>` | `/stone-forget` | Soft-forget a record (hide from searches) |
| `/memory-forget <id> --hard` | | Permanently delete (with confirmation) |
| `/memory-export [path] --format json\|md` | `/stone-export` | Export active records to a portable JSON or Markdown file (`--all` includes inactive records) |
| `/memory-import <memory-export.json>` | `/stone-import` | Import records from a JSON export, remapping project-scoped records to the current project by default |
| `/memory-import <memory-export.json> --preserve-project` | | Import records while preserving exported project IDs |
| `/memory-import <memory-export.json> --global` | | Import all records as global memories |
| `/memory-backup [path]` | `/stone-backup` | Copy the SQLite memory database to a timestamped backup file |
| `/memory-vault-init [--project\|--personal]` | `/stone-vault-init` | Initialize an Obsidian-compatible markdown vault |
| `/memory-vault-sync [--project\|--personal]` | `/stone-vault-sync` | Generate vault pages from active memory records |
| `/memory-vault-status [--project\|--personal]` | `/stone-vault-status` | Show vault path, page counts, registry, and last sync |
| `/memory-vault-capture-url <url> [--project\|--personal]` | `/stone-vault-capture-url` | Capture a web page into the vault as a source page |
| `/memory-on` | | Enable memory injection for this session |
| `/memory-off` | | Disable memory injection for this session |

## Tools

### `memory_search`

Search memory stone for relevant records. Use before making decisions to recall past context.

```
Parameters:
  query   Search query text
  kind?   Filter: decision | preference | task | error_resolution | turn_summary | session_summary
  scope?  Filter: project | global
  limit?  Max results (default 5)
```

### `memory_open`

Open a specific memory record by its reference ID.

```
Parameters:
  ref     Memory record reference ID (from search results or injection packets)
```

### `memory_remember`

Explicitly store a memory record. Only use when the user explicitly asks to remember something.

```
Parameters:
  kind         Record kind: decision | preference | task | error_resolution | turn_summary | session_summary
  text         Memory text to store
  scope?       project (default) | global
  tags?        Comma-separated tags
  importance?  0-1 (default 0.5)
```

### `memory_forget`

Soft-forget a memory record by its reference ID. Hard deletion requires explicit user confirmation via command.

```
Parameters:
  ref     Memory record reference ID
  hard?   Request permanent deletion (requires confirmation)
```

## Portable Export, Import, and Backup

Use JSON export/import when you want a portable, reviewable memory transfer between machines:

```bash
/memory-export --format json
/memory-import memory-export.json
```

Markdown export is for human review outside SQLite:

```bash
/memory-export memory-export.md --format md
```

Use a database backup before pruning or hard deletion:

```bash
/memory-backup
```

Import defaults are intentionally practical for machine moves: project-scoped records are remapped to the current project. Use `--preserve-project` to keep exported project IDs, or `--global` to import everything as global memory.

## Knowledge Vaults

Memory vaults are optional Obsidian-compatible markdown projections of active memory records. SQLite remains the source of truth; generated pages may be overwritten by `/memory-vault-sync`.

```bash
# Project-local vault, written only after explicit init or capture request
/memory-vault-init --project
/memory-vault-sync --project
/memory-vault-status --project

# Capture a web page source into the vault
/memory-vault-capture-url https://example.com/article --project

# Capture resolves known source formats before generic HTML extraction.
# Examples: GitHub Gist pages are fetched from gist.githubusercontent.com/raw,
# GitHub blob URLs are fetched from raw.githubusercontent.com, and raw Markdown
# is preserved as Markdown.

# Natural-language capture also works from normal prompts:
# "Capture this article into vault https://example.com/article"
# "Add page to personal vault https://example.com/article"

# Private personal vault for global memories
/memory-vault-init --personal
/memory-vault-sync --personal
```

Default locations:

```txt
<repo>/.memory-stone/vault/              # project vault
~/.pi/agent/memory/vaults/personal/      # personal vault
```

Initial layout:

```txt
index.md
WIKI_SCHEMA.md
records/{decisions,preferences,tasks,error-resolutions,turn-summaries,session-summaries}/
sources/                       # captured web source pages
meta/registry.json
```

URL capture writes curated source notes into `sources/`. Raw provenance packets (manifest, metadata, fetch attempts, original artifact, extracted markdown) are stored outside the Obsidian vault under `.memory-stone/source-packets/` for project vaults or `~/.pi/agent/memory/source-packets/personal/` for personal vaults. Capture extracts HTML articles with Mozilla Readability, converts to Markdown, redacts secrets, and marks extraction quality as `good` or `weak` with warnings.

## Privacy & Safety

### Secret Redaction

All text is redacted before storage. Patterns covered:

- OpenAI API keys (`sk-...`)
- GitHub tokens (`ghp_...`, `ghs_...`)
- AWS access keys (`AKIA...`)
- JWT tokens
- Generic API keys and secrets in `key=value` assignments
- Private keys (PEM format)
- Password/secrets in assignments
- Connection strings (credentials removed)

### Path Filtering

Files at these paths are never indexed:

- `.env*`, `.envrc`
- Keys and certificates (`.pem`, `.key`, `.crt`)
- SSH keys (`id_rsa`, `id_ed25519`, `.ssh/`)
- AWS credentials (`~/.aws/`)
- GPG keys (`~/.gnupg/`)
- Dependency dirs (`node_modules`, `.git`, `dist`, `build`, `.next`, etc.)

### Cross-Project Safety

- Records default to project scope
- Cross-project memory requires explicit global flag
- Global promotion refuses sensitive patterns (paths, secrets, hostnames, implementation details)
- `memory_open` never sends raw excerpts to LLM automatically

## Ranking

Results are ranked by a hybrid score:

| Factor | Effect |
|---|---|
| FTS5 match quality | Base score (normalized reciprocal rank) |
| Same project | ×1.5 boost |
| Global scope | ×1.2 boost |
| Kind weight | Decision ×1.5, Preference ×1.3, Error ×1.4 |
| Recency | Exponential decay, half-life 7 days |
| Confidence | Direct multiplier |
| Importance | 0.5–1.5x multiplier |

## DB Schema

```sql
sessions         — Indexed session metadata
records          — Structured memory records (with FTS5 index)
record_fts       — Full-text search index (contentless)
file_activity    — File read/write/edit/bash tracking
injections       — Audit log of memory injections
index_state      — Per-session indexing progress
jobs             — Background job queue
schema_migrations— Versioned migration tracking
```

Storage: `~/.pi/agent/memory/memory.db` (SQLite, WAL mode, busy timeout 5s).

## Tests

```bash
cd ~/.pi/agent/extensions/pi-memory-stone
npm test
npm run typecheck
```

These scripts are also runnable from a pi package clone installed from git; the required script runners are regular dependencies because pi package installs omit `devDependencies`.

82 tests across 11 test files:

| Suite | Tests | Focus |
|---|---|---|
| `config.test.ts` | 2 | Project-root config discovery and caching |
| `db.test.ts` | 4 | FTS semantics and recent-file activity queries |
| `indexing.test.ts` | 1 | Incremental session indexing |
| `parser.test.ts` | 11 | Turn parsing, file activity detection, error extraction |
| `portable.test.ts` | 5 | JSON/Markdown export, JSON import, SQLite backup |
| `privacy.test.ts` | 22 | Secret redaction, sensitive path filtering |
| `ranking.test.ts` | 18 | Hybrid ranking, cross-project filtering, injection formatting |
| `session-state.test.ts` | 5 | Injection mode config, session ref selection, manual-only injection |
| `tools.test.ts` | 2 | Tool visibility and forgetting safety |
| `vault.test.ts` | 11 | Vault path resolution, initialization, sync, URL capture, registry generation |
| `warnings.test.ts` | 1 | Runtime warning suppression |

## Configuration

Project settings in `.pi/settings.json`:

```json
{
  "memory": {
    "enabled": true,
    "maxInjectedRecords": 5,
    "maxInjectedTokens": 1000,
    "scoreThreshold": 0.3,
    "crossProjectEnabled": false,
    "injectionMode": "auto"
  }
}
```

`injectionMode` accepts:

| Value | Behavior |
|---|---|
| `auto` | Default. Automatically searches relevant memories and also includes refs selected with `/memory-inject`. |
| `manual` | Disables automatic search-based injection. Only refs selected with `/memory-inject` are injected. |

For manual-only memory, keep `enabled: true` and set `injectionMode: "manual"`.

## Deferred (Future Slices)

- LLM extraction (decisions, preferences, tasks)
- Historical backfill (`/memory-backfill`)
- Embedding-based semantic search
- Vault backlinks/lint/search/capture commands
- `/memory-edit`, `/memory-supersede`
- Rich TUI memory browser
- Multi-machine sync
- Daemon-mode background worker for LLM extraction
- `/memory-prune-missing`
- `.pi/memoryignore` and `~/.pi/agent/memoryignore`

## License

MIT — see [LICENSE](./LICENSE) for details.
