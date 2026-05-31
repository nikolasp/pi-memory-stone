import type { RecordRow } from "../db/index.js";
import type { RankedResult } from "../retrieval/index.js";

export type InjectionMode = "auto" | "manual";

export const SESSION_TOGGLE_ENTRY = "memory-stone:session-toggle";
export const INJECTION_MODE_ENTRY = "memory-stone:injection-mode";
export const MANUAL_INJECTION_ENTRY = "memory-stone:manual-injection";

export interface MemorySessionState {
  enabled: boolean;
  injectionMode?: InjectionMode;
  manualRefs: string[];
}

export function isInjectionMode(value: unknown): value is InjectionMode {
  return value === "auto" || value === "manual";
}

export function getMemorySessionState(branch: unknown[]): MemorySessionState {
  let enabled = true;
  let injectionMode: InjectionMode | undefined;
  let manualRefs: string[] = [];

  for (const entry of branch) {
    if (!isCustomEntry(entry)) continue;

    if (entry.customType === SESSION_TOGGLE_ENTRY) {
      const data = entry.data as { enabled?: unknown } | undefined;
      if (typeof data?.enabled === "boolean") {
        enabled = data.enabled;
      }
      continue;
    }

    if (entry.customType === INJECTION_MODE_ENTRY) {
      const data = entry.data as { mode?: unknown } | undefined;
      if (isInjectionMode(data?.mode)) {
        injectionMode = data.mode;
      }
      continue;
    }

    if (entry.customType === MANUAL_INJECTION_ENTRY) {
      const data = entry.data as { action?: unknown; refs?: unknown } | undefined;
      if (data?.action === "clear") {
        manualRefs = [];
      } else if (data?.action === "add" && Array.isArray(data.refs)) {
        for (const ref of data.refs) {
          if (typeof ref === "string" && ref.trim() && !manualRefs.includes(ref)) {
            manualRefs.push(ref);
          }
        }
      }
    }
  }

  return { enabled, injectionMode, manualRefs };
}

export function parseRefArgs(args: string): string[] {
  return (args ?? "")
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("--"));
}

export function isRecordVisibleInProject(record: RecordRow, currentProjectId: string | null): boolean {
  return record.scope === "global" || record.project_id === null || record.project_id === currentProjectId;
}

export function manualRecordsToRankedResults(
  records: RecordRow[],
  currentProjectId: string | null,
): RankedResult[] {
  return records
    .filter((record) => record.status === "active" && isRecordVisibleInProject(record, currentProjectId))
    .map((record) => ({
      record,
      score: Number.POSITIVE_INFINITY,
      reasons: ["manual-ref"],
    }));
}

function isCustomEntry(entry: unknown): entry is { type?: string; customType?: string; data?: unknown } {
  return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "custom";
}
