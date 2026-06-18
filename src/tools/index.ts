/**
 * Tools: memory_search, memory_open, memory_remember, memory_forget
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getRecord, getRecentFilePaths, softForgetRecord, upsertRecord } from "../db/index.js";
import { retrieve, normalizeRetrievalLimit } from "../retrieval/index.js";
import { getProjectId, getConfig } from "../config/index.js";
import { isSensitiveForGlobalMemory } from "../privacy/index.js";
import { isRecordVisibleInProject } from "../session-state/index.js";
import type { RecordKind, RecordScope } from "../db/schema.js";

export function registerTools(pi: ExtensionAPI): void {
  // ── memory_search ───────────────────────────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description:
      "Search your memory stone for relevant records from past pi sessions. Use this to recall past decisions, preferences, tasks, or error resolutions.",
    promptSnippet: "Search memory stone by query, with optional kind/scope/limit filters",
    promptGuidelines: [
      "Use memory_search to recall relevant context from past sessions before making decisions.",
      "Set kind to filter by record type: decision, preference, task, error_resolution, turn_summary.",
      "Set scope to 'global' for cross-project memories, or omit for current project only.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query text" }),
      kind: Type.Optional(
        StringEnum([
          "decision",
          "preference",
          "task",
          "error_resolution",
          "turn_summary",
          "session_summary",
        ] as const),
      ),
      scope: Type.Optional(StringEnum(["project", "global"] as const)),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)", minimum: 1, maximum: 20 })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const projectId = getProjectId(ctx.cwd);
      const config = getConfig(ctx.cwd);
      const limit = normalizeRetrievalLimit(params.limit, 5);

      const recentFiles = getRecentFilePaths(projectId, 5);
      const results = retrieve(params.query, projectId, recentFiles, {
        limit,
        crossProjectEnabled: params.scope === "global" || config.crossProjectEnabled,
        kindFilter: params.kind ? [params.kind as RecordKind] : undefined,
        scopeFilter: params.scope ? [params.scope as RecordScope] : undefined,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching memories found." }],
          details: { query: params.query, results: [] },
        };
      }

      // Concise numbered list for LLM readability
      const numberedList = results
        .map(
          (r, i) =>
            `${i + 1}. [${r.record.kind}] ref=${r.record.id} score=${r.score.toFixed(2)} — ${r.record.text.slice(0, 200)}`,
        )
        .join("\n");

      return {
        content: [{ type: "text", text: numberedList }],
        details: {
          query: params.query,
          results: results.map((r) => ({
            id: r.record.id,
            kind: r.record.kind,
            score: r.score,
            text: r.record.text.slice(0, 200),
            reasons: r.reasons,
          })),
        },
      };
    },
  });

  // ── memory_open ─────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_open",
    label: "Open Memory",
    description:
      "Open a specific memory record by its reference ID. Returns the full record text and metadata. The 'ref' can be obtained from memory_search results or injection packets.",
    promptSnippet: "Open specific memory record by ref ID to see full content",
    promptGuidelines: [
      "Use memory_open when you need the full text of a specific memory record referenced in an injection packet or search result.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "Memory record reference ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = getRecord(params.ref);

      if (!record) {
        return {
          content: [{ type: "text", text: `Memory record ${params.ref} not found.` }],
          details: { ref: params.ref, found: false },
        };
      }

      const currentProjectId = getProjectId(ctx.cwd);

      if (record.status !== "active" || !isRecordVisibleInProject(record, currentProjectId)) {
        return {
          content: [{ type: "text", text: `Memory record ${params.ref} is not available.` }],
          details: { ref: params.ref, found: false, unavailable: true },
        };
      }

      // Redacted excerpt (already redacted at storage time)
      const lines: string[] = [];
      lines.push(`Memory Record: ${record.id}`);
      lines.push(`Kind: ${record.kind}`);
      lines.push(`Scope: ${record.scope}`);
      lines.push(`Project: ${record.project_id ?? "global"}`);
      lines.push(`Created: ${new Date(record.created_at).toISOString()}`);
      lines.push(`Status: ${record.status}`);
      lines.push("");
      lines.push(record.text);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          ref: params.ref,
          found: true,
          kind: record.kind,
          scope: record.scope,
          status: record.status,
          created_at: record.created_at,
        },
      };
    },
  });

  // ── memory_remember ─────────────────────────────────────────────

  pi.registerTool({
    name: "memory_remember",
    label: "Remember",
    description:
      "Explicitly store a memory record. Only use when the user explicitly asks you to remember something. Default scope is project. Use scope='global' only when the user explicitly says to remember globally.",
    promptSnippet: "Store an explicit memory record when user asks to remember something",
    promptGuidelines: [
      "Use memory_remember only when the user explicitly asks you to remember a decision, preference, or fact.",
      "Default to scope='project'. Only use scope='global' when the user explicitly says 'remember this globally' or 'remember for all projects'.",
    ],
    parameters: Type.Object({
      kind: StringEnum([
        "decision",
        "preference",
        "task",
        "error_resolution",
        "turn_summary",
        "session_summary",
      ] as const),
      text: Type.String({ description: "Memory text to store" }),
      scope: Type.Optional(StringEnum(["project", "global"] as const)),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
      importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default 0.5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectId = getProjectId(ctx.cwd);
      let scope = params.scope ?? "project";

      // Safety: never allow global for implementation details, paths, etc.
      const isSensitiveForGlobal = isSensitiveForGlobalMemory(`${params.text}\n${params.tags ?? ""}`);

      const downgradedToProject = isSensitiveForGlobal && scope === "global";
      if (downgradedToProject) {
        scope = "project";
      }

      const recordId = upsertRecord({
        kind: params.kind as RecordKind,
        scope: scope as RecordScope,
        project_id: scope === "global" ? null : projectId,
        text: params.text,
        tags: params.tags,
        importance: params.importance ?? 0.5,
        confidence: 1.0,
      });

      return {
        content: [
          {
            type: "text",
            text: downgradedToProject
              ? `Cannot store as global: text appears to contain sensitive data (secrets, paths, hostnames). Stored as project-scoped instead: [${params.kind}] ${recordId}`
              : `Memory stored: [${params.kind}] ${recordId} (scope: ${scope})`,
          },
        ],
        details: { id: recordId, kind: params.kind, scope, downgradedToProject },
      };
    },
  });

  // ── memory_forget ───────────────────────────────────────────────

  pi.registerTool({
    name: "memory_forget",
    label: "Forget Memory",
    description:
      "Soft-forget a memory record by its reference ID. The record is hidden from future searches but can be restored. Use --hard for permanent deletion (requires explicit user confirmation).",
    promptSnippet: "Forget a memory record by ID (soft or hard)",
    promptGuidelines: [
      "Use memory_forget when the user asks to remove or forget a memory reference.",
      "Default to soft forget. Only use hard=true when the user explicitly asks to permanently delete.",
    ],
    parameters: Type.Object({
      ref: Type.String({ description: "Memory record reference ID" }),
      hard: Type.Optional(Type.Boolean({ description: "Permanently delete (default: soft forget)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = getRecord(params.ref);

      if (!record) {
        return {
          content: [{ type: "text", text: `Memory record ${params.ref} not found.` }],
          details: { ref: params.ref, found: false },
        };
      }

      const currentProjectId = getProjectId(ctx.cwd);
      if (record.status !== "active" || !isRecordVisibleInProject(record, currentProjectId)) {
        return {
          content: [{ type: "text", text: `Memory record ${params.ref} is not available.` }],
          details: { ref: params.ref, found: false, unavailable: true },
        };
      }

      if (params.hard) {
        // For hard delete via tool, we require the user to explicitly confirm
        // The tool should note this requires user interaction without leaking record contents.
        return {
          content: [
            {
              type: "text",
              text: `Permanent deletion requires explicit confirmation. Please use /memory-forget ${params.ref} --hard to permanently delete this record.`,
            },
          ],
          details: { ref: params.ref, requiresConfirmation: true },
        };
      }

      softForgetRecord(params.ref);
      return {
        content: [
          {
            type: "text",
            text: `Memory record ${params.ref} has been soft-forgotten. It will no longer appear in searches.`,
          },
        ],
        details: { ref: params.ref, forgotten: true, hard: false },
      };
    },
  });
}
