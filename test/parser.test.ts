/**
 * Tests for the session parser module.
 * Run with: node --experimental-sqlite --test test/parser.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEntries, turnsToRecords } from "../src/indexing/parser.js";

// ─── Helpers ────────────────────────────────────────────────────────

function makeUserEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: id === "001" ? null : String(Number(id) - 1).padStart(3, "0"),
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: text,
      timestamp: Date.now(),
    },
  };
}

function makeAssistantEntry(id: string, text: string, toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []) {
  const content: Array<Record<string, unknown>> = [];
  if (text) {
    content.push({ type: "text", text });
  }
  for (const tc of toolCalls) {
    content.push({ type: "toolCall", ...tc });
  }
  return {
    type: "message",
    id,
    parentId: String(Number(id) - 1).padStart(3, "0"),
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { totalTokens: 100 },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

function makeToolResultEntry(id: string, toolCallId: string, toolName: string, text: string, isError = false) {
  return {
    type: "message",
    id,
    parentId: String(Number(id) - 1).padStart(3, "0"),
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.now(),
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("parseEntries", () => {
  it("parses a simple user-assistant turn", () => {
    const entries = [
      makeUserEntry("001", "Hello, can you help me?"),
      makeAssistantEntry("002", "Of course! How can I assist?"),
    ];

    const { turns } = parseEntries(entries as any);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].userEntryId, "001");
    assert.ok(turns[0].userPrompt.includes("Hello"));
    assert.ok(turns[0].assistantText.includes("Of course"));
    assert.equal(turns[0].toolCalls.length, 0);
    assert.equal(turns[0].errors.length, 0);
  });

  it("parses a turn with tool calls", () => {
    const entries = [
      makeUserEntry("001", "Read package.json"),
      makeAssistantEntry("002", "Let me read that file.", [
        { id: "call_1", name: "read", arguments: { path: "package.json" } },
      ]),
      makeToolResultEntry("003", "call_1", "read", '{"name": "my-package"}'),
    ];

    const { turns } = parseEntries(entries as any);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].toolCalls.length, 1);
    assert.equal(turns[0].toolCalls[0].toolName, "read");
    assert.deepEqual(turns[0].toolCalls[0].args, { path: "package.json" });
    assert.equal(turns[0].toolCalls[0].resultText, '{"name": "my-package"}');
  });

  it("preserves assistant tool calls without tool results", () => {
    const entries = [
      makeUserEntry("001", "Read package.json"),
      makeAssistantEntry("002", "Let me read that file.", [
        { id: "call_1", name: "read", arguments: { path: "package.json" } },
      ]),
    ];

    const { turns } = parseEntries(entries as any);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].toolCalls.length, 1);
    assert.equal(turns[0].toolCalls[0].toolCallId, "call_1");
    assert.equal(turns[0].toolCalls[0].toolName, "read");
    assert.deepEqual(turns[0].toolCalls[0].args, { path: "package.json" });
    assert.equal(turns[0].toolCalls[0].resultText, "");
  });

  it("parses multiple turns", () => {
    const entries = [
      makeUserEntry("001", "Question 1"),
      makeAssistantEntry("002", "Answer 1"),
      makeUserEntry("003", "Question 2"),
      makeAssistantEntry("004", "Answer 2"),
    ];

    const { turns } = parseEntries(entries as any);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].userEntryId, "001");
    assert.equal(turns[1].userEntryId, "003");
  });

  it("detects errors in tool results", () => {
    const entries = [
      makeUserEntry("001", "Run a command"),
      makeAssistantEntry("002", "Running...", [
        { id: "call_1", name: "bash", arguments: { command: "invalid" } },
      ]),
      makeToolResultEntry("003", "call_1", "bash", "Command not found", true),
    ];

    const { turns } = parseEntries(entries as any);
    assert.equal(turns[0].errors.length, 1);
    assert.equal(turns[0].errors[0].toolName, "bash");
  });

  it("detects file activities from tool calls", () => {
    const entries = [
      makeUserEntry("001", "Check package.json"),
      makeAssistantEntry("002", "Let me check.", [
        { id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
        { id: "call_2", name: "edit", arguments: { path: "src/utils.ts" } },
      ]),
      makeToolResultEntry("003", "call_1", "read", "content..."),
      makeToolResultEntry("004", "call_2", "edit", "edited"),
    ];

    const { fileActivities } = parseEntries(entries as any);

    const reads = fileActivities.filter((f) => f.action === "read");
    const edits = fileActivities.filter((f) => f.action === "edit");

    assert.equal(reads.length, 1);
    assert.equal(edits.length, 1);
    assert.equal(reads[0].path, "src/index.ts");
    assert.equal(edits[0].path, "src/utils.ts");
  });

  it("detects multiple file arguments in bash commands", () => {
    const entries = [
      makeUserEntry("001", "Inspect file changes"),
      makeAssistantEntry("002", "Running bash.", [
        {
          id: "call_1",
          name: "bash",
          arguments: { command: "git diff -- src/index.ts && cp src/a.ts src/b.ts && mv old.ts new.ts" },
        },
      ]),
    ];

    const { fileActivities } = parseEntries(entries as any);
    const paths = fileActivities.map((f) => f.path).sort();

    assert.deepEqual(paths, ["new.ts", "old.ts", "src/a.ts", "src/b.ts", "src/index.ts"]);
  });

  it("skips sensitive file paths", () => {
    const entries = [
      makeUserEntry("001", "Check env"),
      makeAssistantEntry("002", "Checking...", [
        { id: "call_1", name: "read", arguments: { path: ".env" } },
        { id: "call_2", name: "read", arguments: { path: "src/app.ts" } },
      ]),
      makeToolResultEntry("003", "call_1", "read", "SECRET=abc"),
      makeToolResultEntry("004", "call_2", "read", "code..."),
    ];

    const { fileActivities } = parseEntries(entries as any);
    const envActivity = fileActivities.filter((f) => f.path.includes(".env"));
    const normalActivity = fileActivities.filter((f) => f.path === "src/app.ts");

    assert.equal(envActivity.length, 0, "Should skip .env files");
    assert.equal(normalActivity.length, 1, "Should keep normal files once");
  });

  it("handles compactions", () => {
    const entries = [
      makeUserEntry("001", "Test"),
      makeAssistantEntry("002", "Response"),
      {
        type: "compaction",
        id: "003",
        parentId: "002",
        timestamp: new Date().toISOString(),
        summary: "Previous context summarized",
        firstKeptEntryId: "001",
        tokensBefore: 5000,
      },
    ];

    const { compactions } = parseEntries(entries as any);
    assert.equal(compactions.length, 1);
    assert.ok(compactions[0].summary.includes("Previous"));
  });
});

describe("turnsToRecords", () => {
  it("generates turn_summary records", () => {
    const turns = [
      {
        userEntryId: "001",
        userPrompt: "Fix the authentication bug",
        assistantEntryIds: ["002"],
        assistantText: "I found the issue in auth.ts and fixed it.",
        toolCalls: [
          {
            entryId: "003",
            toolName: "read",
            args: { path: "src/auth.ts" },
            resultText: "code...",
            isError: false,
          },
        ],
        errors: [],
        lastEntryId: "003",
      },
    ];

    const records = turnsToRecords(turns, "/home/project", "session-1", "/path/session.jsonl");
    assert.ok(records.length >= 1);
    assert.equal(records[0].kind, "turn_summary");
    assert.ok(records[0].text.includes("Fix the authentication"));
    assert.ok(records[0].text.includes("auth.ts"));
  });

  it("generates error_resolution records for errors", () => {
    const turns = [
      {
        userEntryId: "001",
        userPrompt: "Run deployment",
        assistantEntryIds: ["002"],
        assistantText: "Running deploy...",
        toolCalls: [],
        errors: [
          {
            entryId: "003",
            toolName: "bash",
            message: "Permission denied: cannot write to /etc",
          },
        ],
        lastEntryId: "003",
      },
    ];

    const records = turnsToRecords(turns, "/home/project", "session-1", "/path/session.jsonl");
    const errorRecords = records.filter((r) => r.kind === "error_resolution");
    assert.equal(errorRecords.length, 1);
    assert.ok(errorRecords[0].text.includes("Permission denied"));
  });
});
