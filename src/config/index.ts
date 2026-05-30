/**
 * Configuration module.
 * Project identity defaults to git repo root.
 * Reads .pi/settings.json for memory.* config overrides.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Project identity ───────────────────────────────────────────────

let _gitRootCache: Map<string, string | null> = new Map();

export function getProjectId(cwd: string): string | null {
  // Use git repo root as project identity
  if (_gitRootCache.has(cwd)) {
    return _gitRootCache.get(cwd) ?? null;
  }

  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    _gitRootCache.set(cwd, root);
    return root;
  } catch {
    // Not a git repo; use cwd as fallback
    _gitRootCache.set(cwd, cwd);
    return cwd;
  }
}

export function clearProjectCache(): void {
  _gitRootCache.clear();
}

// ─── Config ─────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Whether memory injection is enabled */
  enabled: boolean;
  /** Max records to inject per turn */
  maxInjectedRecords: number;
  /** Max tokens for injected packet */
  maxInjectedTokens: number;
  /** Minimum score threshold for injection */
  scoreThreshold: number;
  /** Whether cross-project injection is enabled */
  crossProjectEnabled: boolean;
  /** Extra ignore patterns */
  ignorePatterns: string[];
}

const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  maxInjectedRecords: 5,
  maxInjectedTokens: 1000,
  scoreThreshold: 0.3,
  crossProjectEnabled: false,
  ignorePatterns: [],
};

const _configCache: Map<string, MemoryConfig> = new Map();

export function getConfig(cwd: string = process.cwd()): MemoryConfig {
  const cacheKey = cwd;
  const cached = _configCache.get(cacheKey);
  if (cached) return cached;

  // Try loading from project .pi/settings.json
  const projectSettings = join(cwd, ".pi", "settings.json");

  if (existsSync(projectSettings)) {
    try {
      const raw = readFileSync(projectSettings, "utf8");
      const settings = JSON.parse(raw);
      if (settings.memory) {
        const config = { ...DEFAULT_CONFIG, ...settings.memory };
        _configCache.set(cacheKey, config);
        return config;
      }
    } catch {
      // Invalid JSON, use defaults
    }
  }

  const config = { ...DEFAULT_CONFIG };
  _configCache.set(cacheKey, config);
  return config;
}

export function reloadConfig(): void {
  _configCache.clear();
}

// ─── Environment ────────────────────────────────────────────────────

export function getHomeDir(): string {
  return homedir() || "/tmp";
}

export function getMemoryDir(): string {
  return `${getHomeDir()}/.pi/agent/memory`;
}
