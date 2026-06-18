# Release Notes

This project currently has no git tags in this checkout. The first release documented here is the pending `0.1.5` release.

## 0.1.5

### Added
- SQLite database hardening: WAL lifecycle cleanup, prepared statement caching, schema health helpers, and stricter file permissions for the memory database files.
- `file_activity.created_at` migration plus recent-file retrieval for automatic injection, `/memory-search`, and `memory_search`.
- `/memory-status --debug` diagnostics for database path/size, schema version, journal mode, FTS health, last indexed entry, last injection, and pending jobs.
- Tests for config caching, FTS semantics, recent file activity, runtime warning suppression, additional parser behavior, privacy heuristics, ranking, and vault capture behavior.

### Changed
- Session memory state is keyed by pi session id instead of module-level mutable state.
- Removed process `exit` cleanup hook; database close now happens during session shutdown.
- FTS search defaults to AND semantics, supports quoted phrases, and has explicit match-any behavior for recent-file queries.
- FTS SQL now filters project/global visibility before ranking common project-scoped searches.
- Retrieval includes recently touched filenames as an additional candidate signal.
- Global-memory sensitivity heuristics are less noisy for portable preferences while still blocking secrets, paths, sensitive filenames, hosts, and local project details.
- `memory_search` output is a concise numbered list while preserving structured result details.
- Vault HTML extraction reuses a shared Turndown service instance.
- README test matrix updated to the current suite.
