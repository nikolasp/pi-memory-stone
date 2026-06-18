/**
 * Tests for incremental session indexing.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSessionOnAgentEnd } from "../src/indexing/index.js";
import { closeDb, getDb, getDbPath } from "../src/db/index.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-indexing-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function makeUserEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "user",
      content: text,
      timestamp: Date.now(),
    },
  };
}

function makeAssistantEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function makeAssistantToolCallEntry(id: string, text: string, toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...toolCalls.map((tc) => ({ type: "toolCall", ...tc })),
      ],
      timestamp: Date.now(),
    },
  };
}

function installStrictFileActivitySchema() {
  const db = getDb();
  db.exec(`
    DROP TABLE file_activity;
    CREATE TABLE file_activity (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      project_id TEXT,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      entry_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (record_id) REFERENCES records(id)
    );
    CREATE INDEX idx_file_activity_record ON file_activity(record_id);
    CREATE INDEX idx_file_activity_path ON file_activity(path);
    CREATE INDEX idx_file_activity_project ON file_activity(project_id);
    CREATE INDEX idx_file_activity_created_at ON file_activity(created_at);
  `);
}

function makeContext(sessionFile: string, branch: unknown[]) {
  return {
    cwd: testMemoryDir,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "session-1",
      getBranch: () => branch,
      getLeafId: () => (branch.at(-1) as { id?: string } | undefined)?.id,
    },
  } as any;
}

describe("indexSessionOnAgentEnd", () => {
  beforeEach(() => cleanDb());

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("stores file activity with the parent record id when record_id has a foreign key", async () => {
    installStrictFileActivitySchema();
    const sessionFile = join(testMemoryDir, "session.jsonl");
    writeFileSync(sessionFile, "");

    const branch = [
      makeUserEntry("001", "Read src/index.ts"),
      makeAssistantToolCallEntry("002", "I'll inspect the file.", [
        { id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
      ]),
    ];

    const result = await indexSessionOnAgentEnd(makeContext(sessionFile, branch), {});
    assert.deepEqual(result.errors, []);

    const rows = getDb()
      .prepare(`
        SELECT fa.path, fa.action, fa.record_id, r.id AS parent_id
        FROM file_activity fa
        JOIN records r ON r.id = fa.record_id
      `)
      .all() as Array<{ path: string; action: string; record_id: string; parent_id: string }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, "src/index.ts");
    assert.equal(rows[0].action, "read");
    assert.equal(rows[0].record_id, rows[0].parent_id);
  });

  it("indexes only entries after the last indexed entry when timestamps are absent", async () => {
    const sessionFile = join(testMemoryDir, "session.jsonl");
    writeFileSync(sessionFile, "");

    const firstBranch = [
      makeUserEntry("001", "First question"),
      makeAssistantEntry("002", "First answer"),
    ];
    const first = await indexSessionOnAgentEnd(makeContext(sessionFile, firstBranch), {});
    assert.equal(first.errors.length, 0);

    const fullBranch = [
      ...firstBranch,
      makeUserEntry("003", "Second question"),
      makeAssistantEntry("004", "Second answer"),
    ];
    const second = await indexSessionOnAgentEnd(makeContext(sessionFile, fullBranch), {});
    assert.equal(second.errors.length, 0);

    const rows = getDb()
      .prepare("SELECT text FROM records WHERE kind = 'turn_summary' ORDER BY created_at")
      .all() as Array<{ text: string }>;

    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.text.includes("First question")));
    assert.ok(rows.some((r) => r.text.includes("Second question")));
  });
});
