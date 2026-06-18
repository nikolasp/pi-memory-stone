/**
 * Regression tests for runtime warning noise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("runtime warnings", () => {
  it("does not print Node's experimental sqlite warning when opening the database", () => {
    const testDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-warning-"));
    const dbPath = join(testDir, "memory.db");

    try {
      const script = `
        process.env.PI_MEMORY_STONE_DB_PATH = ${JSON.stringify(dbPath)};
        const { getDb, closeDb } = await import("./src/db/index.ts");
        getDb();
        closeDb();
        console.log("opened");
      `;

      const result = spawnSync(
        process.execPath,
        ["--experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /opened/);
      assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
