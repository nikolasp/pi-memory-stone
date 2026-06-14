/**
 * Knowledge vault path resolution.
 *
 * Project vaults are opt-in and live inside the current project. Personal
 * vaults stay under pi-memory-stone's private memory directory by default.
 */

import { join } from "node:path";
import { getMemoryDir } from "../config/index.js";

export type VaultScope = "project" | "personal";

export function resolveVaultPath(scope: VaultScope, projectId: string | null, cwd: string): string {
  if (scope === "personal") {
    return process.env.PI_MEMORY_STONE_PERSONAL_VAULT_PATH
      ?? join(getMemoryDir(), "vaults", "personal");
  }

  const root = projectId ?? cwd;
  return join(root, ".memory-stone", "vault");
}

export function isVaultScope(value: string): value is VaultScope {
  return value === "project" || value === "personal";
}

export function parseVaultScope(args: { flags: Set<string>; options: Map<string, string> }): VaultScope | undefined {
  const explicitScope = args.options.get("scope");
  if (explicitScope) {
    return isVaultScope(explicitScope) ? explicitScope : undefined;
  }
  if (args.flags.has("personal")) return "personal";
  if (args.flags.has("project")) return "project";
  return "project";
}
