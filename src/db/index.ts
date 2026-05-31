/**
 * Database module: connection management, migrations, CRUD helpers.
 * Uses node:sqlite (DatabaseSync) for synchronous SQLite operations.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
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

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dbDir = getDbDir();
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    _db = new DatabaseSync(getDbPath());
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
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
  const redactedText = redactSecrets(record.text);
  const redactedTags = record.tags ? redactSecrets(record.tags) : null;
  const id = recordIdentityHash(redactedText, record.kind, scope, projectId);
  const existing = db.prepare("SELECT id, status FROM records WHERE id = ?").get(id) as
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
  db.prepare("DELETE FROM record_fts WHERE rowid = (SELECT rowid FROM records WHERE id = ?)").run(id);
  const row = db.prepare("SELECT rowid FROM records WHERE id = ?").get(id) as { rowid: number };
  if (row) {
    db.prepare("INSERT INTO record_fts(rowid, text, tags) VALUES (?, ?, ?)").run(
      row.rowid,
      redactedText,
      redactedTags ?? "",
    );
  }

  return id;
}

export function getRecord(id: string): RecordRow | undefined {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM records WHERE id = ?").get(id) as RecordRow | undefined) ?? undefined
  );
}

export function listRecords(options: { includeInactive?: boolean } = {}): RecordRow[] {
  const db = getDb();
  const sql = options.includeInactive
    ? "SELECT * FROM records ORDER BY created_at ASC, id ASC"
    : "SELECT * FROM records WHERE status = 'active' ORDER BY created_at ASC, id ASC";
  return db.prepare(sql).all() as unknown as RecordRow[];
}

export function searchRecordsFts(
  query: string,
  limit = 20,
  kindFilter?: RecordKind[],
  scopeFilter?: RecordScope[],
  projectId?: string,
  excludeStatuses?: RecordStatus[],
): (RecordRow & { rank: number })[] {
  const db = getDb();

  // Sanitize FTS query: escape special chars, split into terms
  const terms = query
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ");

  if (!terms) return [];

  const results = db
    .prepare(
      `SELECT r.*, fts.rank as rank
       FROM record_fts fts
       JOIN records r ON r.rowid = fts.rowid
       WHERE record_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(terms, limit) as unknown as (RecordRow & { rank: number })[];

  // Apply post-filters
  return results.filter((r) => {
    if (kindFilter && !kindFilter.includes(r.kind)) return false;
    if (scopeFilter && !scopeFilter.includes(r.scope)) return false;
    if (projectId !== undefined && r.project_id !== projectId) return false;
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
}

export function insertFileActivity(activity: {
  record_id?: string | null;
  project_id?: string | null;
  path: string;
  action: FileAction;
  entry_id?: string | null;
}): void {
  const db = getDb();
  const id = newId();
  db.prepare(`
    INSERT INTO file_activity (id, record_id, project_id, path, action, entry_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, activity.record_id ?? null, activity.project_id ?? null, activity.path, activity.action, activity.entry_id ?? null);
}

export function getFileActivityByRecord(recordId: string): FileActivityRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM file_activity WHERE record_id = ?")
    .all(recordId) as unknown as FileActivityRow[];
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
  const totalRecords = (db.prepare("SELECT COUNT(*) as c FROM records WHERE status = 'active'").get() as { c: number }).c;
  const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE source_status = 'active'").get() as { c: number }).c;
  const totalFileActivity = (db.prepare("SELECT COUNT(*) as c FROM file_activity").get() as { c: number }).c;
  const kindRows = db.prepare("SELECT kind, COUNT(*) as c FROM records WHERE status = 'active' GROUP BY kind").all() as { kind: string; c: number }[];
  const recordsByKind: Record<string, number> = {};
  for (const r of kindRows) {
    recordsByKind[r.kind] = r.c;
  }
  return { totalRecords, totalSessions, totalFileActivity, recordsByKind };
}

// ─── Forgetting ─────────────────────────────────────────────────────

export function softForgetRecord(id: string): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE records SET status = 'soft_forgotten', updated_at = ? WHERE id = ?").run(Date.now(), id);
  return result.changes > 0;
}

export function hardDeleteRecord(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT rowid FROM records WHERE id = ?").get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare("DELETE FROM record_fts WHERE rowid = ?").run(row.rowid);
  }
  db.prepare("DELETE FROM file_activity WHERE record_id = ?").run(id);
  db.prepare("DELETE FROM injections WHERE ',' || COALESCE(injected_refs, '') || ',' LIKE ?").run(`%,${id},%`);
  const result = db.prepare("DELETE FROM records WHERE id = ?").run(id);
  return result.changes > 0;
}
