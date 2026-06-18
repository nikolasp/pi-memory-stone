/**
 * Database schema for pi-memory-stone.
 * Versioned migrations applied sequentially.
 */

export const SCHEMA_VERSION = 2;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      -- Track indexed sessions
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_file TEXT UNIQUE,
        cwd TEXT,
        repo_root TEXT,
        project_id TEXT,
        session_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source_status TEXT NOT NULL DEFAULT 'active',
        file_mtime INTEGER,
        file_size INTEGER,
        schema_version INTEGER NOT NULL DEFAULT 1
      );

      -- Structured memory records
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        project_id TEXT,
        session_id TEXT,
        session_file TEXT,
        branch_leaf_id TEXT,
        entry_id_start TEXT,
        entry_id_end TEXT,
        text TEXT NOT NULL,
        tags TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 1.0,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        superseded_by TEXT,
        derived_from_memory_refs TEXT
      );

      -- Full-text search index (contentless — manually synced)
      CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(
        text,
        tags
      );

      -- File activity tracking
      CREATE TABLE IF NOT EXISTS file_activity (
        id TEXT PRIMARY KEY,
        record_id TEXT,
        project_id TEXT,
        path TEXT NOT NULL,
        action TEXT NOT NULL,
        entry_id TEXT
      );

      -- Injection audit log
      CREATE TABLE IF NOT EXISTS injections (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        turn_entry_id TEXT,
        prompt_hash TEXT,
        injected_refs TEXT,
        packet TEXT,
        reasons TEXT,
        created_at INTEGER NOT NULL
      );

      -- Per-session-file indexing progress
      CREATE TABLE IF NOT EXISTS index_state (
        session_file TEXT PRIMARY KEY,
        session_id TEXT,
        last_indexed_entry_id TEXT,
        last_indexed_entry_timestamp TEXT,
        file_mtime INTEGER,
        file_size INTEGER,
        branch_leaf_id TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );

      -- Background job queue
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Schema migration tracking
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        name TEXT NOT NULL
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
      CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS idx_records_scope ON records(scope);
      CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);
      CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
      CREATE INDEX IF NOT EXISTS idx_file_activity_record ON file_activity(record_id);
      CREATE INDEX IF NOT EXISTS idx_file_activity_path ON file_activity(path);
      CREATE INDEX IF NOT EXISTS idx_file_activity_project ON file_activity(project_id);
      CREATE INDEX IF NOT EXISTS idx_injections_session ON injections(session_id);
    `,
  },
  {
    version: 2,
    name: "file-activity-timestamp",
    sql: `
      ALTER TABLE file_activity ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_file_activity_created_at ON file_activity(created_at);
    `,
  },
];

/** Record kinds */
export const RECORD_KINDS = [
  "session_summary",
  "turn_summary",
  "decision",
  "preference",
  "task",
  "error_resolution",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** Record scopes */
export const RECORD_SCOPES = ["project", "global"] as const;
export type RecordScope = (typeof RECORD_SCOPES)[number];

/** Record statuses */
export const RECORD_STATUSES = ["active", "soft_forgotten", "hard_forgotten", "superseded"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Source statuses */
export const SOURCE_STATUSES = ["active", "missing", "archived"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Job statuses */
export const JOB_STATUSES = ["pending", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** File action types */
export const FILE_ACTIONS = ["read", "write", "edit", "bash", "delete"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];
