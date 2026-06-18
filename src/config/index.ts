/**
 * Configuration module.
 * Project identity defaults to git repo root.
 * Reads .pi/settings.json for memory.* config overrides.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InjectionMode } from "../session-state/index.js";

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
  /** Search-based automatic injection, or only explicit /memory-inject refs */
  injectionMode: InjectionMode;
  /** Extra ignore patterns */
  ignorePatterns: string[];
}

const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  maxInjectedRecords: 5,
  maxInjectedTokens: 1000,
  scoreThreshold: 0.3,
  crossProjectEnabled: false,
  injectionMode: "auto",
  ignorePatterns: [],
};

const _configCache: Map<string, MemoryConfig> = new Map();

/** Track .pi/settings.json mtimes per project for change detection */
const _configMtimes: Map<string, number> = new Map();

function loadConfigFromDisk(projectRoot: string): MemoryConfig {
  const projectSettings = join(projectRoot, ".pi", "settings.json");

  if (existsSync(projectSettings)) {
    try {
      const raw = readFileSync(projectSettings, "utf8");
      const settings = JSON.parse(raw);
      if (settings.memory) {
        const config = { ...DEFAULT_CONFIG, ...settings.memory };
        if (config.injectionMode !== "auto" && config.injectionMode !== "manual") {
          config.injectionMode = DEFAULT_CONFIG.injectionMode;
        }
        return config;
      }
    } catch {
      // Invalid JSON, use defaults
    }
  }

  return { ...DEFAULT_CONFIG };
}

export function getConfig(cwd: string = process.cwd()): MemoryConfig {
  const projectRoot = getProjectId(cwd) ?? cwd;
  const cacheKey = projectRoot;

  // Check if settings file changed since last load
  const projectSettings = join(projectRoot, ".pi", "settings.json");
  let fileMtime = 0;
  try {
    fileMtime = statSync(projectSettings).mtimeMs;
  } catch {
    // File doesn't exist — use cache if available
  }
  const cachedMtime = _configMtimes.get(cacheKey);

  if (cachedMtime !== undefined && cachedMtime === fileMtime) {
    const cached = _configCache.get(cacheKey);
    if (cached) return cached;
  }

  // Load or reload config from the resolved project root
  const config = loadConfigFromDisk(projectRoot);
  _configCache.set(cacheKey, config);
  if (fileMtime > 0) {
    _configMtimes.set(cacheKey, fileMtime);
  } else {
    _configMtimes.delete(cacheKey);
  }
  return config;
}

export function reloadConfig(): void {
  _configCache.clear();
  _configMtimes.clear();
}

// ─── Environment ────────────────────────────────────────────────────

export function getHomeDir(): string {
  return homedir() || "/tmp";
}

export function getMemoryDir(): string {
  return `${getHomeDir()}/.pi/agent/memory`;
}
