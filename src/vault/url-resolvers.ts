/** URL normalization and article-capture candidate resolution. */

export type CaptureCandidateKind = "html" | "markdown" | "text" | "pdf" | "unknown";

export interface CaptureCandidate {
  url: string;
  kind: CaptureCandidateKind;
  strategy: string;
  priority: number;
}

export interface CaptureTargets {
  originalUrl: string;
  canonicalUrl: string;
  candidates: CaptureCandidate[];
}

export function resolveCaptureTargets(inputUrl: string): CaptureTargets {
  const parsed = parseHttpUrl(inputUrl);
  const candidates: CaptureCandidate[] = [];

  const gistRaw = resolveGistRaw(parsed);
  if (gistRaw) {
    candidates.push({ url: gistRaw, kind: "markdown", strategy: "gist-raw", priority: 100 });
  }

  const githubRaw = resolveGithubRaw(parsed);
  if (githubRaw) {
    candidates.push({ url: githubRaw.url, kind: githubRaw.kind, strategy: "github-raw", priority: 95 });
  }

  candidates.push({
    url: parsed.href,
    kind: inferKind(parsed.href),
    strategy: "direct",
    priority: 10,
  });

  const deduped = dedupeCandidates(candidates)
    .sort((a, b) => b.priority - a.priority);

  return {
    originalUrl: parsed.href,
    canonicalUrl: deduped[0]?.url ?? parsed.href,
    candidates: deduped,
  };
}

export function parseHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs can be captured");
  }
  return parsed;
}

function resolveGistRaw(url: URL): string | null {
  if (url.hostname === "gist.githubusercontent.com" && url.pathname.includes("/raw")) {
    return url.href;
  }
  if (url.hostname !== "gist.github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const [owner, gistId] = parts;
  if (!owner || !gistId) return null;

  return `https://gist.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(gistId)}/raw`;
}

function resolveGithubRaw(url: URL): { url: string; kind: CaptureCandidateKind } | null {
  if (url.hostname === "raw.githubusercontent.com") {
    return { url: url.href, kind: inferKind(url.href) };
  }
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5) return null;

  const [owner, repo, mode, branch, ...fileParts] = parts;
  if (!owner || !repo || !branch || fileParts.length === 0) return null;
  if (mode !== "blob" && mode !== "raw") return null;

  const rawUrl = new URL(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${fileParts.map(encodeURIComponent).join("/")}`);
  rawUrl.search = url.search;
  return { url: rawUrl.href, kind: inferKind(rawUrl.href) };
}

function inferKind(url: string): CaptureCandidateKind {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".markdown") || path.endsWith(".mdx")) return "markdown";
  if (path.endsWith(".txt") || path.endsWith(".text")) return "text";
  if (path.endsWith(".pdf")) return "pdf";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  return "unknown";
}

function dedupeCandidates(candidates: CaptureCandidate[]): CaptureCandidate[] {
  const seen = new Set<string>();
  const deduped: CaptureCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  return deduped;
}
