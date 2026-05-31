/**
 * Portable export/import/backup helpers for memory records.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getDb, getDbPath, listRecords, upsertRecord, type RecordRow } from "../db/index.js";
import { SCHEMA_VERSION, RECORD_KINDS, RECORD_SCOPES, RECORD_STATUSES, type RecordKind, type RecordScope, type RecordStatus } from "../db/schema.js";

export type ExportFormat = "json" | "md";

export interface PortableMemoryRecord {
  id: string;
  kind: RecordKind;
  scope: RecordScope;
  project_id: string | null;
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

export interface PortableMemoryExport {
  format: "pi-memory-stone-export";
  version: 1;
  exported_at: string;
  schema_version: number;
  records: PortableMemoryRecord[];
}

export interface ImportOptions {
  /** Remap project-scoped records to this project id. Use undefined to preserve exported project ids. */
  projectId?: string | null;
  /** Force every imported record into a scope. */
  scopeOverride?: RecordScope;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  ids: string[];
}

export function buildMemoryExport(includeInactive = false): PortableMemoryExport {
  return {
    format: "pi-memory-stone-export",
    version: 1,
    exported_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    records: listRecords({ includeInactive }).map(toPortableRecord),
  };
}

export function exportMemory(format: ExportFormat, includeInactive = false): string {
  const payload = buildMemoryExport(includeInactive);
  if (format === "json") {
    return JSON.stringify(payload, null, 2) + "\n";
  }

  return exportMarkdown(payload);
}

export function writeMemoryExport(path: string, format: ExportFormat, includeInactive = false): number {
  const payload = buildMemoryExport(includeInactive);
  const content = format === "json" ? JSON.stringify(payload, null, 2) + "\n" : exportMarkdown(payload);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return payload.records.length;
}

export function importMemoryJsonFile(path: string, options: ImportOptions = {}): ImportResult {
  const raw = readFileSync(path, "utf8");
  return importMemoryJson(raw, options);
}

export function importMemoryJson(raw: string, options: ImportOptions = {}): ImportResult {
  const parsed = JSON.parse(raw) as Partial<PortableMemoryExport>;
  if (parsed.format !== "pi-memory-stone-export" || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error("Unsupported memory export file. Expected pi-memory-stone-export version 1 JSON.");
  }

  const result: ImportResult = { imported: 0, skipped: 0, ids: [] };
  for (const candidate of parsed.records) {
    const record = normalizePortableRecord(candidate);
    if (!record) {
      result.skipped += 1;
      continue;
    }

    const scope = options.scopeOverride ?? record.scope;
    const projectId = scope === "global" ? null : (options.projectId !== undefined ? options.projectId : record.project_id);
    const id = upsertRecord({
      kind: record.kind,
      scope,
      project_id: projectId,
      text: record.text,
      tags: record.tags,
      status: record.status,
      confidence: record.confidence,
      importance: record.importance,
      created_at: record.created_at,
      updated_at: record.updated_at,
      superseded_by: record.superseded_by,
      derived_from_memory_refs: record.derived_from_memory_refs,
    });

    result.imported += 1;
    result.ids.push(id);
  }

  return result;
}

export function backupMemoryDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(getDbPath(), path);
}

export function defaultPortablePath(cwd: string, prefix: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(cwd, `${prefix}-${stamp}.${extension}`);
}

export function resolvePortablePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function toPortableRecord(row: RecordRow): PortableMemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    project_id: row.project_id,
    text: row.text,
    tags: row.tags,
    status: row.status,
    confidence: row.confidence,
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    superseded_by: row.superseded_by,
    derived_from_memory_refs: row.derived_from_memory_refs,
  };
}

function exportMarkdown(payload: PortableMemoryExport): string {
  const lines: string[] = [];
  lines.push("# Memory Stone Export");
  lines.push("");
  lines.push(`Exported: ${payload.exported_at}`);
  lines.push(`Records: ${payload.records.length}`);
  lines.push("");

  for (const record of payload.records) {
    lines.push(`## [${record.kind}] ${record.id}`);
    lines.push("");
    lines.push(`- Scope: ${record.scope}`);
    lines.push(`- Project: ${record.project_id ?? "global"}`);
    lines.push(`- Status: ${record.status}`);
    lines.push(`- Importance: ${record.importance}`);
    lines.push(`- Created: ${new Date(record.created_at).toISOString()}`);
    if (record.tags) lines.push(`- Tags: ${record.tags}`);
    lines.push("");
    lines.push(record.text);
    lines.push("");
  }

  return lines.join("\n");
}

function normalizePortableRecord(candidate: unknown): PortableMemoryRecord | null {
  if (!candidate || typeof candidate !== "object") return null;
  const r = candidate as Record<string, unknown>;
  if (typeof r.text !== "string" || r.text.trim() === "") return null;
  if (!isStringMember(r.kind, RECORD_KINDS)) return null;
  if (!isStringMember(r.scope, RECORD_SCOPES)) return null;
  if (!isStringMember(r.status, RECORD_STATUSES)) return null;

  return {
    id: typeof r.id === "string" ? r.id : "",
    kind: r.kind,
    scope: r.scope,
    project_id: typeof r.project_id === "string" ? r.project_id : null,
    text: r.text,
    tags: typeof r.tags === "string" ? r.tags : null,
    status: r.status,
    confidence: typeof r.confidence === "number" ? r.confidence : 1,
    importance: typeof r.importance === "number" ? r.importance : 0.5,
    created_at: typeof r.created_at === "number" ? r.created_at : Date.now(),
    updated_at: typeof r.updated_at === "number" ? r.updated_at : Date.now(),
    superseded_by: typeof r.superseded_by === "string" ? r.superseded_by : null,
    derived_from_memory_refs: typeof r.derived_from_memory_refs === "string" ? r.derived_from_memory_refs : null,
  };
}

function isStringMember<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
