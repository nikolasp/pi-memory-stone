---
name: pi-memory-stone
description: Persistent cross-session memory for pi via SQLite+FTS5. Remembers past decisions, preferences, turns, and error resolutions across sessions. Use when recalling context from prior sessions, using memory_search/memory_open/memory_remember/memory_forget tools, troubleshooting memory injection, or when user asks about pi-memory-stone, memory stone, session memory, or remembering context.
---

# Pi Memory Stone

pi-memory-stone indexes session turns into a searchable SQLite+FTS5 database (`~/.pi/agent/memory/memory.db`) and auto-injects relevant past memories into the system prompt before each agent turn.

**Quick check:** `/memory-status` and `/memory-search <query>`.

## Tools

### `memory_search(query, kind?, scope?, limit?)` — find past context

Use **before** answering questions that may have been addressed in past sessions. FTS5-based: include concrete keywords, not abstract concepts. Use `kind` filter for precision: `"decision"`, `"error_resolution"`, `"preference"`, `"task"`, `"turn_summary"`, `"session_summary"`. Use `scope: "global"` for cross-project recall.

**Examples:** `memory_search("database schema user authentication")`, `memory_search("Next.js build error", kind: "error_resolution")`, `memory_search("deployment workflow", scope: "global")`.

### `memory_open(ref)` — full record by ID

Use when an injection packet or search result references a record ID (e.g., `ref=abc123`). Returns full text and metadata. Only shows records visible in current project.

### `memory_remember(kind, text, scope?, tags?, importance?)` — explicit storage

Use **only when the user explicitly asks** to remember something. Defaults to `scope: "project"`. Use `scope: "global"` only when the user says "for all projects". Auto-downgrades to project scope if text appears to contain secrets, hostnames, or internal details.

### `memory_forget(ref, hard?)` — remove stale/wrong memories

Soft-forget hides from future searches. Hard delete (`hard: true`) requires user confirmation via the `/memory-forget --hard` command.

## Ranking (craft better queries)

Hybrid score: FTS match × kind boost × recency decay × confidence × importance, then sorted descending.

| Factor | Boost | Implication |
|---|---|---|
| Same-project | ×1.5 | Current project memories rank highest |
| Kind: decision | ×1.5 | Decisions and errors surface prominently |
| Kind: error_resolution | ×1.4 | |
| Kind: preference | ×1.3 | |
| Recency | Half-life 7 days | Older memories fade; add time hints to queries |
| Confidence × Importance | 0.5–1.5× | Explicitly remembered items outrank auto-indexed turns |

Queries include the user's first ~200 chars + basenames of recently touched files. Include filenames when searching for file-specific context.

## Injection modes

| Mode | Behavior |
|---|---|
| `auto` (default) | FTS5 search every turn + manual refs. Score threshold: 0.3. Auto-injected refs not re-injected (anti-feedback-loop). |
| `manual` | Only `/memory-inject` refs. Inject every turn until `/memory-clear-injected`. |

Session override (`/memory-mode`) takes precedence over config. Check: `/memory-status`.

## Session state (per-session, persists across turns)

- **enabled** — toggle via `/memory-on` / `/memory-off`
- **injectionMode** — `auto` or `manual`, via `/memory-mode`, falls back to config
- **manualRefs** — via `/memory-inject <ref>`, cleared by `/memory-clear-injected`

## Commands quick reference

| Command | Purpose |
|---|---|
| `/memory-status [-v]` | Stats, config, effective mode |
| `/memory-search <q>` | Search (top 20) |
| `/memory-open <ref>` | Full record |
| `/memory-inject <ref>...` | Add manual refs for session |
| `/memory-clear-injected` | Clear manual refs |
| `/memory-mode <auto\|manual>` | Override injection mode |
| `/memory-last` | Last injection packet |
| `/memory-forget <ref> [--hard]` | Soft/hard delete |
| `/memory-export [path] [--format json\|md] [--all]` | Portable export |
| `/memory-import <file> [--preserve-project\|--global]` | Import (default: remap to current project) |
| `/memory-backup [path]` | Backup SQLite DB |
| `/memory-on` / `/memory-off` | Enable/disable injection |

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| No memories injected | Score < 0.3 threshold, manual mode, or `/memory-off` | Lower threshold, `/memory-mode auto`, or `/memory-on` |
| Cross-project memories missing | `crossProjectEnabled: false` in config | Enable in `.pi/settings.json` or `/memory-inject` manually |
| Search returns nothing | Keywords don't match FTS5, or record soft_forgotten | Use concrete terms; try `/memory-export --all` to find |
| Global `memory_remember` refused | Text matched as sensitive | The tool auto-downgrades safely; this is expected |

## Config

`.pi/settings.json` in project root (all fields optional, shown with defaults):

```json
{ "memory": { "enabled": true, "maxInjectedRecords": 5, "maxInjectedTokens": 1000, "scoreThreshold": 0.3, "crossProjectEnabled": false, "injectionMode": "auto" } }
```

## Privacy guarantees

- All text redacted before storage: API keys, tokens, passwords, connection strings
- Sensitive paths never indexed: `.env`, keys, certs, `node_modules`, `.git`, `.ssh`, `.aws`
- Global scope refused for text containing secret/hostname/internal patterns
- `memory_open` only shows records visible in current project
