/**
 * Database module: connection management, migrations, CRUD helpers.
 * Uses node:sqlite (DatabaseSync) for synchronous SQLite operations.
 */

import type { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "../privacy/index.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  type RecordKind,
  type RecordScope,
  type RecordStatus,
  type SourceStatus,
  type JobStatus,
  type FileAction,
} from "./schema.js";

// ─── Paths ──────────────────────────────────────────────────────────

export function getDbPath(): string {
  return process.env.PI_MEMORY_STONE_DB_PATH
    ?? `${process.env.HOME || process.env.USERPROFILE || "/tmp"}/.pi/agent/memory/memory.db`;
}

export function getDbDir(): string {
  return dirname(getDbPath());
}

export const DB_PATH = getDbPath();
export const DB_DIR = getDbDir();

// ─── Singleton ──────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
type DatabaseSyncConstructor = new (path: string) => DatabaseSync;
let DatabaseSyncClass: DatabaseSyncConstructor | null = null;

function isNodeSQLiteExperimentalWarning(warning: string | Error, firstArg: unknown): boolean {
  const message = warning instanceof Error ? warning.message : String(warning);
  const type = warning instanceof Error
    ? warning.name
    : typeof firstArg === "string"
      ? firstArg
      : typeof firstArg === "object" && firstArg !== null && "type" in firstArg
        ? String((firstArg as { type?: unknown }).type)
        : undefined;

  return type === "ExperimentalWarning"
    && message.includes("SQLite is an experimental feature");
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  if (DatabaseSyncClass) return DatabaseSyncClass;

  // node:sqlite is still marked experimental in Node 22, so importing it emits
  // a process warning. pi surfaces stderr from extension loading as
  // "[mcp-bridge]" noise, which is not actionable for users. Suppress only this
  // specific warning while loading the built-in module; all other warnings keep
  // their normal behaviour.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: any[]) => {
    if (isNodeSQLiteExperimentalWarning(warning, args[0])) return;
    return (originalEmitWarning as any).call(process, warning, ...args);
  }) as typeof process.emitWarning;

  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
    DatabaseSyncClass = sqlite.DatabaseSync;
    return DatabaseSyncClass;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dbDir = getDbDir();
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }
    hardenPathPermissions(dbDir, 0o700);
    const DatabaseSync = loadDatabaseSync();
    _db = new DatabaseSync(getDbPath());
    hardenDbFilePermissions();
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA foreign_keys = ON");
    runMigrations(_db);
    hardenDbFilePermissions();
  }
  return _db;
}

function hardenPathPermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort only: do not make memory unavailable on filesystems that
    // do not support POSIX permissions.
  }
}

export function hardenDbFilePermissions(): void {
  const dbPath = getDbPath();
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) {
      hardenPathPermissions(path, 0o600);
    }
  }
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    try {
      _db.close();
    } catch {}
    _db = null;
  }
  _stmtCache.clear();
}

// ─── Prepared statement cache ─────────────────────────────────────

const _stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

/**
 * Returns a cached prepared statement for the given SQL.
 * Cache is invalidated on closeDb().
 */
function prepareStmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
  const cached = _stmtCache.get(sql);
  if (cached) return cached;
  const stmt = getDb().prepare(sql);
  _stmtCache.set(sql, stmt);
  return stmt;
}

// ─── Migrations ─────────────────────────────────────────────────────

function runMigrations(db: DatabaseSync): void {
  // Ensure migration table exists
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      name TEXT NOT NULL
    )`
  );

  const applied = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      db.exec("BEGIN");
      try {
        for (const stmt of migration.sql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)) {
          db.exec(stmt + ";");
        }
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)"
        ).run(migration.version, Date.now(), migration.name);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }
}

// ─── ID generation ──────────────────────────────────────────────────

export function contentHash(text: string, kind: string): string {
  return createHash("sha256").update(kind + ":" + text).digest("hex").slice(0, 16);
}

function recordIdentityHash(
  text: string,
  kind: RecordKind,
  scope: RecordScope,
  projectId: string | null | undefined,
): string {
  const visibilityKey = scope === "global" ? "global" : (projectId ?? "unknown-project");
  return createHash("sha256")
    .update([kind, scope, visibilityKey, text].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

export function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

// ─── Sessions ───────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  session_file: string;
  cwd: string | null;
  repo_root: string | null;
  project_id: string | null;
  session_name: string | null;
  created_at: number;
  updated_at: number;
  source_status: SourceStatus;
  file_mtime: number | null;
  file_size: number | null;
  schema_version: number;
}

export function upsertSession(session: {
  id: string;
  session_file: string;
  cwd?: string | null;
  repo_root?: string | null;
  project_id?: string | null;
  session_name?: string | null;
  file_mtime?: number | null;
  file_size?: number | null;
}): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare("SELECT id FROM sessions WHERE session_file = ?")
    .get(session.session_file) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE sessions SET
        cwd = ?, repo_root = ?, project_id = ?, session_name = ?,
        updated_at = ?, source_status = 'active',
        file_mtime = ?, file_size = ?, schema_version = ?
      WHERE session_file = ?
    `).run(
      session.cwd ?? null,
      session.repo_root ?? null,
      session.project_id ?? null,
      session.session_name ?? null,
      now,
      session.file_mtime ?? null,
      session.file_size ?? null,
      SCHEMA_VERSION,
      session.session_file,
    );
  } else {
    db.prepare(`
      INSERT INTO sessions (id, session_file, cwd, repo_root, project_id, session_name, created_at, updated_at, source_status, file_mtime, file_size, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      session.id,
      session.session_file,
      session.cwd ?? null,
      session.repo_root ?? null,
      session.project_id ?? null,
      session.session_name ?? null,
      now,
      now,
      session.file_mtime ?? null,
      session.file_size ?? null,
      SCHEMA_VERSION,
    );
  }
}

export function getSession(sessionFile: string): SessionRow | undefined {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM sessions WHERE session_file = ?").get(sessionFile) as SessionRow | undefined) ??
    undefined
  );
}

// ─── Records ────────────────────────────────────────────────────────

export interface RecordRow {
  id: string;
  kind: RecordKind;
  scope: RecordScope;
  project_id: string | null;
  session_id: string | null;
  session_file: string | null;
  branch_leaf_id: string | null;
  entry_id_start: string | null;
  entry_id_end: string | null;
  text: string;
  tags: string | null;
  status: RecordStatus;
  confidence: number;
  importance: number;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  derived_from_memory_refs: string | null;
}

export function upsertRecord(record: {
  kind: RecordKind;
  scope?: RecordScope;
  project_id?: string | null;
  session_id?: string | null;
  session_file?: string | null;
  branch_leaf_id?: string | null;
  entry_id_start?: string | null;
  entry_id_end?: string | null;
  text: string;
  tags?: string | null;
  status?: RecordStatus;
  confidence?: number;
  importance?: number;
  created_at?: number;
  updated_at?: number;
  superseded_by?: string | null;
  derived_from_memory_refs?: string | null;
}): string {
  const db = getDb();
  const now = Date.now();
  const createdAt = record.created_at ?? now;
  const updatedAt = record.updated_at ?? now;
  const scope = record.scope ?? "project";
  const projectId = scope === "global" ? null : (record.project_id ?? null);
  if (scope === "project" && !projectId) {
    throw new Error("Project-scoped memory records require a project_id");
  }
  const redactedText = redactSecrets(record.text);
  const redactedTags = record.tags ? redactSecrets(record.tags) : null;
  const id = recordIdentityHash(redactedText, record.kind, scope, projectId);
  const existing = prepareStmt("SELECT id, status FROM records WHERE id = ?").get(id) as
    | { id: string; status: RecordStatus }
    | undefined;

  if (existing) {
    db.prepare(`
      UPDATE records SET
        scope = ?, project_id = ?, session_id = ?, session_file = ?,
        branch_leaf_id = ?, entry_id_start = ?, entry_id_end = ?,
        text = ?, tags = ?, confidence = ?, importance = ?,
        updated_at = ?, status = ?, superseded_by = ?, derived_from_memory_refs = ?
      WHERE id = ?
    `).run(
      scope,
      projectId,
      record.session_id ?? null,
      record.session_file ?? null,
      record.branch_leaf_id ?? null,
      record.entry_id_start ?? null,
      record.entry_id_end ?? null,
      redactedText,
      redactedTags,
      record.confidence ?? 1.0,
      record.importance ?? 0.5,
      updatedAt,
      record.status ?? existing.status,
      record.superseded_by ?? null,
      record.derived_from_memory_refs ?? null,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO records (id, kind, scope, project_id, session_id, session_file,
        branch_leaf_id, entry_id_start, entry_id_end, text, tags, status,
        confidence, importance, created_at, updated_at, superseded_by, derived_from_memory_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.kind,
      scope,
      projectId,
      record.session_id ?? null,
      record.session_file ?? null,
      record.branch_leaf_id ?? null,
      record.entry_id_start ?? null,
      record.entry_id_end ?? null,
      redactedText,
      redactedTags,
      record.status ?? "active",
      record.confidence ?? 1.0,
      record.importance ?? 0.5,
      createdAt,
      updatedAt,
      record.superseded_by ?? null,
      record.derived_from_memory_refs ?? null,
    );
  }

  // Rebuild FTS: delete then re-insert
  prepareStmt("DELETE FROM record_fts WHERE rowid = (SELECT rowid FROM records WHERE id = ?)").run(id);
  const row = prepareStmt("SELECT rowid FROM records WHERE id = ?").get(id) as { rowid: number };
  if (row) {
    prepareStmt("INSERT INTO record_fts(rowid, text, tags) VALUES (?, ?, ?)").run(
      row.rowid,
      redactedText,
      redactedTags ?? "",
    );
  }

  return id;
}

export function getRecord(id: string): RecordRow | undefined {
  return (
    (prepareStmt("SELECT * FROM records WHERE id = ?").get(id) as RecordRow | undefined) ?? undefined
  );
}

export function listRecords(options: { includeInactive?: boolean } = {}): RecordRow[] {
  const sql = options.includeInactive
    ? "SELECT * FROM records ORDER BY created_at ASC, id ASC"
    : "SELECT * FROM records WHERE status = 'active' ORDER BY created_at ASC, id ASC";
  return prepareStmt(sql).all() as unknown as RecordRow[];
}

// ─── FTS query builder ─────────────────────────────────────────────

/**
 * Build an FTS5 MATCH query from raw user text.
 * Default semantics: AND (all terms must match), with stop-word filtering.
 * Quoted phrases ("exact phrase") are preserved as phrase matches.
 * Set matchAny=true for OR semantics.
 */
export function buildFtsQuery(rawQuery: string, matchAny = false): string {
  const parts: string[] = [];

  // Extract quoted phrases from original query (exact phrase matching)
  const phraseRegex = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = phraseRegex.exec(rawQuery)) !== null) {
    const phrase = m[1].replace(/[^a-zA-Z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim();
    if (phrase) parts.push(`"${phrase}"`);
  }

  // Remove quoted phrases, then extract remaining terms
  const withoutPhrases = rawQuery.replace(/"[^"]+"/g, " ");
  const rawTerms = withoutPhrases
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // In AND mode, filter out short/noise terms that harm recall.
  // Short words (1-2 chars) and common stop words spanning file names
  // rarely appear in stored memories. In OR mode, keep all terms.
  const terms = matchAny
    ? rawTerms
    : rawTerms.filter((t) => {
        // Keep terms ≥3 characters (filter out "a", "an", "is", "ts", etc.)
        if (t.length < 3) return false;
        // Filter common command/action words unlikely to appear in stored memories
        const lower = t.toLowerCase();
        if (STOP_WORDS.has(lower)) return false;
        return true;
      });

  for (const t of terms) parts.push(`"${t}"`);

  if (parts.length === 0) return "";

  const joiner = matchAny ? " OR " : " AND ";
  return parts.join(joiner);
}

/**
 * Common English stop words and action/command words that rarely appear
 * in stored memory records. Filtered out in AND mode to avoid overly
 * restrictive queries.
 */
const STOP_WORDS = new Set([
  // Common English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'she', 'new', 'its',
  'did', 'get', 'got', 'let', 'put', 'run', 'set', 'way', 'who', 'why',
  'how', 'any', 'few', 'own', 'see', 'too', 'yes', 'yet', 'ago', 'big',
  'use', 'may', 'try', 'old', 'end', 'top', 'low', 'off', 'nor',
  // Command / action words (rare in stored memories)
  'fix', 'add', 'make', 'help', 'need', 'want', 'like', 'tell', 'show',
  'find', 'look', 'take', 'keep', 'give', 'send', 'read', 'call', 'move',
  'open', 'turn', 'pick', 'pull', 'push', 'drop', 'save', 'load', 'stop',
  'test', 'check', 'edit', 'copy', 'sort', 'fill', 'join', 'send', 'exit',
  'back', 'next', 'last', 'just', 'also', 'then', 'than', 'very', 'much',
  'here', 'into', 'each', 'some', 'most', 'done', 'good', 'only', 'well',
  'even', 'must', 'both', 'many', 'more', 'over', 'will', 'what', 'when',
  'have', 'been', 'that', 'this', 'with', 'they', 'from', 'your', 'them',
  'about', 'which', 'would', 'these', 'their', 'there', 'could', 'shall',
]);

export function searchRecordsFts(
  query: string,
  limit = 20,
  kindFilter?: RecordKind[],
  scopeFilter?: RecordScope[],
  projectId?: string,
  excludeStatuses?: RecordStatus[],
  matchAny = false,
): (RecordRow & { rank: number })[] {
  const terms = buildFtsQuery(query, matchAny);
  if (!terms) return [];

  const safeLimit = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 20));
  const hasProjectFilter = projectId !== undefined;

  function runQuery(ftsQuery: string, rawLimit: number): (RecordRow & { rank: number })[] {
    return hasProjectFilter
      ? (prepareStmt(
          `SELECT r.*, fts.rank as rank
           FROM record_fts fts
           JOIN records r ON r.rowid = fts.rowid
           WHERE record_fts MATCH ?
             AND (r.scope = 'global' OR r.project_id = ?)
           ORDER BY rank
           LIMIT ?`
        ).all(ftsQuery, projectId, rawLimit) as unknown as (RecordRow & { rank: number })[])
      : (prepareStmt(
          `SELECT r.*, fts.rank as rank
           FROM record_fts fts
           JOIN records r ON r.rowid = fts.rowid
           WHERE record_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        ).all(ftsQuery, rawLimit) as unknown as (RecordRow & { rank: number })[]);
  }

  const results = runQuery(terms, safeLimit);

  // Apply remaining post-filters (kind, scope, excludeStatus)
  return results.filter((r) => {
    if (kindFilter && !kindFilter.includes(r.kind)) return false;
    if (scopeFilter && !scopeFilter.includes(r.scope)) return false;
    if (excludeStatuses && excludeStatuses.includes(r.status)) return false;
    return true;
  });
}

// ─── File Activity ──────────────────────────────────────────────────

export interface FileActivityRow {
  id: string;
  record_id: string | null;
  project_id: string | null;
  path: string;
  action: FileAction;
  entry_id: string | null;
  created_at: number | null;
}

export function insertFileActivity(activity: {
  record_id?: string | null;
  project_id?: string | null;
  path: string;
  action: FileAction;
  entry_id?: string | null;
  created_at?: number | null;
}): void {
  const db = getDb();
  const id = newId();
  const now = activity.created_at ?? Date.now();
  db.prepare(`
    INSERT INTO file_activity (id, record_id, project_id, path, action, entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, activity.record_id ?? null, activity.project_id ?? null, activity.path, activity.action, activity.entry_id ?? null, now);
}

export function getFileActivityByRecord(recordId: string): FileActivityRow[] {
  return prepareStmt("SELECT * FROM file_activity WHERE record_id = ?")
    .all(recordId) as unknown as FileActivityRow[];
}

/**
 * Get recently active file paths for a project.
 * Filters to entries created within the last `sinceMinutes` minutes and
 * returns up to `limit` unique paths ordered by recency.
 */
export function getRecentFilePaths(projectId: string | null, limit = 5, sinceMinutes = 60): string[] {
  if (!projectId) return [];
  const sinceMs = Date.now() - Math.max(0, sinceMinutes) * 60 * 1000;
  const rows = prepareStmt(
    `SELECT path FROM file_activity
     WHERE project_id = ? AND created_at > ?
     GROUP BY path
     ORDER BY MAX(created_at) DESC
     LIMIT ?`
  ).all(projectId, sinceMs, limit) as { path: string }[];
  return rows.map((r) => r.path);
}

// ─── Index State ────────────────────────────────────────────────────

export interface IndexStateRow {
  session_file: string;
  session_id: string | null;
  last_indexed_entry_id: string | null;
  last_indexed_entry_timestamp: string | null;
  file_mtime: number | null;
  file_size: number | null;
  branch_leaf_id: string | null;
  schema_version: number;
}

export function getIndexState(sessionFile: string): IndexStateRow | undefined {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM index_state WHERE session_file = ?").get(sessionFile) as
      | IndexStateRow
      | undefined) ?? undefined
  );
}

export function upsertIndexState(state: {
  session_file: string;
  session_id?: string | null;
  last_indexed_entry_id?: string | null;
  last_indexed_entry_timestamp?: string | null;
  file_mtime?: number | null;
  file_size?: number | null;
  branch_leaf_id?: string | null;
}): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT session_file FROM index_state WHERE session_file = ?")
    .get(state.session_file);

  if (existing) {
    db.prepare(`
      UPDATE index_state SET
        session_id = ?, last_indexed_entry_id = ?, last_indexed_entry_timestamp = ?,
        file_mtime = ?, file_size = ?, branch_leaf_id = ?, schema_version = ?
      WHERE session_file = ?
    `).run(
      state.session_id ?? null,
      state.last_indexed_entry_id ?? null,
      state.last_indexed_entry_timestamp ?? null,
      state.file_mtime ?? null,
      state.file_size ?? null,
      state.branch_leaf_id ?? null,
      SCHEMA_VERSION,
      state.session_file,
    );
  } else {
    db.prepare(`
      INSERT INTO index_state (session_file, session_id, last_indexed_entry_id, last_indexed_entry_timestamp, file_mtime, file_size, branch_leaf_id, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.session_file,
      state.session_id ?? null,
      state.last_indexed_entry_id ?? null,
      state.last_indexed_entry_timestamp ?? null,
      state.file_mtime ?? null,
      state.file_size ?? null,
      state.branch_leaf_id ?? null,
      SCHEMA_VERSION,
    );
  }
}

// ─── Injections ─────────────────────────────────────────────────────

export interface InjectionRow {
  id: string;
  session_id: string | null;
  turn_entry_id: string | null;
  prompt_hash: string | null;
  injected_refs: string | null;
  packet: string | null;
  reasons: string | null;
  created_at: number;
}

export function insertInjection(injection: {
  session_id?: string | null;
  turn_entry_id?: string | null;
  prompt_hash?: string | null;
  injected_refs?: string | null;
  packet?: string | null;
  reasons?: string | null;
}): string {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO injections (id, session_id, turn_entry_id, prompt_hash, injected_refs, packet, reasons, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    injection.session_id ?? null,
    injection.turn_entry_id ?? null,
    injection.prompt_hash ?? null,
    injection.injected_refs ?? null,
    injection.packet ?? null,
    injection.reasons ?? null,
    now,
  );
  return id;
}

export function getLastInjection(sessionId: string): InjectionRow | undefined {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM injections WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as InjectionRow | undefined) ?? undefined
  );
}

export function getInjectionsBySession(sessionId: string, limit = 10): InjectionRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM injections WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(sessionId, limit) as unknown as InjectionRow[];
}

// ─── Jobs ───────────────────────────────────────────────────────────

export interface JobRow {
  id: string;
  type: string;
  payload: string | null;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function createJob(type: string, payload?: unknown): string {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO jobs (id, type, payload, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, type, payload ? JSON.stringify(payload) : null, now, now);
  return id;
}

export function getPendingJobs(type?: string, limit = 10): JobRow[] {
  const db = getDb();
  if (type) {
    return db
      .prepare("SELECT * FROM jobs WHERE status = 'pending' AND type = ? ORDER BY created_at LIMIT ?")
      .all(type, limit) as unknown as JobRow[];
  }
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT ?")
    .all(limit) as unknown as JobRow[];
}

export function updateJobStatus(id: string, status: JobStatus, error?: string): void {
  const db = getDb();
  const now = Date.now();
  if (error) {
    db.prepare(`
      UPDATE jobs SET status = ?, last_error = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(status, error, now, id);
  } else {
    db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }
}

// ─── Stats ──────────────────────────────────────────────────────────

export function getStats(): {
  totalRecords: number;
  totalSessions: number;
  totalFileActivity: number;
  recordsByKind: Record<string, number>;
} {
  const db = getDb();
  const totalRecords = (prepareStmt("SELECT COUNT(*) as c FROM records WHERE status = 'active'").get() as { c: number }).c;
  const totalSessions = (prepareStmt("SELECT COUNT(*) as c FROM sessions WHERE source_status = 'active'").get() as { c: number }).c;
  const totalFileActivity = (prepareStmt("SELECT COUNT(*) as c FROM file_activity").get() as { c: number }).c;
  const kindRows = prepareStmt("SELECT kind, COUNT(*) as c FROM records WHERE status = 'active' GROUP BY kind").all() as { kind: string; c: number }[];
  const recordsByKind: Record<string, number> = {};
  for (const r of kindRows) {
    recordsByKind[r.kind] = r.c;
  }
  return { totalRecords, totalSessions, totalFileActivity, recordsByKind };
}

export function getPendingJobCount(type?: string): number {
  const db = getDb();
  if (type) {
    return (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending' AND type = ?").get(type) as { c: number }).c;
  }
  return (db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'").get() as { c: number }).c;
}

export function getLastIndexedState(): { session_file: string; last_indexed_entry_id: string | null } | undefined {
  const row = prepareStmt(
    "SELECT session_file, last_indexed_entry_id FROM index_state ORDER BY rowid DESC LIMIT 1"
  ).get() as { session_file: string; last_indexed_entry_id: string | null } | undefined;
  return row ?? undefined;
}

export function getAppliedSchemaVersion(): number {
  try {
    const row = prepareStmt("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

export function getJournalMode(): string {
  try {
    const row = getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
    return row?.journal_mode ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function getFtsHealth(): { rowCount: number; integrity: string } {
  const db = getDb();
  let integrity = "ok";
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (row && row.integrity_check !== "ok") {
      integrity = row.integrity_check;
    }
  } catch {
    integrity = "check_failed";
  }
  const rowCount = (db.prepare("SELECT COUNT(*) as c FROM record_fts").get() as { c: number }).c;
  return { rowCount, integrity };
}

// ─── Forgetting ─────────────────────────────────────────────────────

export function softForgetRecord(id: string): boolean {
  const result = prepareStmt("UPDATE records SET status = 'soft_forgotten', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
  return result.changes > 0;
}

export function hardDeleteRecord(id: string): boolean {
  const row = prepareStmt("SELECT rowid FROM records WHERE id = ?").get(id) as { rowid: number } | undefined;
  if (row) {
    prepareStmt("DELETE FROM record_fts WHERE rowid = ?").run(row.rowid);
  }
  prepareStmt("DELETE FROM file_activity WHERE record_id = ?").run(id);
  prepareStmt("DELETE FROM injections WHERE ',' || COALESCE(injected_refs, '') || ',' LIKE ?").run(`%,${id},%`);
  const result = prepareStmt("DELETE FROM records WHERE id = ?").run(id);
  return result.changes > 0;
}
