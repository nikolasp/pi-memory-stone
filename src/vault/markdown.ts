/** Markdown rendering helpers for Obsidian-compatible memory vault pages. */

import type { RecordRow } from "../db/index.js";

const KIND_TITLES: Record<string, string> = {
  decision: "Decision",
  preference: "Preference",
  task: "Task",
  error_resolution: "Error Resolution",
  turn_summary: "Turn Summary",
  session_summary: "Session Summary",
  file_activity: "File Activity",
};

export function recordTitle(record: RecordRow): string {
  const prefix = KIND_TITLES[record.kind] ?? record.kind;
  const firstLine = record.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? record.id;
  const cleaned = firstLine.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const excerpt = cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
  return `${prefix}: ${excerpt}`;
}

export function kindDirectory(kind: string): string {
  switch (kind) {
    case "decision": return "decisions";
    case "preference": return "preferences";
    case "task": return "tasks";
    case "error_resolution": return "error-resolutions";
    case "turn_summary": return "turn-summaries";
    case "session_summary": return "session-summaries";
    case "file_activity": return "file-activity";
    default: return sanitizeSlug(kind);
  }
}

export function recordMarkdown(record: RecordRow): string {
  const title = recordTitle(record);
  const tags = parseTags(record.tags);
  const frontmatter = renderFrontmatter({
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    project_id: record.project_id,
    session_id: record.session_id,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
    tags,
    generated: true,
    source: "pi-memory-stone",
  });

  const lines: string[] = [];
  lines.push(frontmatter);
  lines.push(`# ${escapeMarkdownHeading(title)}`);
  lines.push("");
  lines.push(record.text.trim() || "_No memory text captured._");
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Memory ref: \`${record.id}\``);
  lines.push(`- Kind: \`${record.kind}\``);
  lines.push(`- Scope: \`${record.scope}\``);
  if (record.project_id) lines.push(`- Project: \`${record.project_id}\``);
  if (record.session_id) lines.push(`- Session: \`${record.session_id}\``);
  if (tags.length > 0) lines.push(`- Tags: ${tags.map((tag) => `#${sanitizeTag(tag)}`).join(" ")}`);
  lines.push("");
  lines.push("## Links");
  lines.push("");
  lines.push(`- [[${record.kind}]]`);
  lines.push("- [[pi-memory-stone]]");
  lines.push("");

  return lines.join("\n");
}

export function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function sanitizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function sanitizeTag(tag: string): string {
  return tag.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "");
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

type FrontmatterValue = string | number | boolean | null | string[];

function renderFrontmatter(values: Record<string, FrontmatterValue>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => yamlString(item)).join(", ")}]`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
