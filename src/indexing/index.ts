/**
 * Indexing engine: processes session entries on agent_end and stores structured records.
 * Deterministic-only for MVP; LLM extraction deferred.
 */

import { statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  upsertSession,
  upsertRecord,
  insertFileActivity,
  getIndexState,
  upsertIndexState,
  contentHash,
} from "../db/index.js";
import { parseEntries, turnsToRecords, type ParsedFileActivity } from "./parser.js";
import { getProjectId } from "../config/index.js";

// ─── Types for agent_end data ───────────────────────────────────────

type AgentEndEvent = unknown;

interface TimestampedEntry {
  timestamp?: string | number;
  [key: string]: any;
}

/**
 * Parse entry timestamp, handling both numeric (ms), numeric strings,
 * and ISO string formats.
 * Returns NaN if timestamp is invalid or missing.
 */
function entryTimeMs(entry: TimestampedEntry): number {
  if (entry.timestamp == null) return NaN;
  if (typeof entry.timestamp === "number") {
    return Number.isFinite(entry.timestamp) ? entry.timestamp : NaN;
  }
  if (typeof entry.timestamp === "string") {
    // Handle numeric strings (e.g., "1700000000000" or "1700000000000.0"
    // from SQLite TEXT affinity when a number was stored)
    const numeric = Number(entry.timestamp);
    if (Number.isFinite(numeric) && numeric > 86400000) return numeric;
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/**
 * Normalize a timestamp for storage as an ISO string.
 * Handles numeric ms, ISO strings, and null/undefined.
 */
function normalizeTimestampForStorage(ts: string | number | null | undefined): string {
  if (ts == null) return new Date().toISOString();
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return new Date(ts).toISOString();
  }
  if (typeof ts === "string") {
    const numeric = Number(ts);
    if (Number.isFinite(numeric) && numeric > 86400000) {
      return new Date(numeric).toISOString();
    }
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

// ─── Index a session from agent_end ─────────────────────────────────

export async function indexSessionOnAgentEnd(
  ctx: ExtensionContext,
  _event: AgentEndEvent,
): Promise<{ recordsCreated: number; errors: string[] }> {
  const errors: string[] = [];
  let recordsCreated = 0;

  try {
    const sessionManager = ctx.sessionManager;
    const sessionFile = sessionManager.getSessionFile();

    // Non-persisted sessions: skip indexing (plan: do not index ephemeral)
    if (!sessionFile) {
      return { recordsCreated: 0, errors: [] };
    }

    const sessionId = sessionManager.getSessionId();
    const projectId = getProjectId(ctx.cwd);
    const cwd = ctx.cwd;
    const branch = sessionManager.getBranch() as unknown as Parameters<typeof parseEntries>[0];
    const leafId = sessionManager.getLeafId();

    // Get file info
    let fileMtime: number | null = null;
    let fileSize: number | null = null;
    try {
      const stat = statSync(sessionFile);
      fileMtime = stat.mtimeMs;
      fileSize = stat.size;
    } catch {
      // File may not exist (in-memory session), that's fine
    }

    // Check index state
    const prevState = getIndexState(sessionFile);
    const lastIndexedId = prevState?.last_indexed_entry_id ?? null;

    // Find new entries since last index. Prefer timestamps so this stays correct
    // even if SessionManager branch ordering changes; fall back to root-to-leaf slicing.
    const lastIndexedTimestamp = prevState?.last_indexed_entry_timestamp
      ? entryTimeMs({ timestamp: prevState.last_indexed_entry_timestamp })
      : NaN;
    const lastIndexedIndex = lastIndexedId
      ? branch.findIndex((entry) => entry.id === lastIndexedId)
      : -1;
    let newEntries = branch;
    if (lastIndexedId) {
      if (Number.isFinite(lastIndexedTimestamp)) {
        const timestampEntries = branch.filter((entry) => {
          const ts = entryTimeMs(entry);
          return Number.isFinite(ts) && ts > lastIndexedTimestamp;
        });
        newEntries = timestampEntries.length > 0 || lastIndexedIndex < 0
          ? timestampEntries
          : branch.slice(lastIndexedIndex + 1);
      } else {
        newEntries = lastIndexedIndex >= 0 ? branch.slice(lastIndexedIndex + 1) : branch;
      }
    }

    if (newEntries.length === 0) {
      // Update session metadata even if no new entries
      upsertSession({
        id: sessionId,
        session_file: sessionFile,
        cwd,
        project_id: projectId,
        file_mtime: fileMtime,
        file_size: fileSize,
      });
      upsertIndexState({
        session_file: sessionFile,
        session_id: sessionId,
        last_indexed_entry_id: prevState?.last_indexed_entry_id ?? undefined,
        last_indexed_entry_timestamp: new Date().toISOString(),
        file_mtime: fileMtime,
        file_size: fileSize,
        branch_leaf_id: leafId ?? undefined,
      });
      return { recordsCreated: 0, errors: [] };
    }

    // Parse new entries
    const { turns, fileActivities } = parseEntries(newEntries);

    // Convert to records
    const recordPayloads = turnsToRecords(turns, projectId, sessionId, sessionFile);

    // Upsert session
    upsertSession({
      id: sessionId,
      session_file: sessionFile,
      cwd,
      project_id: projectId,
      file_mtime: fileMtime,
      file_size: fileSize,
    });

    // Store records
    for (const payload of recordPayloads) {
      try {
        upsertRecord({
          kind: payload.kind,
          scope: payload.scope,
          project_id: projectId,
          session_id: sessionId,
          session_file: sessionFile,
          branch_leaf_id: leafId ?? undefined,
          entry_id_start: payload.entryIdStart,
          entry_id_end: payload.entryIdEnd,
          text: payload.text,
          tags: payload.tags,
        });
        recordsCreated++;
      } catch (err) {
        errors.push(`Failed to store record: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Store file activity
    for (const fa of fileActivities) {
      try {
        insertFileActivity({
          record_id: contentHash(
            `file:${fa.path}:${fa.action}`,
            "file_activity",
          ),
          project_id: projectId,
          path: fa.path,
          action: fa.action,
          entry_id: fa.entryId,
        });
      } catch (err) {
        // Non-critical: file activity insertion failure is logged but not fatal
        errors.push(`Failed to store file activity: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update index state
    const lastEntry = newEntries.reduce((latest, entry) => {
      const latestTs = latest ? entryTimeMs(latest) : NaN;
      const entryTs = entryTimeMs(entry);
      if (!Number.isFinite(latestTs) && !Number.isFinite(entryTs)) return entry;
      if (!Number.isFinite(latestTs)) return entry;
      if (!Number.isFinite(entryTs)) return latest;
      return entryTs > latestTs ? entry : latest;
    }, newEntries[0]);
    upsertIndexState({
      session_file: sessionFile,
      session_id: sessionId,
      last_indexed_entry_id: lastEntry?.id ?? prevState?.last_indexed_entry_id ?? undefined,
      last_indexed_entry_timestamp: normalizeTimestampForStorage(lastEntry?.timestamp),
      file_mtime: fileMtime,
      file_size: fileSize,
      branch_leaf_id: leafId ?? undefined,
    });

  } catch (err) {
    errors.push(`Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { recordsCreated, errors };
}

// ─── Backfill (for /memory-backfill command) ────────────────────────

export async function backfillSession(
  sessionFile: string,
  ctx: ExtensionContext,
): Promise<{ recordsCreated: number; errors: string[] }> {
  const errors: string[] = [];
  let recordsCreated = 0;

  try {
    // For backfill we need raw JSONL access. We use SessionManager.open for that.
    // But in the MVP, we process via agent_end. Backfill is deferred.
    // This is a placeholder for future implementation.
  } catch (err) {
    errors.push(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { recordsCreated, errors };
}
