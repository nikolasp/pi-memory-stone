/**
 * Deterministic JSONL session parser.
 * Extracts structured records from session entries without LLM.
 *
 * Parsed from event data passed to agent_end, or from raw JSONL for backfill.
 */

import type { RecordKind, RecordScope, FileAction } from "../db/schema.js";
import { redactSecrets, shouldIgnoreFile } from "../privacy/index.js";

// ─── Types for parsed session data ──────────────────────────────────

export interface ParsedTurn {
  /** Entry ID of the user message that started this turn */
  userEntryId: string;
  /** Text content of the user prompt */
  userPrompt: string;
  /** Entry IDs of assistant messages in this turn */
  assistantEntryIds: string[];
  /** Concatenated text from assistant responses */
  assistantText: string;
  /** Tool calls in this turn */
  toolCalls: ParsedToolCall[];
  /** Errors encountered in this turn */
  errors: ParsedError[];
}

export interface ParsedToolCall {
  entryId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  /** Result text (truncated) */
  resultText: string;
  isError: boolean;
}

export interface ParsedError {
  entryId: string;
  toolName: string;
  message: string;
}

export interface ParsedFileActivity {
  entryId: string;
  path: string;
  action: FileAction;
}

export interface RecordPayload {
  kind: RecordKind;
  scope: RecordScope;
  text: string;
  tags?: string;
  entryIdStart?: string;
  entryIdEnd?: string;
  fileActivities?: ParsedFileActivity[];
}

// ─── Entry helpers ──────────────────────────────────────────────────

interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Record<string, unknown>;
  customType?: string;
  summary?: string;
  data?: unknown;
}

interface AgentMessage {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  display?: boolean;
}

// ─── Content extraction ─────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function extractToolCalls(content: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>)
    .filter((c) => c.type === "toolCall" && typeof c.name === "string")
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      arguments: (c.arguments as Record<string, unknown>) ?? {},
    }));
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((c) => c.type === "thinking" && typeof c.thinking === "string")
    .map((c) => c.thinking as string)
    .join("\n");
}

// ─── File activity detection ────────────────────────────────────────

function detectFileActivity(
  toolName: string,
  args: Record<string, unknown>,
  entryId: string,
): ParsedFileActivity[] {
  const activities: ParsedFileActivity[] = [];
  const path = typeof args.path === "string" ? args.path : undefined;

  // Skip sensitive files
  if (path && shouldIgnoreFile(path)) return [];

  switch (toolName) {
    case "read":
      if (path) {
        activities.push({ entryId, path, action: "read" });
      }
      break;
    case "write":
      if (path) {
        activities.push({ entryId, path, action: "write" });
      }
      break;
    case "edit":
      if (path) {
        activities.push({ entryId, path, action: "edit" });
      }
      break;
    case "bash": {
      break;
    }
  }

  return activities;
}

function detectBashFileActivity(
  command: string,
  entryId: string,
): ParsedFileActivity[] {
  const activities: ParsedFileActivity[] = [];
  const seen = new Set<string>();

  // Detect file paths in git commands
  const gitFilePattern = /\s([\w.\-/]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|php|css|html|json|yaml|yml|toml|md|sql|sh|bash|zsh))/g;
  let match: RegExpExecArray | null;
  while ((match = gitFilePattern.exec(command)) !== null) {
    const filePath = match[1];
    if (!seen.has(filePath) && !shouldIgnoreFile(filePath)) {
      seen.add(filePath);
      activities.push({ entryId, path: filePath, action: "bash" });
    }
  }

  return activities;
}

// ─── Turn parsing ───────────────────────────────────────────────────

export function parseEntries(entries: SessionEntry[]): {
  turns: ParsedTurn[];
  fileActivities: ParsedFileActivity[];
  compactions: Array<{ entryId: string; summary: string }>;
} {
  const turns: ParsedTurn[] = [];
  const fileActivities: ParsedFileActivity[] = [];
  const compactions: Array<{ entryId: string; summary: string }> = [];

  let currentTurn: ParsedTurn | null = null;

  for (const entry of entries) {
    // Handle compaction entries
    if (entry.type === "compaction" && entry.summary) {
      compactions.push({ entryId: entry.id, summary: entry.summary });
      continue;
    }

    // Handle branch summary entries
    if (entry.type === "branch_summary" && entry.summary) {
      compactions.push({ entryId: entry.id, summary: entry.summary });
      continue;
    }

    // Handle custom_message entries (extension messages)
    if (entry.type === "custom_message") {
      // These participate in context but aren't user messages
      continue;
    }

    // Skip non-message entries
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message as AgentMessage;

    // User message: starts a new turn
    if (msg.role === "user") {
      // Save previous turn if exists
      if (currentTurn) {
        turns.push(currentTurn);
      }

      const userPrompt = redactSecrets(extractText(msg.content));
      currentTurn = {
        userEntryId: entry.id,
        userPrompt,
        assistantEntryIds: [],
        assistantText: "",
        toolCalls: [],
        errors: [],
      };
      continue;
    }

    // Assistant message
    if (msg.role === "assistant") {
      if (!currentTurn) continue;

      currentTurn.assistantEntryIds.push(entry.id);
      const text = extractText(msg.content);
      const thinking = extractThinking(msg.content);
      const toolCalls = extractToolCalls(msg.content);

      for (const call of toolCalls) {
        currentTurn.toolCalls.push({
          entryId: entry.id,
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
          resultText: "",
          isError: false,
        });
        fileActivities.push(...detectFileActivity(call.name, call.arguments, entry.id));
      }

      if (text || thinking) {
        currentTurn.assistantText += (currentTurn.assistantText ? "\n" : "") + (text || thinking);
      }
      continue;
    }

    // Tool result
    if (msg.role === "toolResult") {
      if (!currentTurn) continue;

      const toolName = msg.toolName || "unknown";
      const resultText = extractText(msg.content);

      // Redact
      const redactedResult = redactSecrets(resultText);

      const existingCall = typeof msg.toolCallId === "string"
        ? currentTurn.toolCalls.find((call) => call.toolCallId === msg.toolCallId)
        : undefined;

      const toolCall: ParsedToolCall = existingCall ?? {
        entryId: entry.id,
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
        toolName,
        args: {},
        resultText: "",
        isError: false,
      };
      toolCall.resultText = redactedResult.slice(0, 500); // Truncate for storage
      toolCall.isError = msg.isError === true;
      if (!existingCall) currentTurn.toolCalls.push(toolCall);

      if (toolCall.isError) {
        currentTurn.errors.push({
          entryId: entry.id,
          toolName,
          message: redactedResult.slice(0, 200),
        });
      }
      continue;
    }

    // Bash execution entry
    if (msg.role === "bashExecution") {
      if (!currentTurn) continue;

      const command = (msg as Record<string, unknown>).command as string | undefined;
      if (command) {
        const bashActivities = detectBashFileActivity(command, entry.id);
        fileActivities.push(...bashActivities);
      }
      continue;
    }
  }

  // Save last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return { turns, fileActivities, compactions };
}

// ─── Record generation ──────────────────────────────────────────────

export function turnsToRecords(
  turns: ParsedTurn[],
  projectId: string | null,
  sessionId: string,
  sessionFile: string,
): RecordPayload[] {
  const records: RecordPayload[] = [];

  for (const turn of turns) {
    // Turn summary
    const summaryParts: string[] = [];

    // User prompt
    const truncatedPrompt = turn.userPrompt.length > 500 ? turn.userPrompt.slice(0, 497) + "..." : turn.userPrompt;
    summaryParts.push(`User: ${truncatedPrompt}`);

    // Assistant response
    if (turn.assistantText) {
      const truncatedAssistant = turn.assistantText.length > 800 ? turn.assistantText.slice(0, 797) + "..." : turn.assistantText;
      summaryParts.push(`Assistant: ${truncatedAssistant}`);
    }

    // Tool calls
    if (turn.toolCalls.length > 0) {
      const toolNames = [...new Set(turn.toolCalls.map((tc) => tc.toolName))];
      summaryParts.push(`Tools used: ${toolNames.join(", ")}`);
    }

    // Errors
    if (turn.errors.length > 0) {
      summaryParts.push(`Errors: ${turn.errors.map((e) => `${e.toolName}: ${e.message}`).join("; ")}`);
    }

    const text = redactSecrets(summaryParts.join("\n"));
    if (!text.trim()) continue;

    records.push({
      kind: "turn_summary",
      scope: "project",
      text,
      entryIdStart: turn.userEntryId,
      entryIdEnd: turn.toolCalls.length > 0 ? turn.toolCalls[turn.toolCalls.length - 1].entryId : turn.userEntryId,
    });

    // Error records
    for (const err of turn.errors) {
      records.push({
        kind: "error_resolution",
        scope: "project",
        text: `Tool: ${err.toolName}\nError: ${err.message}`,
        entryIdStart: err.entryId,
        entryIdEnd: err.entryId,
      });
    }
  }

  return records;
}
