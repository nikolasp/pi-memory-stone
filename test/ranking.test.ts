/**
 * Tests for the retrieval/ranking module.
 * Run with: NODE_OPTIONS="--experimental-sqlite" tsx --test test/ranking.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSearchQuery,
  rankAndFilter,
  buildInjectionPacket,
  formatInjectionForLlm,
} from "../src/retrieval/index.js";
import {
  getDb,
  closeDb,
  upsertRecord,
  getDbPath,
  softForgetRecord,
  getRecord,
  hardDeleteRecord,
  insertInjection,
  getLastInjection,
} from "../src/db/index.js";
import type { RecordRow } from "../src/db/index.js";
import type { RecordKind, RecordScope } from "../src/db/schema.js";

// ─── DB cleanup ─────────────────────────────────────────────────────

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-ranking-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  // Small delay to ensure file handles are released
  const files = [dbPath, dbPath + "-wal", dbPath + "-shm"];
  for (const f of files) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

// ─── Seed data helper ───────────────────────────────────────────────

function seedTestRecords() {
  const now = Date.now();
  const records: Array<{
    kind: RecordKind;
    scope: RecordScope;
    project_id: string | null;
    text: string;
    tags?: string;
    created_at: number;
  }> = [
    {
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Decided to use TypeScript for the frontend. Reasoning: better type safety and tooling support.",
      tags: "typescript,frontend,decision",
      created_at: now - 1000,
    },
    {
      kind: "preference",
      scope: "project",
      project_id: "/home/test-project",
      text: "User prefers 2-space indentation for all TypeScript files.",
      tags: "formatting,preference",
      created_at: now - 2000,
    },
    {
      kind: "error_resolution",
      scope: "project",
      project_id: "/home/test-project",
      text: "Tool: bash\nError: Module not found: @earendil-works/pi-coding-agent\nResolution: Run npm install in the extension directory.",
      tags: "error,resolve",
      created_at: now - 5000,
    },
    {
      kind: "task",
      scope: "project",
      project_id: "/home/test-project",
      text: "TODO: Add unit tests for the authentication module.",
      tags: "task,todo",
      created_at: now - 10000,
    },
    {
      kind: "preference",
      scope: "global",
      project_id: null,
      text: "User always wants answers in concise bullet-point format.",
      tags: "formatting,global",
      created_at: now - 3000,
    },
    {
      kind: "decision",
      scope: "project",
      project_id: "/home/other-project",
      text: "Decided to use PostgreSQL instead of MySQL for the other project.",
      tags: "database,decision",
      created_at: now - 6000,
    },
  ];

  for (const r of records) {
    upsertRecord({
      kind: r.kind,
      scope: r.scope,
      project_id: r.project_id,
      text: r.text,
      tags: r.tags,
    });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("buildSearchQuery", () => {
  it("uses user prompt text", () => {
    const query = buildSearchQuery("How should I format TypeScript files?");
    assert.ok(query.includes("How should I format"));
    assert.ok(query.includes("TypeScript files"));
  });

  it("includes recent file basenames", () => {
    const query = buildSearchQuery("Fix auth bug", [
      "src/auth/login.ts",
      "src/auth/signup.ts",
    ]);
    assert.ok(query.includes("login.ts"));
    assert.ok(query.includes("signup.ts"));
  });

  it("truncates long prompts", () => {
    const longPrompt = "A".repeat(500);
    const query = buildSearchQuery(longPrompt);
    assert.ok(query.length <= 250);
  });
});

describe("rankAndFilter", () => {
  before(() => {
    cleanDb();
    seedTestRecords();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("boosts same-project records", () => {
    const db = getDb();
    const records = db
      .prepare(
        `SELECT r.*, 0 as rank FROM records r
         WHERE r.text LIKE '%TypeScript%' AND r.status = 'active'`,
      )
      .all() as unknown as (RecordRow & { rank: number })[];

    const ranked = rankAndFilter(records, "/home/test-project", false);

    const sameProject = ranked.filter(
      (r) => r.record.project_id === "/home/test-project",
    );
    assert.ok(sameProject.length > 0);
    assert.ok(sameProject.some((r) => r.reasons.includes("same-project")));
  });

  it("filters out cross-project records when crossProjectEnabled is false", () => {
    const db = getDb();
    const records = db
      .prepare(
        `SELECT r.*, 0 as rank FROM records r
         WHERE r.text LIKE '%PostgreSQL%' AND r.status = 'active'`,
      )
      .all() as unknown as (RecordRow & { rank: number })[];

    const ranked = rankAndFilter(records, "/home/test-project", false);

    const otherProject = ranked.filter(
      (r) => r.record.project_id === "/home/other-project",
    );
    assert.equal(otherProject.length, 0);
  });

  it("filters out global-scope records from other projects when cross-project is disabled", () => {
    upsertRecord({
      kind: "preference",
      scope: "global",
      project_id: "/home/other-project",
      text: "Other project global preference about bullet lists",
      tags: "global,other-project",
    });

    const db = getDb();
    const records = db
      .prepare(
        `SELECT r.*, 0 as rank FROM records r
         WHERE r.text LIKE '%Other project global preference%'`,
      )
      .all() as unknown as (RecordRow & { rank: number })[];

    const ranked = rankAndFilter(records, "/home/test-project", false);
    assert.equal(ranked.length, 0);
  });

  it("includes global-scope records from other projects when cross-project", () => {
    const db = getDb();
    const records = db
      .prepare(
        `SELECT r.*, 0 as rank FROM records r
         WHERE r.text LIKE '%bullet%' AND r.status = 'active'`,
      )
      .all() as unknown as (RecordRow & { rank: number })[];

    const ranked = rankAndFilter(records, "/home/test-project", true);

    const globalRecords = ranked.filter((r) => r.record.scope === "global");
    assert.ok(globalRecords.length > 0);
  });

  it("preserves soft-forgotten status on duplicate upsert", () => {
    const id = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Remember not to resurrect this duplicate memory",
    });

    softForgetRecord(id);
    upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Remember not to resurrect this duplicate memory",
    });

    assert.equal(getRecord(id)?.status, "soft_forgotten");
  });

  it("keeps duplicate text separate across projects", () => {
    const id1 = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Use the same deployment checklist everywhere",
    });
    const id2 = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/other-project",
      text: "Use the same deployment checklist everywhere",
    });

    assert.notEqual(id1, id2);
    assert.equal(getRecord(id1)?.project_id, "/home/test-project");
    assert.equal(getRecord(id2)?.project_id, "/home/other-project");
  });

  it("redacts secrets at the record storage boundary", () => {
    const id = upsertRecord({
      kind: "preference",
      scope: "project",
      project_id: "/home/test-project",
      text: "Store password=superSecret123 for later",
      tags: "token=abcdef0123456789",
    });

    const record = getRecord(id);
    assert.ok(record);
    assert.ok(record.text.includes("[REDACTED:password]"));
    assert.ok(!record.text.includes("superSecret123"));
    assert.ok(record.tags?.includes("[REDACTED:token]"));
    assert.ok(!record.tags?.includes("abcdef0123456789"));
  });

  it("hard deletion removes injection audit rows that reference the record", () => {
    const id = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Delete this audit-visible memory",
    });

    insertInjection({
      session_id: "session-with-deleted-memory",
      injected_refs: id,
      packet: `Memory text for ${id}: Delete this audit-visible memory`,
    });
    assert.ok(getLastInjection("session-with-deleted-memory"));

    hardDeleteRecord(id);
    assert.equal(getLastInjection("session-with-deleted-memory"), undefined);
  });

  it("filters out non-active records", () => {
    // Create a soft-forgotten record
    upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: "/home/test-project",
      text: "Forgotten decision about architecture",
      status: "soft_forgotten",
    });

    const db = getDb();
    const records = db
      .prepare(
        `SELECT r.*, 0 as rank FROM records r
         WHERE r.text LIKE '%Forgotten decision%'`,
      )
      .all() as unknown as (RecordRow & { rank: number })[];

    const ranked = rankAndFilter(records, "/home/test-project", false);
    assert.equal(ranked.length, 0);
  });
});

describe("buildInjectionPacket", () => {
  it("builds a structured injection packet", () => {
    const results = [
      {
        record: {
          id: "abc123",
          kind: "decision" as RecordKind,
          text: "Decided to use TypeScript",
          project_id: "/home/test-project",
          created_at: Date.now() - 1000,
        } as RecordRow,
        score: 0.95,
        reasons: ["same-project"],
      },
    ];

    const packet = buildInjectionPacket(results);
    assert.ok(packet.header.includes("Memory: loaded"));
    assert.equal(packet.items.length, 1);
    assert.equal(packet.items[0].ref, "abc123");
    assert.ok(packet.items[0].text.includes("TypeScript"));
    assert.ok(packet.footer.includes("memory-forget"));
  });

  it("adds stale hints for old records", () => {
    const thirtyDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const results = [
      {
        record: {
          id: "old123",
          kind: "decision" as RecordKind,
          text: "Old decision",
          project_id: "/home/test-project",
          created_at: thirtyDaysAgo,
        } as RecordRow,
        score: 0.5,
        reasons: [],
      },
    ];

    const packet = buildInjectionPacket(results);
    assert.ok(packet.items[0].staleHint);
    assert.ok(packet.items[0].staleHint!.includes("stale"));
  });
});

describe("formatInjectionForLlm", () => {
  it("formats packet for LLM consumption", () => {
    const packet = {
      header: "Memory: loaded 2 items",
      items: [
        { ref: "abc", kind: "decision", text: "Use TypeScript" },
        { ref: "def", kind: "preference", text: "2-space indent" },
      ],
      footer: "Use /memory-forget to remove",
      recordCount: 2,
    };

    const formatted = formatInjectionForLlm(packet, 1000);
    assert.ok(formatted.includes("Memory: loaded"));
    assert.ok(formatted.includes("[decision ref=abc]"));
    assert.ok(formatted.includes("[preference ref=def]"));
    assert.ok(formatted.includes("/memory-forget"));
  });

  it("respects token budget", () => {
    const longText = "x".repeat(5000);
    const packet = {
      header: "Header",
      items: [{ ref: "abc", kind: "decision", text: longText }],
      footer: "Footer",
      recordCount: 1,
    };

    const formatted = formatInjectionForLlm(packet, 10);
    assert.ok(
      formatted.length < 200,
      `Expected <200 chars but got ${formatted.length}`,
    );
  });
});
