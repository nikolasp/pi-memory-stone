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
