/**
 * Tests for optional Obsidian-compatible memory vault helpers.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbPath, upsertRecord } from "../src/db/index.js";
import { getVaultStatus, initVault, resolveVaultPath, syncVault } from "../src/vault/index.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-vault-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");
process.env.PI_MEMORY_STONE_PERSONAL_VAULT_PATH = join(testMemoryDir, "personal-vault");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function cleanVaults() {
  rmSync(join(testMemoryDir, "project"), { recursive: true, force: true });
  rmSync(join(testMemoryDir, "personal-vault"), { recursive: true, force: true });
}

describe("memory vault helpers", () => {
  beforeEach(() => {
    cleanDb();
    cleanVaults();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("resolves project and personal vault paths", () => {
    const project = join(testMemoryDir, "project");
    assert.equal(resolveVaultPath("project", project, "/other/cwd"), join(project, ".memory-stone", "vault"));
    assert.equal(resolveVaultPath("personal", project, "/other/cwd"), join(testMemoryDir, "personal-vault"));
  });

  it("initializes a vault with schema, index, registry, and directories", () => {
    const project = join(testMemoryDir, "project");
    const result = initVault("project", project, project);

    assert.equal(result.created, true);
    assert.equal(existsSync(join(result.path, "WIKI_SCHEMA.md")), true);
    assert.equal(existsSync(join(result.path, "index.md")), true);
    assert.equal(existsSync(join(result.path, "records", "decisions")), true);
    assert.equal(existsSync(join(result.path, "meta", "registry.json")), true);

    const second = initVault("project", project, project);
    assert.equal(second.created, false);
  });

  it("syncs project-scoped active records into markdown pages and registry", () => {
    const project = join(testMemoryDir, "project");
    const otherProject = join(testMemoryDir, "other");
    initVault("project", project, project);

    const decisionId = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: project,
      text: "Adopt optional Obsidian-compatible vaults. api_key = abcdef0123456789XYZ",
      tags: "vault,obsidian",
      importance: 0.8,
    });
    upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: otherProject,
      text: "Other project memory must not be exported here.",
    });
    upsertRecord({
      kind: "preference",
      scope: "global",
      text: "Global memory belongs in the personal vault.",
    });

    const result = syncVault("project", project, project);
    assert.equal(result.records, 1);
    assert.equal(result.pagesWritten, 1);

    const pagePath = join(result.path, "records", "decisions", `${decisionId}.md`);
    const page = readFileSync(pagePath, "utf8");
    assert.match(page, /---\nid: "/);
    assert.match(page, /Adopt optional Obsidian-compatible vaults/);
    assert.match(page, /\[REDACTED:api-key\]/);
    assert.doesNotMatch(page, /abcdef0123456789XYZ/);
    assert.match(page, /#vault #obsidian/);

    const registry = JSON.parse(readFileSync(result.registryPath, "utf8")) as { pages: Array<{ source_record_id: string }> };
    assert.deepEqual(registry.pages.map((page) => page.source_record_id), [decisionId]);

    const status = getVaultStatus("project", project, project);
    assert.equal(status.initialized, true);
    assert.equal(status.recordPageCount, 1);
  });

  it("syncs global records into the personal vault", () => {
    const project = join(testMemoryDir, "project");
    initVault("personal", project, project);

    const globalId = upsertRecord({
      kind: "preference",
      scope: "global",
      text: "Prefer concise memory vault notes.",
      tags: "vault",
    });
    upsertRecord({
      kind: "task",
      scope: "project",
      project_id: project,
      text: "Project task should not go to personal vault.",
    });

    const result = syncVault("personal", project, project);
    assert.equal(result.records, 1);
    assert.equal(existsSync(join(result.path, "records", "preferences", `${globalId}.md`)), true);
  });

  it("requires explicit init before sync", () => {
    const project = join(testMemoryDir, "project");
    assert.throws(() => syncVault("project", project, project), /not initialized/);
  });
});
