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
│   ├── privacy/                  # Secret redaction, sensitive path filtering
│   └── config/                   # Project identity, settings
└── test/                         # 44 tests across 4 suites
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

48 tests across 5 test files:

| Suite | Tests | Focus |
|---|---|---|
| `indexing.test.ts` | 1 | Incremental session indexing |
| `privacy.test.ts` | 17 | Secret redaction, sensitive path filtering |
| `parser.test.ts` | 10 | Turn parsing, file activity detection, error extraction |
| `ranking.test.ts` | 16 | Hybrid ranking, cross-project filtering, injection formatting |
| `session-state.test.ts` | 4 | Injection mode config, session ref selection, manual-only injection |

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
- `/memory-edit`, `/memory-supersede`
- Rich TUI memory browser
- Multi-machine sync
- Daemon-mode background worker for LLM extraction
- `/memory-prune-missing`
- `.pi/memoryignore` and `~/.pi/agent/memoryignore`

## License

MIT — see [LICENSE](./LICENSE) for details.
