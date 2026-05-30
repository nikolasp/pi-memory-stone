/**
 * Retrieval and ranking module.
 * Hybrid ranking: FTS score + same-project boost + recency decay + kind boost.
 */

import type { RecordRow } from "../db/index.js";
import type { RecordKind, RecordScope } from "../db/schema.js";
import { searchRecordsFts } from "../db/index.js";
import { getConfig } from "../config/index.js";

// ─── Kind boosts ────────────────────────────────────────────────────

const KIND_BOOST: Record<string, number> = {
  decision: 1.5,
  preference: 1.3,
  error_resolution: 1.4,
  task: 1.1,
  turn_summary: 0.9,
  session_summary: 0.8,
  file_activity: 0.5,
};

// ─── Recency decay ──────────────────────────────────────────────────

const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function recencyDecay(createdAt: number): number {
  const age = Date.now() - createdAt;
  return Math.exp(-Math.log(2) * (age / RECENCY_HALF_LIFE_MS));
}

// ─── Query builder ──────────────────────────────────────────────────

export function buildSearchQuery(
  userPrompt: string,
  recentFiles: string[] = [],
): string {
  const parts: string[] = [];

  // User prompt terms (take first ~200 chars)
  parts.push(userPrompt.slice(0, 200));

  // Recent files (just filenames, not full paths)
  for (const f of recentFiles.slice(0, 5)) {
    const basename = f.split("/").pop() || f;
    parts.push(basename);
  }

  return parts.join(" ");
}

// ─── Ranking ────────────────────────────────────────────────────────

export interface RankedResult {
  record: RecordRow;
  score: number;
  reasons: string[];
}

export function rankAndFilter(
  records: (RecordRow & { rank: number })[],
  currentProjectId: string | null,
  crossProjectEnabled: boolean,
): RankedResult[] {
  const results: RankedResult[] = [];

  for (const rec of records) {
    // Skip non-active records
    if (rec.status !== "active") continue;

    // Cross-project/global filter. Global records are cross-project by definition
    // and require explicit cross-project retrieval.
    if (rec.scope === "global") {
      if (!crossProjectEnabled) continue;
    } else if (rec.project_id && currentProjectId && rec.project_id !== currentProjectId) {
      continue;
    }

    // Compute hybrid score
    let score = 1.0 / (1.0 + (rec.rank ?? 0)); // Normalize FTS rank: lower rank = better

    // Same project boost
    const reasons: string[] = [];
    if (rec.project_id && currentProjectId && rec.project_id === currentProjectId) {
      score *= 1.5;
      reasons.push("same-project");
    }

    // Global preference boost
    if (rec.scope === "global") {
      score *= 1.2;
      reasons.push("global-preference");
    }

    // Kind boost
    const kindBoost = KIND_BOOST[rec.kind] ?? 1.0;
    score *= kindBoost;
    if (kindBoost !== 1.0) reasons.push(`kind:${rec.kind}`);

    // Recency decay
    const decay = recencyDecay(rec.created_at);
    score *= decay;

    // Confidence multiplier
    score *= rec.confidence;

    // Importance multiplier
    score *= 0.5 + rec.importance; // Scale: 0.5-1.5

    results.push({ record: rec, score, reasons });
  }

  // Sort by score descending, then recency
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.record.created_at - a.record.created_at;
  });

  return results;
}

// ─── Full retrieval pipeline ────────────────────────────────────────

export function retrieve(
  userPrompt: string,
  currentProjectId: string | null,
  recentFiles: string[] = [],
  opts?: {
    limit?: number;
    crossProjectEnabled?: boolean;
    kindFilter?: RecordKind[];
    scopeFilter?: RecordScope[];
  },
): RankedResult[] {
  const config = getConfig();
  const limit = opts?.limit ?? config.maxInjectedRecords;
  const crossProject = opts?.crossProjectEnabled ?? config.crossProjectEnabled;

  const query = buildSearchQuery(userPrompt, recentFiles);

  // Get more candidates than needed (ranking will filter)
  const candidates = searchRecordsFts(query, limit * 10, opts?.kindFilter, opts?.scopeFilter);

  const ranked = rankAndFilter(candidates, currentProjectId, crossProject);

  // Return top results
  return ranked.slice(0, limit);
}

// ─── Injection packet builder ────────────────────────────────────────

export interface InjectionPacket {
  header: string;
  items: Array<{
    ref: string;
    kind: string;
    text: string;
    project?: string;
    staleHint?: string;
  }>;
  footer: string;
  recordCount: number;
}

export function buildInjectionPacket(results: RankedResult[]): InjectionPacket {
  const items: InjectionPacket["items"] = [];

  for (const r of results) {
    const age = Date.now() - r.record.created_at;
    const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
    let staleHint: string | undefined;

    if (ageDays > 30) {
      staleHint = `⚠️ This memory is ${ageDays} days old and may be stale.`;
    } else if (ageDays > 7) {
      staleHint = `📅 From ${ageDays} days ago.`;
    }

    items.push({
      ref: r.record.id,
      kind: r.record.kind,
      text: r.record.text,
      project: r.record.project_id === null ? "global" : undefined,
      staleHint,
    });
  }

  return {
    header: `Memory: loaded ${items.length} relevant items from past sessions. These may help provide context.`,
    items,
    footer:
      "Use memory_open with a ref for full text. If any memory is irrelevant or conflicting, mention it and I can /memory-forget <ref> it.",
    recordCount: items.length,
  };
}

export function formatInjectionForLlm(packet: InjectionPacket, maxTokens = 1000): string {
  const lines: string[] = [packet.header, ""];

  // Rough token estimate: ~4 chars per token
  let charBudget = maxTokens * 4;
  let usedChars = lines.join("\n").length;

  for (const item of packet.items) {
    const itemHeader = `[${item.kind} ref=${item.ref}]`;
    const itemText = item.text.slice(0, 300); // Truncate per item
    const itemFooter = item.staleHint ? `  ${item.staleHint}` : "";
    const itemLine = `${itemHeader} ${itemText}${itemFooter}`;

    if (usedChars + itemLine.length > charBudget) break;
    lines.push(itemLine);
    usedChars += itemLine.length + 1;
  }

  lines.push("");
  lines.push(packet.footer);

  return lines.join("\n");
}
