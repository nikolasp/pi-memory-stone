/**
 * pi-memory-stone — Global pi extension for session memory.
 *
 * Preserves and retrieves useful memory across pi sessions.
 * Builds a searchable SQLite+FTS5 index with backreferences to session entries.
 *
 * Vertical slice MVP:
 *  - SQLite schema + migrations
 *  - Deterministic turn_summary and file_activity capture on agent_end
 *  - FTS5 search
 *  - /memory-status, /memory-search, /memory-last commands
 *  - memory_search, memory_open, memory_remember, memory_forget tools
 *  - Conservative same-project before_agent_start injection
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands/index.js";
import { registerTools } from "./tools/index.js";
import { indexSessionOnAgentEnd } from "./indexing/index.js";
import { retrieve, buildInjectionPacket, formatInjectionForLlm } from "./retrieval/index.js";
import { getProjectId, getConfig, clearProjectCache } from "./config/index.js";
import { closeDb } from "./db/index.js";
import { createHash } from "node:crypto";

// ─── Session-scoped state ───────────────────────────────────────────

/** Track injected refs per turn to prevent feedback loops */
const injectedRefsThisSession: Set<string> = new Set();

/** Whether memory injection is temporarily disabled for this session */
let sessionEnabled = true;

// ─── Extension entry point ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Register commands ──────────────────────────────────────────

  registerCommands(pi);

  // ── Register tools ─────────────────────────────────────────────

  registerTools(pi);

  // ── agent_end: index session turn ──────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    try {
      const { recordsCreated, errors } = await indexSessionOnAgentEnd(ctx, event);

      if (errors.length > 0 && ctx.hasUI) {
        // Log errors but don't flood UI
        for (const err of errors.slice(0, 2)) {
          console.error("[pi-memory-stone] indexing error:", err);
        }
      }

      // Optionally notify on first indexing
      if (recordsCreated > 0 && ctx.hasUI) {
        // Silent by default; uncomment for verbose mode:
        // ctx.ui.setStatus("memory-stone", `Indexed ${recordsCreated} records`);
      }
    } catch (err) {
      console.error("[pi-memory-stone] agent_end handler error:", err);
    }
  });

  // ── before_agent_start: inject relevant memories ───────────────

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // Check if memory is enabled
      const config = getConfig(ctx.cwd);
      if (!config.enabled) return;

      // Check for session toggle entries before honoring the cached toggle so
      // /memory-on can re-enable injection after /memory-off in the same session.
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "custom" &&
          entry.customType === "memory-stone:session-toggle"
        ) {
          const data = entry.data as { enabled?: boolean } | undefined;
          if (typeof data?.enabled === "boolean") {
            sessionEnabled = data.enabled;
          }
        }
      }

      if (!sessionEnabled) return;

      const prompt = event.prompt || "";
      if (!prompt.trim()) return;

      // Hash prompt to detect repeated injections
      const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 12);

      const projectId = getProjectId(ctx.cwd);

      // Build search query
      const results = retrieve(prompt, projectId, [], {
        limit: config.maxInjectedRecords,
        crossProjectEnabled: config.crossProjectEnabled,
      });

      // Filter: skip already-injected refs
      const newResults = results.filter((r) => !injectedRefsThisSession.has(r.record.id));

      // Score threshold
      const thresholdResults = newResults.filter((r) => r.score >= config.scoreThreshold);

      if (thresholdResults.length === 0) return;

      // Build and format injection packet
      const packet = buildInjectionPacket(thresholdResults);
      const formatted = formatInjectionForLlm(packet, config.maxInjectedTokens);

      // Track injected refs (prevent feedback loop)
      for (const r of thresholdResults) {
        injectedRefsThisSession.add(r.record.id);
      }

      // Log injection to DB
      const { insertInjection } = await import("./db/index.js");
      insertInjection({
        session_id: ctx.sessionManager.getSessionId(),
        turn_entry_id: ctx.sessionManager.getLeafId() ?? undefined,
        prompt_hash: promptHash,
        injected_refs: thresholdResults.map((r) => r.record.id).join(","),
        packet: formatted,
        reasons: thresholdResults.map((r) => r.reasons.join(";")).join(" | "),
      });

      // Inject as a non-context audit custom entry (separate from LLM context)
      // but also as a system prompt addition for the LLM
      const systemPromptAddition = [
        "",
        "--- Memory Stone Context ---",
        formatted,
        "--- End Memory Stone Context ---",
      ].join("\n");

      return {
        systemPrompt: (event.systemPrompt || "") + systemPromptAddition,
      };
    } catch (err) {
      console.error("[pi-memory-stone] before_agent_start handler error:", err);
    }
  });

  // ── session_start: restore state ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Clear session-scoped state
      injectedRefsThisSession.clear();
      sessionEnabled = true;

      // Restore session toggle from branch
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "custom" &&
          entry.customType === "memory-stone:session-toggle"
        ) {
          const data = entry.data as { enabled?: boolean } | undefined;
          if (typeof data?.enabled === "boolean") {
            sessionEnabled = data.enabled;
          }
        }
      }

      // Clear project ID cache on session change
      clearProjectCache();
    } catch (err) {
      console.error("[pi-memory-stone] session_start handler error:", err);
    }
  });

  // ── session_shutdown: cleanup ──────────────────────────────────

  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      // Best-effort flush — DB is WAL mode so writes are already durable.
      // Cleanup any pending state.
      injectedRefsThisSession.clear();
    } catch (err) {
      console.error("[pi-memory-stone] session_shutdown handler error:", err);
    }
  });

  // ── Cleanup when extension is unloaded ─────────────────────────

  // Note: pi doesn't have an explicit unload hook, but session_shutdown
  // fires before reload. For process exit, Node handles file descriptor cleanup.
  process.on("exit", () => {
    closeDb();
  });
}
