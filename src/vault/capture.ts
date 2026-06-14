/** URL capture for memory vault source pages. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { redactSecrets } from "../privacy/index.js";
import { initVault, getVaultStatus, type VaultRegistry, type VaultRegistryPage } from "./index.js";
import { sanitizeSlug } from "./markdown.js";
import { resolveSourcePacketPath, resolveVaultPath, type VaultScope } from "./paths.js";
import { extractArticle, type ExtractedArticle } from "./extract.js";
import { assessCaptureQuality, type CaptureQuality, type CaptureQualityReport } from "./quality.js";
import { fetchCandidate, type CaptureFetchAttempt, type CaptureFetchOptions, type FetchedCandidate } from "./fetch.js";
import { resolveCaptureTargets, type CaptureCandidate } from "./url-resolvers.js";

const MAX_EXTRACTED_CHARS = 200_000;

export interface CaptureUrlOptions extends CaptureFetchOptions {}

export interface CaptureUrlResult {
  vaultPath: string;
  pagePath: string;
  sourcePacketPath: string;
  title: string;
  url: string;
  finalUrl: string;
  initialized: boolean;
  quality: CaptureQuality;
  qualityScore: number;
  warnings: string[];
}

export async function captureUrlToVault(
  scope: VaultScope,
  projectId: string | null,
  cwd: string,
  url: string,
  options: CaptureUrlOptions = {},
): Promise<CaptureUrlResult> {
  const targets = resolveCaptureTargets(url);
  const vaultPath = resolveVaultPath(scope, projectId, cwd);
  const wasInitialized = getVaultStatus(scope, projectId, cwd).initialized;
  if (!wasInitialized) {
    initVault(scope, projectId, cwd);
  }

  const selected = await fetchAndExtractBest(targets.candidates, options);
  const title = selected.extracted.title || new URL(selected.fetched.finalUrl).hostname;
  const slug = sanitizeSlug(title).slice(0, 70) || "captured-page";
  const captureId = `SRC-${new Date().toISOString().slice(0, 10)}-${sha256(targets.originalUrl).slice(0, 8)}`;
  const packetPath = resolveSourcePacketPath(scope, projectId, cwd, captureId);
  const packetRelPath = normalizePath(relative(vaultPath, packetPath));
  const sourcePageRelPath = join("sources", `${slug}-${sha256(targets.originalUrl).slice(0, 8)}.md`);
  const sourcePagePath = join(vaultPath, sourcePageRelPath);

  mkdirSync(join(packetPath, "original"), { recursive: true, mode: 0o700 });
  mkdirSync(join(packetPath, "attachments"), { recursive: true, mode: 0o700 });
  mkdirSync(join(vaultPath, "sources"), { recursive: true, mode: 0o700 });

  const capturedAt = new Date().toISOString();
  const originalName = originalArtifactName(selected.fetched.contentType, selected.fetched.finalUrl, selected.extracted.extractor);
  const extractedMarkdown = unescapeRedactionMarkers(redactSecrets(selected.extracted.markdown)).slice(0, MAX_EXTRACTED_CHARS);
  const redactedRaw = redactSecrets(selected.fetched.raw);
  const contentHash = sha256(extractedMarkdown);

  const manifest = {
    id: captureId,
    url: targets.originalUrl,
    canonical_url: selected.extracted.canonicalUrl ?? selected.fetched.finalUrl,
    final_url: selected.fetched.finalUrl,
    title,
    byline: selected.extracted.byline,
    site_name: selected.extracted.siteName,
    excerpt: selected.extracted.excerpt,
    published_at: selected.extracted.publishedAt,
    content_type: selected.fetched.contentType,
    captured_at: capturedAt,
    original: `original/${originalName}`,
    extracted: "extracted.md",
    metadata: "metadata.json",
    attempts: selected.attempts,
    extraction: {
      extractor: selected.extracted.extractor,
      strategy: selected.fetched.candidate.strategy,
      candidate_kind: selected.fetched.candidate.kind,
    },
    quality: selected.quality,
    content_hash: contentHash,
  };

  const metadata = {
    title,
    byline: selected.extracted.byline,
    site_name: selected.extracted.siteName,
    excerpt: selected.extracted.excerpt,
    published_at: selected.extracted.publishedAt,
    source_url: targets.originalUrl,
    canonical_url: selected.extracted.canonicalUrl ?? selected.fetched.finalUrl,
    final_url: selected.fetched.finalUrl,
    content_hash: contentHash,
    extractor: selected.extracted.extractor,
    fetch_strategy: selected.fetched.candidate.strategy,
    quality: selected.quality,
  };

  writeFileSync(join(packetPath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(packetPath, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(packetPath, "original", originalName), redactedRaw, { mode: 0o600 });
  writeFileSync(join(packetPath, "extracted.md"), extractedMarkdown, { mode: 0o600 });

  const pageMarkdown = renderSourcePage({
    title,
    url: targets.originalUrl,
    canonicalUrl: selected.extracted.canonicalUrl ?? selected.fetched.finalUrl,
    capturedAt,
    captureId,
    packetRelPath,
    extractedMarkdown,
    quality: selected.quality,
    warnings: selected.quality.warnings,
  });
  writeFileSync(sourcePagePath, pageMarkdown, { mode: 0o600 });

  updateRegistry(vaultPath, {
    path: normalizePath(sourcePageRelPath),
    title,
    kind: "web_source",
    source_url: targets.originalUrl,
    source_packet: packetRelPath,
    content_hash: sha256(pageMarkdown),
    generated: true,
    created_at: capturedAt,
    updated_at: capturedAt,
  });

  return {
    vaultPath,
    pagePath: sourcePagePath,
    sourcePacketPath: packetPath,
    title,
    url: targets.originalUrl,
    finalUrl: selected.fetched.finalUrl,
    initialized: !wasInitialized,
    quality: selected.quality.quality,
    qualityScore: selected.quality.score,
    warnings: selected.quality.warnings,
  };
}

interface ExtractedCandidate {
  fetched: FetchedCandidate;
  extracted: ExtractedArticle;
  quality: CaptureQualityReport;
  attempts: CaptureFetchAttempt[];
}

async function fetchAndExtractBest(candidates: CaptureCandidate[], options: CaptureUrlOptions): Promise<ExtractedCandidate> {
  const allAttempts: CaptureFetchAttempt[] = [];
  let best: ExtractedCandidate | null = null;
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const fetched = await fetchCandidate(candidate, options);
      allAttempts.push(...fetched.attempts);
      const redactedRaw = redactSecrets(fetched.raw);
      const extracted = extractArticle({
        raw: redactedRaw,
        contentType: fetched.contentType,
        url: fetched.finalUrl,
        candidateKind: candidate.kind,
      });
      const quality = assessCaptureQuality({
        title: extracted.title,
        markdown: extracted.markdown,
        extractor: extracted.extractor,
      });
      const current: ExtractedCandidate = { fetched, extracted, quality, attempts: [...allAttempts] };
      if (!best || current.quality.score > best.quality.score) best = current;
      if (quality.quality === "good") return current;
    } catch (error) {
      const attempts = (error as Error & { attempts?: CaptureFetchAttempt[] }).attempts;
      if (attempts) allAttempts.push(...attempts);
      errors.push(`${candidate.strategy}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (best) return { ...best, attempts: allAttempts };
  throw new Error(`Unable to fetch article. Attempts failed: ${errors.join("; ")}`);
}

function renderSourcePage(input: {
  title: string;
  url: string;
  canonicalUrl: string;
  capturedAt: string;
  captureId: string;
  packetRelPath: string;
  extractedMarkdown: string;
  quality: CaptureQualityReport;
  warnings: string[];
}): string {
  const warningLines = input.warnings.length > 0
    ? ["", "Warnings:", ...input.warnings.map((warning) => `- ${warning}`)]
    : [];

  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    "kind: web_source",
    `source_url: ${JSON.stringify(input.url)}`,
    `canonical_url: ${JSON.stringify(input.canonicalUrl)}`,
    `source_packet: ${JSON.stringify(input.packetRelPath)}`,
    `captured_at: ${JSON.stringify(input.capturedAt)}`,
    `capture_id: ${JSON.stringify(input.captureId)}`,
    `quality: ${JSON.stringify(input.quality.quality)}`,
    `quality_score: ${input.quality.score}`,
    "generated: true",
    "source: pi-memory-stone",
    "---",
    "",
    `# ${input.title.replace(/[\r\n]+/g, " ").trim()}`,
    "",
    `Source: ${input.url}`,
    `Canonical: ${input.canonicalUrl}`,
    `Captured: ${input.capturedAt}`,
    `Quality: ${input.quality.quality} (${input.quality.score})`,
    `Source packet: ${input.captureId} (stored outside vault: ${input.packetRelPath})`,
    ...warningLines,
    "",
    "## Extracted text",
    "",
    input.extractedMarkdown.trim() || "_No text extracted._",
    "",
  ].join("\n");
}

function updateRegistry(vaultPath: string, page: VaultRegistryPage & {
  source_url: string;
  source_packet: string;
}): void {
  const registryPath = join(vaultPath, "meta", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as VaultRegistry;
  const pages = registry.pages.filter((existing) => existing.path !== page.path);
  pages.push(page);
  pages.sort((a, b) => a.path.localeCompare(b.path));
  registry.pages = pages;
  registry.generated_at = new Date().toISOString();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
}

function originalArtifactName(contentType: string, finalUrl: string, extractor: string): string {
  if (contentType.includes("html") || extractor.startsWith("html")) return "response.html";
  if (contentType.includes("markdown") || finalUrl.toLowerCase().match(/\.(md|markdown|mdx)(?:$|[?#])/) || extractor === "markdown") return "response.md";
  if (contentType.includes("pdf") || finalUrl.toLowerCase().match(/\.pdf(?:$|[?#])/)) return "response.pdf.txt";
  return "response.txt";
}

function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join("/");
}

function unescapeRedactionMarkers(markdown: string): string {
  return markdown.replace(/\\\[REDACTED:([a-z-]+)\\\]/g, "[REDACTED:$1]");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
