/**
 * Tests for registered MCP tools.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools/index.js";
import { closeDb, getDbPath, getRecord, upsertRecord } from "../src/db/index.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-tools-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function registeredTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  registerTools({ registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  return tools;
}

describe("memory_forget tool", () => {
  beforeEach(() => cleanDb());

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("does not alter or leak records outside the current project", async () => {
    const currentProject = join(testMemoryDir, "current");
    const otherProject = join(testMemoryDir, "other");
    mkdirSync(currentProject, { recursive: true });
    mkdirSync(otherProject, { recursive: true });

    const id = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: otherProject,
      text: "Other project private memory api_key = abcdef0123456789XYZ",
    });

    const tools = registeredTools();
    const result = await tools.memory_forget.execute("tool-call", { ref: id, hard: true }, undefined, undefined, {
      cwd: currentProject,
    });

    assert.match(result.content[0].text, /not available/);
    assert.doesNotMatch(result.content[0].text, /Other project private memory/);
    assert.equal(getRecord(id)?.status, "active");
  });

  it("soft-forgets visible records", async () => {
    const currentProject = join(testMemoryDir, "current");
    mkdirSync(currentProject, { recursive: true });

    const id = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: currentProject,
      text: "Forget this visible memory.",
    });

    const tools = registeredTools();
    const result = await tools.memory_forget.execute("tool-call", { ref: id }, undefined, undefined, {
      cwd: currentProject,
    });

    assert.match(result.content[0].text, /soft-forgotten/);
    assert.equal(getRecord(id)?.status, "soft_forgotten");
  });
});
