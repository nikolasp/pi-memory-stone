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
export const MAX_RETRIEVAL_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = MAX_RETRIEVAL_LIMIT * 10;

function recencyDecay(createdAt: number): number {
  const age = Date.now() - createdAt;
  return Math.exp(-Math.log(2) * (age / RECENCY_HALF_LIFE_MS));
}

// ─── Query builder ──────────────────────────────────────────────────

export function buildSearchQuery(userPrompt: string): string {
  // User prompt terms (take first ~200 chars)
  return userPrompt.slice(0, 200);
}

function recentFileSearchQuery(recentFiles: string[]): string {
  const terms = new Set<string>();

  for (const file of recentFiles) {
    const baseName = file.split(/[\\/]/).pop()?.trim();
    if (!baseName) continue;

    const stem = baseName.replace(/\.[^.]+$/, "");
    const term = stem.length >= 3 ? stem : baseName;
    if (term.length >= 3) terms.add(term);
  }

  return Array.from(terms).slice(0, 10).join(" ");
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
  recentFiles: string[] = [],
): RankedResult[] {
  const results: RankedResult[] = [];

  // Pre-compute recent file basenames for fast matching
  const recentBaseNames = new Set(recentFiles.map((f) => f.split("/").pop()?.toLowerCase()).filter(Boolean) as string[]);

  for (const rec of records) {
    // Skip non-active records
    if (rec.status !== "active") continue;

    // Cross-project/global filter. Global records are cross-project by definition
    // and require explicit cross-project retrieval.
    if (rec.scope === "global") {
      if (!crossProjectEnabled) continue;
    } else if (!rec.project_id || !currentProjectId || rec.project_id !== currentProjectId) {
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

    // Recent file boost: prefer records that mention files the user recently touched
    if (recentBaseNames.size > 0) {
      const recordText = rec.text.toLowerCase();
      for (const baseName of recentBaseNames) {
        if (recordText.includes(baseName)) {
          score *= 1.3;
          reasons.push("recent-file");
          break;
        }
      }
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

export function normalizeRetrievalLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(MAX_RETRIEVAL_LIMIT, numeric));
}

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
  const limit = normalizeRetrievalLimit(opts?.limit, config.maxInjectedRecords);
  const crossProject = opts?.crossProjectEnabled ?? config.crossProjectEnabled;

  const query = buildSearchQuery(userPrompt);

  // Get more candidates than needed (ranking will filter), but keep local work bounded.
  const candidateLimit = Math.min(MAX_CANDIDATE_LIMIT, limit * 10);
  const promptCandidates = searchRecordsFts(
    query,
    candidateLimit,
    opts?.kindFilter,
    opts?.scopeFilter,
    currentProjectId ?? undefined,
  );

  // Recent-file matches need their own candidate query. Applying a boost after
  // FTS selection is not enough: memories that only match a recently touched
  // file would otherwise never reach rankAndFilter().
  const recentQuery = recentFileSearchQuery(recentFiles);
  const recentCandidates = recentQuery
    ? searchRecordsFts(
        recentQuery,
        candidateLimit,
        opts?.kindFilter,
        opts?.scopeFilter,
        currentProjectId ?? undefined,
        undefined,
        true,
      )
    : [];

  const candidatesById = new Map<string, RecordRow & { rank: number }>();
  for (const candidate of [...promptCandidates, ...recentCandidates]) {
    const existing = candidatesById.get(candidate.id);
    if (!existing || candidate.rank < existing.rank) {
      candidatesById.set(candidate.id, candidate);
    }
  }

  const ranked = rankAndFilter(Array.from(candidatesById.values()), currentProjectId, crossProject, recentFiles);

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
