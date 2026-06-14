/**
 * Commands: /memory-status, /memory-search, /memory-open, /memory-inject, /memory-mode, /memory-last,
 * /memory-export, /memory-import, /memory-backup, /memory-vault-*
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getStats, getLastInjection, getRecord } from "../db/index.js";
import { retrieve } from "../retrieval/index.js";
import { getProjectId, getConfig } from "../config/index.js";
import {
  backupMemoryDatabase,
  defaultPortablePath,
  importMemoryJsonFile,
  resolvePortablePath,
  writeMemoryExport,
  type ExportFormat,
} from "../portable/index.js";
import {
  INJECTION_MODE_ENTRY,
  MANUAL_INJECTION_ENTRY,
  SESSION_TOGGLE_ENTRY,
  getMemorySessionState,
  isInjectionMode,
  isRecordVisibleInProject,
  parseRefArgs,
} from "../session-state/index.js";
import {
  getVaultStatus,
  initVault,
  parseVaultScope,
  syncVault,
  type VaultScope,
} from "../vault/index.js";

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

  // ── /memory-open ────────────────────────────────────────────────

  pi.registerCommand("memory-open", {
    description: "Open a specific memory record by reference ID",
    handler: async (args, ctx) => {
      await handleMemoryOpen(args, ctx);
    },
  });

  pi.registerCommand("stone-open", {
    description: "Alias for /memory-open",
    handler: async (args, ctx) => {
      await handleMemoryOpen(args, ctx);
    },
  });

  // ── /memory-inject / /memory-clear-injected ────────────────────

  pi.registerCommand("memory-inject", {
    description: "Manually inject specific memory refs into future turns",
    handler: async (args, ctx) => {
      await handleMemoryInject(args, ctx, pi);
    },
  });

  pi.registerCommand("stone-inject", {
    description: "Alias for /memory-inject",
    handler: async (args, ctx) => {
      await handleMemoryInject(args, ctx, pi);
    },
  });

  pi.registerCommand("memory-clear-injected", {
    description: "Clear manually injected memory refs for this session",
    handler: async (_args, ctx) => {
      pi.appendEntry(MANUAL_INJECTION_ENTRY, { action: "clear" });
      ctx.ui.notify("Cleared manually injected memory refs for this session", "info");
    },
  });

  pi.registerCommand("stone-clear-injected", {
    description: "Alias for /memory-clear-injected",
    handler: async (_args, ctx) => {
      pi.appendEntry(MANUAL_INJECTION_ENTRY, { action: "clear" });
      ctx.ui.notify("Cleared manually injected memory refs for this session", "info");
    },
  });

  // ── /memory-mode ────────────────────────────────────────────────

  pi.registerCommand("memory-mode", {
    description: "Set memory injection mode for this session: auto or manual",
    handler: async (args, ctx) => {
      await handleMemoryMode(args, ctx, pi);
    },
  });

  pi.registerCommand("stone-mode", {
    description: "Alias for /memory-mode",
    handler: async (args, ctx) => {
      await handleMemoryMode(args, ctx, pi);
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

  // ── /memory-export / /memory-import / /memory-backup ───────────

  pi.registerCommand("memory-export", {
    description: "Export active memory records to JSON or Markdown",
    handler: async (args, ctx) => {
      await handleMemoryExport(args, ctx);
    },
  });

  pi.registerCommand("stone-export", {
    description: "Alias for /memory-export",
    handler: async (args, ctx) => {
      await handleMemoryExport(args, ctx);
    },
  });

  pi.registerCommand("memory-import", {
    description: "Import memory records from a JSON export",
    handler: async (args, ctx) => {
      await handleMemoryImport(args, ctx);
    },
  });

  pi.registerCommand("stone-import", {
    description: "Alias for /memory-import",
    handler: async (args, ctx) => {
      await handleMemoryImport(args, ctx);
    },
  });

  pi.registerCommand("memory-backup", {
    description: "Copy the SQLite memory database to a timestamped backup file",
    handler: async (args, ctx) => {
      await handleMemoryBackup(args, ctx);
    },
  });

  pi.registerCommand("stone-backup", {
    description: "Alias for /memory-backup",
    handler: async (args, ctx) => {
      await handleMemoryBackup(args, ctx);
    },
  });

  // ── /memory-vault-* ─────────────────────────────────────────────

  pi.registerCommand("memory-vault-init", {
    description: "Initialize an Obsidian-compatible memory vault",
    handler: async (args, ctx) => {
      await handleMemoryVaultInit(args, ctx);
    },
  });

  pi.registerCommand("stone-vault-init", {
    description: "Alias for /memory-vault-init",
    handler: async (args, ctx) => {
      await handleMemoryVaultInit(args, ctx);
    },
  });

  pi.registerCommand("memory-vault-sync", {
    description: "Sync active memory records into the initialized markdown vault",
    handler: async (args, ctx) => {
      await handleMemoryVaultSync(args, ctx);
    },
  });

  pi.registerCommand("stone-vault-sync", {
    description: "Alias for /memory-vault-sync",
    handler: async (args, ctx) => {
      await handleMemoryVaultSync(args, ctx);
    },
  });

  pi.registerCommand("memory-vault-status", {
    description: "Show memory vault path, initialization, and sync status",
    handler: async (args, ctx) => {
      await handleMemoryVaultStatus(args, ctx);
    },
  });

  pi.registerCommand("stone-vault-status", {
    description: "Alias for /memory-vault-status",
    handler: async (args, ctx) => {
      await handleMemoryVaultStatus(args, ctx);
    },
  });

  // ── /memory-on / /memory-off ────────────────────────────────────

  pi.registerCommand("memory-on", {
    description: "Enable memory injection for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Memory injection enabled for this session", "info");
      // Session toggle — stored in extension state
      pi.appendEntry(SESSION_TOGGLE_ENTRY, { enabled: true });
    },
  });

  pi.registerCommand("memory-off", {
    description: "Disable memory injection for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Memory injection disabled for this session", "info");
      pi.appendEntry(SESSION_TOGGLE_ENTRY, { enabled: false });
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
  const sessionState = getMemorySessionState(ctx.sessionManager.getBranch());
  lines.push(`    crossProjectEnabled: ${config.crossProjectEnabled}`);
  lines.push(`    injectionMode: ${config.injectionMode}`);
  lines.push(`    effectiveInjectionMode: ${sessionState.injectionMode ?? config.injectionMode}`);
  lines.push(`    manuallyInjectedRefs: ${sessionState.manualRefs.length > 0 ? sessionState.manualRefs.join(", ") : "none"}`);

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

async function handleMemoryOpen(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const refId = args?.trim().split(/\s+/).filter(Boolean)[0];

  if (!refId) {
    ctx.ui.notify("Usage: /memory-open <ref-id>", "warning");
    return;
  }

  const record = getRecord(refId);
  if (!record) {
    ctx.ui.notify(`Memory record ${refId} not found.`, "warning");
    return;
  }

  const currentProjectId = getProjectId(ctx.cwd);
  if (record.status !== "active" || !isRecordVisibleInProject(record, currentProjectId)) {
    ctx.ui.notify(`Memory record ${refId} is not available.`, "warning");
    return;
  }

  const lines: string[] = [];
  lines.push(`Memory Record: ${record.id}`);
  lines.push(`Kind: ${record.kind}`);
  lines.push(`Scope: ${record.scope}`);
  lines.push(`Project: ${record.project_id ?? "global"}`);
  lines.push(`Created: ${new Date(record.created_at).toISOString()}`);
  lines.push(`Status: ${record.status}`);
  lines.push("");
  lines.push(record.text);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleMemoryInject(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const refIds = parseRefArgs(args);

  if (refIds.length === 0) {
    ctx.ui.notify("Usage: /memory-inject <ref-id> [ref-id ...]", "warning");
    return;
  }

  const currentProjectId = getProjectId(ctx.cwd);
  const acceptedRefs: string[] = [];
  const rejectedRefs: string[] = [];

  for (const refId of refIds) {
    const record = getRecord(refId);
    if (record && record.status === "active" && isRecordVisibleInProject(record, currentProjectId)) {
      acceptedRefs.push(refId);
    } else {
      rejectedRefs.push(refId);
    }
  }

  if (acceptedRefs.length > 0) {
    pi.appendEntry(MANUAL_INJECTION_ENTRY, { action: "add", refs: acceptedRefs });
  }

  const lines: string[] = [];
  if (acceptedRefs.length > 0) {
    lines.push(`Manually injected memory refs for this session: ${acceptedRefs.join(", ")}`);
  }
  if (rejectedRefs.length > 0) {
    lines.push(`Unavailable refs skipped: ${rejectedRefs.join(", ")}`);
  }

  ctx.ui.notify(lines.join("\n") || "No memory refs were injected.", acceptedRefs.length > 0 ? "info" : "warning");
}

async function handleMemoryMode(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const mode = args?.trim().split(/\s+/).filter(Boolean)[0];
  const config = getConfig(ctx.cwd);
  const sessionState = getMemorySessionState(ctx.sessionManager.getBranch());

  if (!mode) {
    ctx.ui.notify(
      `Memory injection mode: ${sessionState.injectionMode ?? config.injectionMode}\nUsage: /memory-mode <auto|manual>`,
      "info",
    );
    return;
  }

  if (!isInjectionMode(mode)) {
    ctx.ui.notify("Usage: /memory-mode <auto|manual>", "warning");
    return;
  }

  pi.appendEntry(INJECTION_MODE_ENTRY, { mode });
  ctx.ui.notify(
    mode === "manual"
      ? "Memory injection mode set to manual for this session. Use /memory-inject <ref-id> to choose memories."
      : "Memory injection mode set to auto for this session.",
    "info",
  );
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

async function handleMemoryExport(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const formatValue = parsed.options.get("format") ?? (parsed.flags.has("md") ? "md" : "json");
  if (formatValue !== "json" && formatValue !== "md") {
    ctx.ui.notify("Usage: /memory-export [path] [--format json|md] [--all]", "warning");
    return;
  }

  const format = formatValue as ExportFormat;
  const outputPath = resolvePortablePath(
    ctx.cwd,
    parsed.positionals[0] ?? defaultPortablePath(ctx.cwd, "memory-export", format),
  );

  try {
    const count = writeMemoryExport(outputPath, format, parsed.flags.has("all"));
    ctx.ui.notify(`Exported ${count} memory records to ${outputPath}`, "info");
  } catch (err) {
    ctx.ui.notify(`Memory export failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

async function handleMemoryImport(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const inputPathArg = parsed.positionals[0];
  if (!inputPathArg) {
    ctx.ui.notify("Usage: /memory-import <memory-export.json> [--preserve-project|--global]", "warning");
    return;
  }

  const inputPath = resolvePortablePath(ctx.cwd, inputPathArg);
  try {
    const result = importMemoryJsonFile(inputPath, {
      projectId: parsed.flags.has("preserve-project") ? undefined : getProjectId(ctx.cwd),
      scopeOverride: parsed.flags.has("global") ? "global" : undefined,
    });
    ctx.ui.notify(
      `Imported ${result.imported} memory records from ${inputPath}${result.skipped ? ` (${result.skipped} skipped)` : ""}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Memory import failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

async function handleMemoryBackup(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const outputPath = resolvePortablePath(
    ctx.cwd,
    parsed.positionals[0] ?? defaultPortablePath(ctx.cwd, "memory-backup", "db"),
  );

  try {
    backupMemoryDatabase(outputPath);
    ctx.ui.notify(`Backed up memory database to ${outputPath}`, "info");
  } catch (err) {
    ctx.ui.notify(`Memory backup failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

async function handleMemoryVaultInit(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const scope = parseVaultScopeOrNotify(parsed, ctx);
  if (!scope) return;

  try {
    const projectId = getProjectId(ctx.cwd);
    const result = initVault(scope, projectId, ctx.cwd);
    ctx.ui.notify(
      result.created
        ? `Initialized ${scope} memory vault at ${result.path}`
        : `${scope} memory vault already initialized at ${result.path}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Memory vault init failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

async function handleMemoryVaultSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const scope = parseVaultScopeOrNotify(parsed, ctx);
  if (!scope) return;

  try {
    const projectId = getProjectId(ctx.cwd);
    const result = syncVault(scope, projectId, ctx.cwd);
    ctx.ui.notify(
      `Synced ${result.records} memory records to ${result.path} (${result.pagesWritten} page${result.pagesWritten === 1 ? "" : "s"} written). Registry: ${result.registryPath}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Memory vault sync failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

async function handleMemoryVaultStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseCommandArgs(args);
  const scope = parseVaultScopeOrNotify(parsed, ctx);
  if (!scope) return;

  const projectId = getProjectId(ctx.cwd);
  const status = getVaultStatus(scope, projectId, ctx.cwd);
  const lines: string[] = [];
  lines.push("📚 Memory Vault Status");
  lines.push("");
  lines.push(`  scope: ${scope}`);
  lines.push(`  path: ${status.path}`);
  lines.push(`  initialized: ${status.initialized}`);
  lines.push(`  registry: ${status.registryExists ? "present" : "missing"}`);
  lines.push(`  markdown pages: ${status.pageCount}`);
  lines.push(`  synced record pages: ${status.recordPageCount}`);
  lines.push(`  last sync: ${status.lastSyncedAt ?? "never"}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function parseVaultScopeOrNotify(
  parsed: ReturnType<typeof parseCommandArgs>,
  ctx: ExtensionCommandContext,
): VaultScope | null {
  const scope = parseVaultScope(parsed);
  if (!scope) {
    ctx.ui.notify("Usage: /memory-vault-<init|sync|status> [--project|--personal|--scope project|personal]", "warning");
    return null;
  }
  return scope;
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

    const currentProjectId = getProjectId(ctx.cwd);
    if (record.status !== "active" || !isRecordVisibleInProject(record, currentProjectId)) {
      ctx.ui.notify(`Memory record ${refId} is not available.`, "warning");
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

function parseCommandArgs(args: string): {
  flags: Set<string>;
  options: Map<string, string>;
  positionals: string[];
} {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positionals: string[] = [];
  const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.startsWith("--")) {
      positionals.push(part);
      continue;
    }

    const withoutPrefix = part.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    if (eqIndex >= 0) {
      options.set(withoutPrefix.slice(0, eqIndex), withoutPrefix.slice(eqIndex + 1));
      continue;
    }

    const next = parts[i + 1];
    if (next && !next.startsWith("--") && ["format", "scope"].includes(withoutPrefix)) {
      options.set(withoutPrefix, next);
      i += 1;
    } else {
      flags.add(withoutPrefix);
    }
  }

  return { flags, options, positionals };
}
