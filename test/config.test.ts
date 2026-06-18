/**
 * Tests for the configuration module.
 * Run with: NODE_OPTIONS="--experimental-sqlite" tsx --test test/config.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getConfig, reloadConfig, clearProjectCache } from "../src/config/index.js";

describe("getConfig", () => {
  let testDir: string;
  let subDir: string;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-config-"));
    subDir = join(testDir, "src", "components");
    mkdirSync(join(testDir, ".pi"), { recursive: true });
    mkdirSync(subDir, { recursive: true });

    // Initialise a git repo so getProjectId resolves to testDir
    execSync("git init", { cwd: testDir, stdio: "ignore" });

    writeFileSync(
      join(testDir, ".pi", "settings.json"),
      JSON.stringify({ memory: { maxInjectedRecords: 42, injectionMode: "manual" } }),
    );
  });

  after(() => {
    reloadConfig();
    clearProjectCache();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads project-root settings when cwd is a subdirectory", () => {
    reloadConfig();
    clearProjectCache();

    const rootConfig = getConfig(testDir);
    const subConfig = getConfig(subDir);

    assert.equal(subConfig.maxInjectedRecords, 42);
    assert.equal(subConfig.injectionMode, "manual");
    assert.equal(rootConfig.maxInjectedRecords, subConfig.maxInjectedRecords);
    assert.equal(rootConfig.injectionMode, subConfig.injectionMode);
  });

  it("caches config by project root, not by cwd", () => {
    reloadConfig();
    clearProjectCache();

    // First call from root populates cache
    const rootConfig = getConfig(testDir);
    // Second call from subdirectory should hit the same cached root config
    const subConfig = getConfig(subDir);

    assert.equal(rootConfig.maxInjectedRecords, 42);
    assert.equal(subConfig.maxInjectedRecords, 42);
  });
});
