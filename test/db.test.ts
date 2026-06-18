/**
 * Tests for the database module.
 * Run with: NODE_OPTIONS="--experimental-sqlite" tsx --test test/db.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  closeDb,
  upsertRecord,
  getDbPath,
  searchRecordsFts,
  insertFileActivity,
  getRecentFilePaths,
} from "../src/db/index.js";
import type { RecordKind, RecordScope } from "../src/db/schema.js";

// ─── DB cleanup ─────────────────────────────────────────────────────

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-db-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  const files = [dbPath, dbPath + "-wal", dbPath + "-shm"];
  for (const f of files) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function seedRecord(
  text: string,
  opts: {
    kind?: RecordKind;
    scope?: RecordScope;
    projectId?: string;
    tags?: string;
  } = {},
) {
  const now = Date.now();
  return upsertRecord({
    kind: opts.kind ?? "decision",
    scope: opts.scope ?? "project",
    project_id: opts.projectId ?? "/home/test-project",
    text,
    tags: opts.tags ?? null,
    created_at: now,
    updated_at: now,
  });
}

describe("searchRecordsFts", () => {
  before(() => {
    cleanDb();
    getDb();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("defaults to AND semantics and does not fall back to OR", () => {
    seedRecord("alpha only content here", { kind: "decision" });
    seedRecord("beta only content here", { kind: "preference" });
    seedRecord("alpha beta combined content here", { kind: "task" });

    const results = searchRecordsFts("alpha beta", 10, undefined, undefined, "/home/test-project");
    const texts = results.map((r) => r.text);

    assert.equal(results.length, 1, "AND query should only match record containing both terms");
    assert.ok(texts[0].includes("alpha beta"));
  });

  it("supports explicit OR semantics via matchAny", () => {
    const results = searchRecordsFts("alpha beta", 10, undefined, undefined, "/home/test-project", undefined, true);
    const texts = results.map((r) => r.text);

    assert.ok(texts.some((t) => t.includes("alpha only")));
    assert.ok(texts.some((t) => t.includes("beta only")));
    assert.ok(texts.some((t) => t.includes("alpha beta")));
  });
});

describe("getRecentFilePaths", () => {
  before(() => {
    cleanDb();
    getDb();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("respects the sinceMinutes recency window", () => {
    const projectId = "/home/recent-test";
    const now = Date.now();

    insertFileActivity({
      project_id: projectId,
      path: "old/file.ts",
      action: "read",
      created_at: now - 120 * 60 * 1000, // 2 hours ago
    });
    insertFileActivity({
      project_id: projectId,
      path: "new/file.ts",
      action: "write",
      created_at: now - 5 * 60 * 1000, // 5 minutes ago
    });

    const recent = getRecentFilePaths(projectId, 5, 60);
    assert.deepEqual(recent, ["new/file.ts"]);
  });

  it("orders duplicate paths by their latest activity", () => {
    const projectId = "/home/recent-duplicates";
    const now = Date.now();

    insertFileActivity({
      project_id: projectId,
      path: "src/reused.ts",
      action: "read",
      created_at: now - 50 * 60 * 1000,
    });
    insertFileActivity({
      project_id: projectId,
      path: "src/other.ts",
      action: "read",
      created_at: now - 5 * 60 * 1000,
    });
    insertFileActivity({
      project_id: projectId,
      path: "src/reused.ts",
      action: "write",
      created_at: now - 60 * 1000,
    });

    const recent = getRecentFilePaths(projectId, 5, 60);
    assert.deepEqual(recent, ["src/reused.ts", "src/other.ts"]);
  });
});
