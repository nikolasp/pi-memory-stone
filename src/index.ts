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
 *  - /memory-status, /memory-search, /memory-open, /memory-inject, /memory-last commands
 *  - /memory-vault-* commands and natural-language URL capture
 *  - memory_search, memory_open, memory_remember, memory_forget tools
 *  - Conservative same-project before_agent_start injection
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands/index.js";
import { registerTools } from "./tools/index.js";
import { indexSessionOnAgentEnd } from "./indexing/index.js";
import { retrieve, buildInjectionPacket, formatInjectionForLlm } from "./retrieval/index.js";
import { getProjectId, getConfig, clearProjectCache } from "./config/index.js";
import { closeDb, getRecord, insertInjection } from "./db/index.js";
import { getMemorySessionState, manualRecordsToRankedResults } from "./session-state/index.js";
import { captureUrlToVault } from "./vault/capture.js";
import { parseVaultCaptureIntent } from "./vault/intent.js";
import { createHash } from "node:crypto";

// ─── Session-scoped state ───────────────────────────────────────────

/** Track injected refs per turn to prevent feedback loops */
const injectedRefsThisSession: Set<string> = new Set();

/** Whether memory injection is temporarily disabled for this session */
let sessionEnabled = true;

async function maybeCaptureVaultUrl(
  prompt: string,
  projectId: string | null,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const intent = parseVaultCaptureIntent(prompt);
  if (!intent) return null;

  try {
    const result = await captureUrlToVault(intent.scope, projectId, cwd, intent.url, { signal });
    const warnings = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : "";
    return `Captured web page into ${intent.scope} memory vault${result.initialized ? " (initialized vault)" : ""}: ${result.title}\nQuality: ${result.quality} (${result.qualityScore})${warnings}\nPage: ${result.pagePath}\nSource packet: ${result.sourcePacketPath}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pi-memory-stone] vault URL capture failed:", err);
    return `Memory vault URL capture failed: ${message}`;
  }
}

function vaultCaptureReturn(systemPrompt: string, notice: string) {
  return {
    message: {
      customType: "memory-vault-capture",
      content: notice,
      display: true,
    },
    systemPrompt: `${systemPrompt}\n\n--- Memory Vault Capture ---\n${notice}\nThe user's vault capture request has already been handled by pi-memory-stone. Briefly confirm the result; do not fetch the same URL again unless the user asks.\n--- End Memory Vault Capture ---`,
  };
}

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
      const prompt = event.prompt || "";
      const projectId = getProjectId(ctx.cwd);
      const vaultCaptureNotice = await maybeCaptureVaultUrl(prompt, projectId, ctx.cwd, ctx.signal);

      // Check if memory is enabled
      const config = getConfig(ctx.cwd);
      if (!config.enabled) {
        return vaultCaptureNotice ? vaultCaptureReturn(event.systemPrompt || "", vaultCaptureNotice) : undefined;
      }

      const sessionState = getMemorySessionState(ctx.sessionManager.getBranch());
      sessionEnabled = sessionState.enabled;

      if (!sessionEnabled) {
        return vaultCaptureNotice ? vaultCaptureReturn(event.systemPrompt || "", vaultCaptureNotice) : undefined;
      }

      const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
      const injectionMode = sessionState.injectionMode ?? config.injectionMode;

      const manualRecords = sessionState.manualRefs
        .map((ref) => getRecord(ref))
        .filter((record): record is NonNullable<typeof record> => Boolean(record));
      const manualResults = manualRecordsToRankedResults(manualRecords, projectId);
      const manualRefSet = new Set(manualResults.map((r) => r.record.id));

      let autoResults: ReturnType<typeof retrieve> = [];
      if (injectionMode === "auto" && prompt.trim()) {
        const results = retrieve(prompt, projectId, [], {
          limit: config.maxInjectedRecords,
          crossProjectEnabled: config.crossProjectEnabled,
        });

        autoResults = results
          .filter((r) => !manualRefSet.has(r.record.id))
          .filter((r) => !injectedRefsThisSession.has(r.record.id))
          .filter((r) => r.score >= config.scoreThreshold);
      }

      const selectedResults = [...manualResults, ...autoResults];
      let formatted: string | null = null;
      if (selectedResults.length > 0) {
        const packet = buildInjectionPacket(selectedResults);
        formatted = formatInjectionForLlm(packet, config.maxInjectedTokens);
      }

      // Track only search-selected refs. Manually chosen refs are intentionally
      // injected on every turn until /memory-clear-injected is used.
      for (const r of autoResults) {
        injectedRefsThisSession.add(r.record.id);
      }

      if (formatted) {
        insertInjection({
          session_id: ctx.sessionManager.getSessionId(),
          turn_entry_id: ctx.sessionManager.getLeafId() ?? undefined,
          prompt_hash: promptHash,
          injected_refs: selectedResults.map((r) => r.record.id).join(","),
          packet: formatted,
          reasons: selectedResults.map((r) => r.reasons.join(";")).join(" | "),
        });
      }

      if (!formatted && !vaultCaptureNotice) return;

      let systemPrompt = event.systemPrompt || "";
      if (formatted) {
        // Inject as a non-context audit custom entry (separate from LLM context)
        // but also as a system prompt addition for the LLM
        systemPrompt += [
          "",
          "--- Memory Stone Context ---",
          formatted,
          "--- End Memory Stone Context ---",
        ].join("\n");
      }

      if (vaultCaptureNotice) {
        return vaultCaptureReturn(systemPrompt, vaultCaptureNotice);
      }

      return { systemPrompt };
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
      sessionEnabled = getMemorySessionState(ctx.sessionManager.getBranch()).enabled;

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
