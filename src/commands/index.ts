/**
 * Commands: /memory-status, /memory-search, /memory-last
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getStats, getLastInjection } from "../db/index.js";
import { retrieve } from "../retrieval/index.js";
import { getProjectId, getConfig } from "../config/index.js";

export function registerCommands(pi: ExtensionAPI): void {
  // ── /memory-status ──────────────────────────────────────────────

  pi.registerCommand("memory-status", {
    description: "Show memory stone index statistics",
    handler: async (args, ctx) => {
      await handleMemoryStatus(args, ctx);
    },
  });

  pi.registerCommand("stone-status", {
    description: "Alias for /memory-status",
    handler: async (args, ctx) => {
      await handleMemoryStatus(args, ctx);
    },
  });

  // ── /memory-search ──────────────────────────────────────────────

  pi.registerCommand("memory-search", {
    description: "Search memory stone for relevant records",
    handler: async (args, ctx) => {
      await handleMemorySearch(args, ctx);
    },
  });

  pi.registerCommand("stone-search", {
    description: "Alias for /memory-search",
    handler: async (args, ctx) => {
      await handleMemorySearch(args, ctx);
    },
  });

  // ── /memory-last ────────────────────────────────────────────────

  pi.registerCommand("memory-last", {
    description: "Show the last memory injection packet",
    handler: async (_args, ctx) => {
      await handleMemoryLast(ctx);
    },
  });

  pi.registerCommand("stone-last", {
    description: "Alias for /memory-last",
    handler: async (_args, ctx) => {
      await handleMemoryLast(ctx);
    },
  });

  // ── /memory-forget ──────────────────────────────────────────────

  pi.registerCommand("memory-forget", {
    description: "Soft-forget a memory record by ID. Use --hard for permanent deletion.",
    handler: async (args, ctx) => {
      await handleMemoryForget(args, ctx);
    },
  });

  pi.registerCommand("stone-forget", {
    description: "Alias for /memory-forget",
    handler: async (args, ctx) => {
      await handleMemoryForget(args, ctx);
    },
  });

  // ── /memory-on / /memory-off ────────────────────────────────────

  pi.registerCommand("memory-on", {
    description: "Enable memory injection for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Memory injection enabled for this session", "info");
      // Session toggle — stored in extension state
      pi.appendEntry("memory-stone:session-toggle", { enabled: true });
    },
  });

  pi.registerCommand("memory-off", {
    description: "Disable memory injection for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Memory injection disabled for this session", "info");
      pi.appendEntry("memory-stone:session-toggle", { enabled: false });
    },
  });
}

// ─── Handler implementations ────────────────────────────────────────

async function handleMemoryStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const stats = getStats();

  const lines: string[] = [];
  lines.push("📊 Memory Stone Status");
  lines.push("");
  lines.push(`  Total active records: ${stats.totalRecords}`);
  lines.push(`  Indexed sessions: ${stats.totalSessions}`);
  lines.push(`  File activity entries: ${stats.totalFileActivity}`);
  lines.push("");

  if (verbose && Object.keys(stats.recordsByKind).length > 0) {
    lines.push("  Records by kind:");
    for (const [kind, count] of Object.entries(stats.recordsByKind)) {
      lines.push(`    ${kind}: ${count}`);
    }
    lines.push("");
  }

  const config = getConfig(ctx.cwd);
  lines.push("  Config:");
  lines.push(`    enabled: ${config.enabled}`);
  lines.push(`    maxInjectedRecords: ${config.maxInjectedRecords}`);
  lines.push(`    maxInjectedTokens: ${config.maxInjectedTokens}`);
  lines.push(`    crossProjectEnabled: ${config.crossProjectEnabled}`);

  if (ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), "info");
  }
}

async function handleMemorySearch(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const query = args?.trim();

  if (!query) {
    ctx.ui.notify("Usage: /memory-search <query>", "warning");
    return;
  }

  const projectId = getProjectId(ctx.cwd);
  const config = getConfig(ctx.cwd);

  const results = retrieve(query, projectId, [], {
    limit: 20,
    crossProjectEnabled: config.crossProjectEnabled,
  });

  if (results.length === 0) {
    ctx.ui.notify("No matching memories found.", "info");
    return;
  }

  const lines: string[] = [];
  lines.push(`🔍 Memory search results for: "${query}"`);
  lines.push("");

  for (const [i, r] of results.entries()) {
    const age = Date.now() - r.record.created_at;
    const ageStr = age < 3600000
      ? `${Math.floor(age / 60000)}m ago`
      : age < 86400000
        ? `${Math.floor(age / 3600000)}h ago`
        : `${Math.floor(age / 86400000)}d ago`;

    lines.push(`  ${i + 1}. [${r.record.kind}] ${r.record.id} (${ageStr}, score: ${r.score.toFixed(2)})`);
    lines.push(`     ${r.record.text.slice(0, 120)}`);
    lines.push("");
  }

  if (ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), "info");
  }
}

async function handleMemoryLast(ctx: ExtensionCommandContext): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const last = getLastInjection(sessionId);

  if (!last) {
    ctx.ui.notify("No memory injections in this session yet.", "info");
    return;
  }

  const lines: string[] = [];
  lines.push("📋 Last Memory Injection");
  lines.push("");

  if (last.packet) {
    lines.push(last.packet);
  } else {
    lines.push(`  Injected refs: ${last.injected_refs ?? "none"}`);
    lines.push(`  Reasons: ${last.reasons ?? "none"}`);
    lines.push(`  Time: ${new Date(last.created_at).toISOString()}`);
  }

  if (ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), "info");
  }
}

async function handleMemoryForget(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { softForgetRecord, hardDeleteRecord, getRecord } = await import("../db/index.js");

  const parts = args?.trim().split(/\s+/) ?? [];
  const hardFlag = parts.includes("--hard");
  const refIds = parts.filter((p) => !p.startsWith("--"));

  if (refIds.length === 0) {
    ctx.ui.notify("Usage: /memory-forget <ref-id> [--hard]", "warning");
    return;
  }

  for (const refId of refIds) {
    const record = getRecord(refId);
    if (!record) {
      ctx.ui.notify(`Record ${refId} not found.`, "warning");
      continue;
    }

    if (hardFlag) {
      const confirmed = ctx.hasUI
        ? await ctx.ui.confirm(
            "Permanent deletion",
            `Permanently delete memory record?\n\nKind: ${record.kind}\nText: ${record.text.slice(0, 100)}`,
          )
        : false;

      if (confirmed) {
        hardDeleteRecord(refId);
        ctx.ui.notify(`Permanently deleted record ${refId}`, "info");
      }
    } else {
      softForgetRecord(refId);
      ctx.ui.notify(`Soft-forgotten record ${refId}`, "info");
    }
  }
}
