/**
 * Tests for portable export/import/backup helpers.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupMemoryDatabase, exportMemory, importMemoryJson } from "../src/portable/index.js";
import { closeDb, getDbPath, listRecords, softForgetRecord, upsertRecord } from "../src/db/index.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-portable-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

describe("portable memory helpers", () => {
  beforeEach(() => cleanDb());

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("exports active records as JSON and Markdown", () => {
    const activeId = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/repo-a",
      text: "Keep export/import simple before full sync.",
      tags: "portable,backup",
      importance: 0.8,
    });
    const inactiveId = upsertRecord({
      kind: "task",
      scope: "project",
      project_id: "/repo-a",
      text: "Old inactive task.",
    });
    softForgetRecord(inactiveId);

    const json = JSON.parse(exportMemory("json")) as { records: Array<{ id: string; text: string }> };
    assert.equal(json.records.length, 1);
    assert.equal(json.records[0].id, activeId);

    const allJson = JSON.parse(exportMemory("json", true)) as { records: unknown[] };
    assert.equal(allJson.records.length, 2);

    const markdown = exportMemory("md");
    assert.match(markdown, /# Memory Stone Export/);
    assert.match(markdown, /Keep export\/import simple before full sync\./);
  });

  it("imports JSON exports and remaps project-scoped records", () => {
    const createdAt = Date.UTC(2024, 0, 1);
    upsertRecord({
      kind: "preference",
      scope: "project",
      project_id: "/old-machine/repo",
      text: "Prefer portable JSON memory exports.",
      importance: 0.7,
      created_at: createdAt,
      updated_at: createdAt,
    });
    const exported = exportMemory("json");

    cleanDb();
    const result = importMemoryJson(exported, { projectId: "/new-machine/repo" });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);

    const records = listRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].project_id, "/new-machine/repo");
    assert.equal(records[0].created_at, createdAt);
    assert.equal(records[0].text, "Prefer portable JSON memory exports.");
  });

  it("creates a SQLite backup file", () => {
    upsertRecord({
      kind: "decision",
      scope: "global",
      text: "Back up before hard deletion.",
    });

    const backupPath = join(testMemoryDir, "backup.db");
    backupMemoryDatabase(backupPath);
    assert.equal(existsSync(backupPath), true);
  });
});
