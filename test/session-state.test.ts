/**
 * Tests for session-scoped memory injection state.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMemorySessionState,
  INJECTION_MODE_ENTRY,
  MANUAL_INJECTION_ENTRY,
  SESSION_TOGGLE_ENTRY,
} from "../src/session-state/index.js";
import { getConfig, reloadConfig } from "../src/config/index.js";
import { closeDb, getDbPath, upsertRecord } from "../src/db/index.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-session-state-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

describe("getMemorySessionState", () => {
  it("folds session toggles, mode overrides, manual ref additions, and clears", () => {
    const state = getMemorySessionState([
      { type: "custom", customType: SESSION_TOGGLE_ENTRY, data: { enabled: false } },
      { type: "custom", customType: INJECTION_MODE_ENTRY, data: { mode: "manual" } },
      { type: "custom", customType: MANUAL_INJECTION_ENTRY, data: { action: "add", refs: ["a", "b", "a"] } },
      { type: "custom", customType: MANUAL_INJECTION_ENTRY, data: { action: "clear" } },
      { type: "custom", customType: MANUAL_INJECTION_ENTRY, data: { action: "add", refs: ["c"] } },
      { type: "custom", customType: SESSION_TOGGLE_ENTRY, data: { enabled: true } },
    ]);

    assert.deepEqual(state, {
      enabled: true,
      injectionMode: "manual",
      manualRefs: ["c"],
    });
  });
});

describe("getConfig injectionMode", () => {
  it("reads manual injection mode from project settings", () => {
    const cwd = join(testMemoryDir, "project-with-manual-mode");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ memory: { injectionMode: "manual" } }));
    reloadConfig();

    assert.equal(getConfig(cwd).injectionMode, "manual");
  });

  it("falls back to auto for invalid injection mode", () => {
    const cwd = join(testMemoryDir, "project-with-invalid-mode");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ memory: { injectionMode: "sometimes" } }));
    reloadConfig();

    assert.equal(getConfig(cwd).injectionMode, "auto");
  });
});

describe("manual injection mode", () => {
  beforeEach(() => {
    cleanDb();
    reloadConfig();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("injects only explicitly selected refs when injectionMode is manual", async () => {
    const cwd = join(testMemoryDir, "manual-project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ memory: { enabled: true, injectionMode: "manual", maxInjectedTokens: 1000 } }),
    );
    reloadConfig();

    const chosenRef = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: cwd,
      text: "Chosen manual memory about sqlite migrations.",
    });
    upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: cwd,
      text: "Automatic search memory about sqlite migrations that should not appear.",
    });

    const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
    const pi = {
      registerCommand: () => {},
      registerTool: () => {},
      appendEntry: () => {},
      on: (eventName: string, handler: (event: any, ctx: any) => Promise<any>) => {
        handlers[eventName] = handler;
      },
    };

    const { default: registerExtension } = await import("../src/index.js");
    registerExtension(pi as any);

    const result = await handlers.before_agent_start(
      { prompt: "sqlite migrations", systemPrompt: "base" },
      {
        cwd,
        hasUI: false,
        sessionManager: {
          getSessionId: () => "session-1",
          getLeafId: () => "leaf-1",
          getBranch: () => [
            { type: "custom", customType: MANUAL_INJECTION_ENTRY, data: { action: "add", refs: [chosenRef] } },
          ],
        },
      },
    );

    assert.match(result.systemPrompt, /Chosen manual memory/);
    assert.doesNotMatch(result.systemPrompt, /Automatic search memory/);
  });
});
