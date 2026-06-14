/**
 * Tests for optional Obsidian-compatible memory vault helpers.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbPath, upsertRecord } from "../src/db/index.js";
import { captureUrlToVault } from "../src/vault/capture.js";
import { extractArticle } from "../src/vault/extract.js";
import { parseVaultCaptureIntent } from "../src/vault/intent.js";
import { getVaultStatus, initVault, resolveVaultPath, syncVault } from "../src/vault/index.js";
import { resolveCaptureTargets } from "../src/vault/url-resolvers.js";

const testMemoryDir = mkdtempSync(join(tmpdir(), "pi-memory-stone-vault-"));
process.env.PI_MEMORY_STONE_DB_PATH = join(testMemoryDir, "memory.db");
process.env.PI_MEMORY_STONE_PERSONAL_VAULT_PATH = join(testMemoryDir, "personal-vault");

function cleanDb() {
  const dbPath = getDbPath();
  closeDb();
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

function cleanVaults() {
  rmSync(join(testMemoryDir, "project"), { recursive: true, force: true });
  rmSync(join(testMemoryDir, "personal-vault"), { recursive: true, force: true });
}

describe("memory vault helpers", () => {
  beforeEach(() => {
    cleanDb();
    cleanVaults();
  });

  after(() => {
    cleanDb();
    rmSync(testMemoryDir, { recursive: true, force: true });
  });

  it("resolves project and personal vault paths", () => {
    const project = join(testMemoryDir, "project");
    assert.equal(resolveVaultPath("project", project, "/other/cwd"), join(project, ".memory-stone", "vault"));
    assert.equal(resolveVaultPath("personal", project, "/other/cwd"), join(testMemoryDir, "personal-vault"));
  });

  it("initializes a vault with schema, index, registry, and directories", () => {
    const project = join(testMemoryDir, "project");
    const result = initVault("project", project, project);

    assert.equal(result.created, true);
    assert.equal(existsSync(join(result.path, "WIKI_SCHEMA.md")), true);
    assert.equal(existsSync(join(result.path, "index.md")), true);
    assert.equal(existsSync(join(result.path, "records", "decisions")), true);
    assert.equal(existsSync(join(result.path, "raw")), false);
    assert.equal(existsSync(join(result.path, "meta", "registry.json")), true);

    const second = initVault("project", project, project);
    assert.equal(second.created, false);
  });

  it("syncs project-scoped active records into markdown pages and registry", () => {
    const project = join(testMemoryDir, "project");
    const otherProject = join(testMemoryDir, "other");
    initVault("project", project, project);

    const decisionId = upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: project,
      text: "Adopt optional Obsidian-compatible vaults. api_key = abcdef0123456789XYZ",
      tags: "vault,obsidian",
      importance: 0.8,
    });
    upsertRecord({
      kind: "decision",
      scope: "project",
      project_id: otherProject,
      text: "Other project memory must not be exported here.",
    });
    upsertRecord({
      kind: "preference",
      scope: "global",
      text: "Global memory belongs in the personal vault.",
    });

    const result = syncVault("project", project, project);
    assert.equal(result.records, 1);
    assert.equal(result.pagesWritten, 1);

    const pagePath = join(result.path, "records", "decisions", `${decisionId}.md`);
    const page = readFileSync(pagePath, "utf8");
    assert.match(page, /---\nid: "/);
    assert.match(page, /Adopt optional Obsidian-compatible vaults/);
    assert.match(page, /\[REDACTED:api-key\]/);
    assert.doesNotMatch(page, /abcdef0123456789XYZ/);
    assert.match(page, /#vault #obsidian/);

    const registry = JSON.parse(readFileSync(result.registryPath, "utf8")) as { pages: Array<{ source_record_id: string }> };
    assert.deepEqual(registry.pages.map((page) => page.source_record_id), [decisionId]);

    const status = getVaultStatus("project", project, project);
    assert.equal(status.initialized, true);
    assert.equal(status.recordPageCount, 1);
  });

  it("syncs global records into the personal vault", () => {
    const project = join(testMemoryDir, "project");
    initVault("personal", project, project);

    const globalId = upsertRecord({
      kind: "preference",
      scope: "global",
      text: "Prefer concise memory vault notes.",
      tags: "vault",
    });
    upsertRecord({
      kind: "task",
      scope: "project",
      project_id: project,
      text: "Project task should not go to personal vault.",
    });

    const result = syncVault("personal", project, project);
    assert.equal(result.records, 1);
    assert.equal(existsSync(join(result.path, "records", "preferences", `${globalId}.md`)), true);
  });

  it("requires explicit init before sync", () => {
    const project = join(testMemoryDir, "project");
    assert.throws(() => syncVault("project", project, project), /not initialized/);
  });

  it("resolves GitHub gist pages to raw capture candidates", () => {
    const targets = resolveCaptureTargets("https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f");

    assert.equal(targets.candidates[0].strategy, "gist-raw");
    assert.equal(targets.candidates[0].kind, "markdown");
    assert.equal(targets.candidates[0].url, "https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw");
    assert.equal(targets.candidates.some((candidate) => candidate.strategy === "direct"), true);
  });

  it("captures a web page URL into sources, external source packet, and registry", async () => {
    const project = join(testMemoryDir, "project");
    const { url, close } = await serveHtml(`<!doctype html>
      <html><head><title>Vault Capture Article</title><style>.x{}</style></head>
      <body><h1>Vault Capture Article</h1><p>Capture this article. api_key = abcdef0123456789XYZ</p><script>bad()</script></body></html>`);

    try {
      const result = await captureUrlToVault("project", project, project, url);
      assert.equal(result.initialized, true);
      assert.equal(existsSync(result.pagePath), true);
      assert.equal(result.sourcePacketPath.startsWith(join(project, ".memory-stone", "source-packets")), true);
      assert.equal(existsSync(join(result.vaultPath, "raw")), false);
      assert.equal(existsSync(join(result.sourcePacketPath, "manifest.json")), true);
      assert.equal(existsSync(join(result.sourcePacketPath, "extracted.md")), true);

      const page = readFileSync(result.pagePath, "utf8");
      assert.match(page, /# Vault Capture Article/);
      assert.match(page, /Capture this article/);
      assert.match(page, /\[REDACTED:api-key\]/);
      assert.doesNotMatch(page, /abcdef0123456789XYZ/);
      assert.doesNotMatch(page, /bad\(\)/);

      const registry = JSON.parse(readFileSync(join(result.vaultPath, "meta", "registry.json"), "utf8")) as {
        pages: Array<{ kind: string; source_url?: string }>;
      };
      assert.equal(registry.pages.length, 1);
      assert.equal(registry.pages[0].kind, "web_source");
      assert.equal(registry.pages[0].source_url, url);
    } finally {
      await close();
    }
  });

  it("uses article extraction instead of capturing navigation boilerplate", async () => {
    const project = join(testMemoryDir, "project");
    const articleParagraph = "This is durable article content about reliable source capture. ".repeat(12);
    const { url, close } = await serveHtml(`<!doctype html>
      <html><head><title>Boilerplate Site</title><meta name="author" content="A. Writer"></head>
      <body>
        <nav><a href="/home">Home</a><a href="/pricing">Pricing</a><a href="/login">Login</a></nav>
        <article>
          <h1>Reliable Capture</h1>
          <p>${articleParagraph}</p>
          <p>${articleParagraph}</p>
          <p>${articleParagraph}</p>
        </article>
        <footer>Footer links and unrelated boilerplate should not become the captured article.</footer>
      </body></html>`);

    try {
      const result = await captureUrlToVault("project", project, project, url);
      const page = readFileSync(result.pagePath, "utf8");
      const manifest = JSON.parse(readFileSync(join(result.sourcePacketPath, "manifest.json"), "utf8")) as {
        attempts: Array<{ status: number; strategy: string }>;
        extraction: { extractor: string; strategy: string };
        quality: { quality: string };
      };

      assert.equal(result.quality, "good");
      assert.match(page, /Reliable Capture/);
      assert.match(page, /durable article content/);
      assert.doesNotMatch(page, /Pricing/);
      assert.doesNotMatch(page, /Footer links/);
      assert.equal(manifest.extraction.extractor, "html-readability");
      assert.equal(manifest.extraction.strategy, "direct");
      assert.equal(manifest.quality.quality, "good");
      assert.equal(manifest.attempts[0].status, 200);
    } finally {
      await close();
    }
  });

  it("normalizes image-only links for Obsidian rendering", () => {
    const article = extractArticle({
      raw: `<!doctype html><html><body><article>
        <h1>Image Article</h1>
        <a href="https://example.com/full.jpg"><img src="https://example.com/thumb.jpg" alt="Article diagram"></a>
        <p>${"Readable article body. ".repeat(40)}</p>
      </article></body></html>`,
      contentType: "text/html; charset=utf-8",
      url: "https://example.com/article",
      candidateKind: "html",
    });

    assert.match(article.markdown, /!\[Article diagram\]\(https:\/\/example\.com\/thumb\.jpg\)/);
    assert.doesNotMatch(article.markdown, /\[\s*!\[Article diagram\]/);
    assert.doesNotMatch(article.markdown, /\]\(https:\/\/example\.com\/full\.jpg\)/);
  });

  it("preserves raw markdown articles and stores extraction metadata", async () => {
    const project = join(testMemoryDir, "project");
    const markdown = [
      "# Markdown Article",
      "",
      "A pattern for building reliable article capture. ".repeat(20),
      "",
      "## Details",
      "",
      "The raw markdown path should not be treated as a generic HTML page. ".repeat(20),
      "",
    ].join("\n");
    const { url, close } = await serveContent(markdown, "text/markdown; charset=utf-8", "/post.md");

    try {
      const result = await captureUrlToVault("project", project, project, url);
      const extracted = readFileSync(join(result.sourcePacketPath, "extracted.md"), "utf8");
      const metadata = JSON.parse(readFileSync(join(result.sourcePacketPath, "metadata.json"), "utf8")) as {
        title: string;
        extractor: string;
        quality: { quality: string };
      };

      assert.equal(result.title, "Markdown Article");
      assert.equal(result.quality, "good");
      assert.match(extracted, /^# Markdown Article/);
      assert.equal(metadata.extractor, "markdown");
      assert.equal(metadata.quality.quality, "good");
    } finally {
      await close();
    }
  });

  it("parses natural-language vault capture requests", () => {
    const intent = parseVaultCaptureIntent("Capture this article into vault https://example.com/post --personal");
    assert.deepEqual(intent, { url: "https://example.com/post", scope: "personal" });
    assert.deepEqual(
      parseVaultCaptureIntent("Add to personal memory vault article https://example.com/post"),
      { url: "https://example.com/post", scope: "personal" },
    );
    assert.deepEqual(
      parseVaultCaptureIntent("Save https://example.com/post to global memory vault"),
      { url: "https://example.com/post", scope: "personal" },
    );
    assert.equal(parseVaultCaptureIntent("Please read https://example.com/post"), null);
  });
});

async function serveHtml(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return serveContent(html, "text/html; charset=utf-8", "/article");
}

async function serveContent(content: string, contentType: string, path: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": contentType });
    res.end(content);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}
