/**
 * Optional Obsidian-compatible knowledge vault layer for pi-memory-stone.
 *
 * SQLite remains the source of truth. Vault pages are generated, reviewable
 * markdown projections of active memory records.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listRecords, type RecordRow } from "../db/index.js";
import { kindDirectory, recordMarkdown, recordTitle } from "./markdown.js";
import { resolveVaultPath, type VaultScope } from "./paths.js";

export { isVaultScope, parseVaultScope, resolveVaultPath, type VaultScope } from "./paths.js";
export { kindDirectory, parseTags, recordMarkdown, recordTitle, sanitizeSlug } from "./markdown.js";

const VAULT_SCHEMA_VERSION = 1;

export interface VaultInitResult {
  path: string;
  created: boolean;
}

export interface VaultSyncResult {
  path: string;
  records: number;
  pagesWritten: number;
  registryPath: string;
}

export interface VaultStatus {
  path: string;
  initialized: boolean;
  registryExists: boolean;
  pageCount: number;
  recordPageCount: number;
  lastSyncedAt: string | null;
}

export interface VaultRegistry {
  format: "pi-memory-stone-vault-registry";
  version: number;
  scope: VaultScope;
  project_id: string | null;
  generated_at: string;
  pages: VaultRegistryPage[];
}

export interface VaultRegistryPage {
  path: string;
  title: string;
  kind: string;
  source_record_id?: string;
  source_url?: string;
  source_packet?: string;
  content_hash: string;
  generated: true;
  created_at: string;
  updated_at: string;
}

export function initVault(scope: VaultScope, projectId: string | null, cwd: string): VaultInitResult {
  const vaultPath = resolveVaultPath(scope, projectId, cwd);
  const alreadyInitialized = existsSync(join(vaultPath, "WIKI_SCHEMA.md"));

  ensureVaultDirectories(vaultPath);
  writeIfMissing(join(vaultPath, "WIKI_SCHEMA.md"), schemaMarkdown(scope));
  writeIfMissing(join(vaultPath, "index.md"), indexMarkdown(scope, projectId, []));
  writeIfMissing(join(vaultPath, "meta", "registry.json"), JSON.stringify(emptyRegistry(scope, projectId), null, 2) + "\n");

  return { path: vaultPath, created: !alreadyInitialized };
}

export function syncVault(scope: VaultScope, projectId: string | null, cwd: string): VaultSyncResult {
  const vaultPath = resolveVaultPath(scope, projectId, cwd);
  if (!isVaultInitialized(vaultPath)) {
    throw new Error(`Vault is not initialized at ${vaultPath}. Run /memory-vault-init first.`);
  }

  ensureVaultDirectories(vaultPath);
  const records = recordsForVault(scope, projectId);
  const pages: VaultRegistryPage[] = [];
  let pagesWritten = 0;

  for (const record of records) {
    const relativePagePath = join("records", kindDirectory(record.kind), `${record.id}.md`);
    const outputPath = join(vaultPath, relativePagePath);
    mkdirSync(join(vaultPath, "records", kindDirectory(record.kind)), { recursive: true, mode: 0o700 });

    const content = recordMarkdown(record);
    const hash = sha256(content);
    const existing = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
    if (existing !== content) {
      writeFileSync(outputPath, content, { mode: 0o600 });
      pagesWritten += 1;
    }

    pages.push({
      path: normalizePath(relativePagePath),
      title: recordTitle(record),
      kind: record.kind,
      source_record_id: record.id,
      content_hash: hash,
      generated: true,
      created_at: new Date(record.created_at).toISOString(),
      updated_at: new Date(record.updated_at).toISOString(),
    });
  }

  const existingRegistry = readRegistry(join(vaultPath, "meta", "registry.json"));
  const preservedPages = existingRegistry?.pages.filter((page) => !page.source_record_id) ?? [];
  const registry: VaultRegistry = {
    format: "pi-memory-stone-vault-registry",
    version: VAULT_SCHEMA_VERSION,
    scope,
    project_id: scope === "project" ? projectId : null,
    generated_at: new Date().toISOString(),
    pages: [...preservedPages, ...pages].sort((a, b) => a.path.localeCompare(b.path)),
  };

  const registryPath = join(vaultPath, "meta", "registry.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(vaultPath, "index.md"), indexMarkdown(scope, projectId, pages), { mode: 0o600 });

  return { path: vaultPath, records: records.length, pagesWritten, registryPath };
}

export function getVaultStatus(scope: VaultScope, projectId: string | null, cwd: string): VaultStatus {
  const vaultPath = resolveVaultPath(scope, projectId, cwd);
  const registryPath = join(vaultPath, "meta", "registry.json");
  const initialized = isVaultInitialized(vaultPath);
  const registry = readRegistry(registryPath);

  return {
    path: vaultPath,
    initialized,
    registryExists: existsSync(registryPath),
    pageCount: countMarkdownFiles(vaultPath),
    recordPageCount: registry?.pages.filter((page) => Boolean(page.source_record_id)).length ?? 0,
    lastSyncedAt: registry?.generated_at ?? null,
  };
}

function recordsForVault(scope: VaultScope, projectId: string | null): RecordRow[] {
  return listRecords().filter((record) => {
    if (scope === "personal") return record.scope === "global";
    return record.scope === "project" && record.project_id === projectId;
  });
}

function ensureVaultDirectories(vaultPath: string): void {
  const dirs = [
    vaultPath,
    join(vaultPath, "records"),
    join(vaultPath, "records", "decisions"),
    join(vaultPath, "records", "preferences"),
    join(vaultPath, "records", "tasks"),
    join(vaultPath, "records", "error-resolutions"),
    join(vaultPath, "records", "turn-summaries"),
    join(vaultPath, "records", "session-summaries"),
    join(vaultPath, "records", "file-activity"),
    join(vaultPath, "concepts"),
    join(vaultPath, "projects"),
    join(vaultPath, "sessions"),
    join(vaultPath, "syntheses"),
    join(vaultPath, "sources"),
    join(vaultPath, "meta"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function isVaultInitialized(vaultPath: string): boolean {
  return existsSync(join(vaultPath, "WIKI_SCHEMA.md")) && existsSync(join(vaultPath, "meta", "registry.json"));
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, { mode: 0o600 });
  }
}

function emptyRegistry(scope: VaultScope, projectId: string | null): VaultRegistry {
  return {
    format: "pi-memory-stone-vault-registry",
    version: VAULT_SCHEMA_VERSION,
    scope,
    project_id: scope === "project" ? projectId : null,
    generated_at: new Date().toISOString(),
    pages: [],
  };
}

function schemaMarkdown(scope: VaultScope): string {
  return [
    "# Memory Stone Vault Schema",
    "",
    "This vault is an Obsidian-compatible markdown projection of pi-memory-stone records.",
    "SQLite remains the source of truth; generated pages may be overwritten by `/memory-vault-sync`.",
    "",
    "## Layout",
    "",
    "```txt",
    ".memory-stone/vault/ or ~/.pi/agent/memory/vaults/personal/",
    "  index.md",
    "  records/",
    "    decisions/",
    "    preferences/",
    "    tasks/",
    "    error-resolutions/",
    "    turn-summaries/",
    "    session-summaries/",
    "  concepts/",
    "  projects/",
    "  sessions/",
    "  syntheses/",
    "  sources/",
    "  meta/registry.json",
    "```",
    "",
    "## Scope",
    "",
    `This vault was initialized as a \`${scope}\` vault.`,
    "",
    "## Generated pages",
    "",
    "Generated pages include frontmatter with `generated: true` and `source: pi-memory-stone`.",
    "Use human-authored pages outside `records/` or clear `generated` before treating edits as durable.",
    "",
  ].join("\n");
}

function indexMarkdown(scope: VaultScope, projectId: string | null, pages: VaultRegistryPage[]): string {
  const byKind = new Map<string, number>();
  for (const page of pages) {
    byKind.set(page.kind, (byKind.get(page.kind) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("# Memory Stone Vault");
  lines.push("");
  lines.push(`Scope: \`${scope}\``);
  if (projectId && scope === "project") lines.push(`Project: \`${projectId}\``);
  lines.push(`Generated pages: ${pages.length}`);
  lines.push("");
  lines.push("## Records by kind");
  lines.push("");
  if (byKind.size === 0) {
    lines.push("_No synced records yet._");
  } else {
    for (const [kind, count] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- [[${kind}]]: ${count}`);
    }
  }
  lines.push("");
  lines.push("## Generated record pages");
  lines.push("");
  for (const page of pages) {
    lines.push(`- [${page.title}](${encodeURI(page.path)})`);
  }
  lines.push("");
  return lines.join("\n");
}

function readRegistry(path: string): VaultRegistry | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VaultRegistry;
    return parsed?.format === "pi-memory-stone-vault-registry" ? parsed : null;
  } catch {
    return null;
  }
}

function countMarkdownFiles(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (stat.isFile() && path.endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count;
}

function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join("/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function relativeVaultPath(vaultPath: string, filePath: string): string {
  return normalizePath(relative(vaultPath, filePath));
}
