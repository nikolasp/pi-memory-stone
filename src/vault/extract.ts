/** Content-type aware article extraction for vault source capture. */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { CaptureCandidateKind } from "./url-resolvers.js";

export type ExtractionKind = "html-readability" | "html-main" | "markdown" | "text" | "pdf-unsupported";

export interface ExtractedArticle {
  title: string;
  markdown: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  extractor: ExtractionKind;
}

export function extractArticle(input: {
  raw: string;
  contentType: string;
  url: string;
  candidateKind: CaptureCandidateKind;
}): ExtractedArticle {
  if (isPdf(input.contentType, input.url, input.candidateKind)) {
    return {
      title: titleFromUrl(input.url),
      markdown: "_PDF capture is not yet supported. Raw response was stored for future extraction._",
      canonicalUrl: input.url,
      extractor: "pdf-unsupported",
    };
  }

  if (isHtml(input.raw, input.contentType, input.candidateKind)) {
    return extractHtml(input.raw, input.url);
  }

  if (isMarkdown(input.contentType, input.url, input.candidateKind)) {
    return extractMarkdown(input.raw, input.url);
  }

  return extractText(input.raw, input.url);
}

function extractHtml(html: string, url: string): ExtractedArticle {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const metadata = htmlMetadata(document, url);

  const reader = new Readability(document.cloneNode(true) as Document);
  const article = reader.parse();
  if (article?.content && (article.textContent ?? "").trim().length > 0) {
    const markdown = htmlFragmentToMarkdown(article.content);
    return {
      title: normalizeWhitespace(article.title || metadata.title || titleFromUrl(url)),
      markdown,
      byline: article.byline || metadata.byline,
      siteName: article.siteName || metadata.siteName,
      excerpt: article.excerpt || metadata.excerpt,
      publishedAt: metadata.publishedAt,
      canonicalUrl: metadata.canonicalUrl,
      extractor: "html-readability",
    };
  }

  const fallbackElement = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  return {
    title: metadata.title || titleFromUrl(url),
    markdown: htmlFragmentToMarkdown(fallbackElement?.innerHTML ?? html),
    byline: metadata.byline,
    siteName: metadata.siteName,
    excerpt: metadata.excerpt,
    publishedAt: metadata.publishedAt,
    canonicalUrl: metadata.canonicalUrl,
    extractor: "html-main",
  };
}

function extractMarkdown(markdown: string, url: string): ExtractedArticle {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]
    ?? markdown.match(/^title:\s*["']?(.+?)["']?\s*$/im)?.[1]
    ?? titleFromUrl(url);
  return {
    title: normalizeWhitespace(stripMarkdown(title)),
    markdown: markdown.trim(),
    canonicalUrl: url,
    extractor: "markdown",
  };
}

function extractText(text: string, url: string): ExtractedArticle {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    title: normalizeWhitespace(lines[0] || titleFromUrl(url)),
    markdown: text.trim(),
    canonicalUrl: url,
    extractor: "text",
  };
}

function htmlMetadata(document: Document, url: string): Omit<ExtractedArticle, "markdown" | "extractor"> {
  const jsonLd = parseJsonLd(document);
  const title = meta(document, "property", "og:title")
    ?? meta(document, "name", "twitter:title")
    ?? document.querySelector("title")?.textContent
    ?? document.querySelector("h1")?.textContent
    ?? jsonLd?.headline
    ?? titleFromUrl(url);

  return {
    title: normalizeWhitespace(title),
    byline: meta(document, "name", "author") ?? jsonLd?.author,
    siteName: meta(document, "property", "og:site_name"),
    excerpt: meta(document, "name", "description") ?? meta(document, "property", "og:description"),
    publishedAt: meta(document, "property", "article:published_time") ?? jsonLd?.datePublished,
    canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href
      ?? meta(document, "property", "og:url")
      ?? url,
  };
}

function parseJsonLd(document: Document): { headline?: string; author?: string; datePublished?: string } | null {
  for (const script of [...document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')]) {
    try {
      const parsed = JSON.parse(script.textContent || "null") as unknown;
      const objects = Array.isArray(parsed) ? parsed : [parsed];
      for (const object of objects) {
        if (!object || typeof object !== "object") continue;
        const record = object as Record<string, unknown>;
        const author = record.author;
        return {
          headline: stringValue(record.headline ?? record.name),
          author: typeof author === "string"
            ? author
            : Array.isArray(author)
              ? stringValue((author[0] as Record<string, unknown> | undefined)?.name)
              : stringValue((author as Record<string, unknown> | undefined)?.name),
          datePublished: stringValue(record.datePublished),
        };
      }
    } catch {
      // Ignore malformed embedded metadata.
    }
  }
  return null;
}

function meta(document: Document, attr: "name" | "property", value: string): string | undefined {
  return normalizeWhitespace(document.querySelector<HTMLMetaElement>(`meta[${attr}="${value}"]`)?.content ?? "") || undefined;
}

const _turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
_turndown.remove(["script", "style", "noscript"]);

function htmlFragmentToMarkdown(html: string): string {
  const markdown = _turndown.turndown(html)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return normalizeObsidianMarkdown(markdown);
}

function normalizeObsidianMarkdown(markdown: string): string {
  return normalizeBlockLinks(normalizeLinkedImages(markdown));
}

function normalizeLinkedImages(markdown: string): string {
  // Turndown can emit image-only links as `[![alt](src)](href)` for linked
  // article images. Obsidian renders multiline variants as stray `[` / `](href)`
  // text around the image, so keep the image and drop the redundant outer link.
  return markdown.replace(/\[\s*(!\[[^\]]*\]\([^)]+\))\s*\]\([^)]+\)/g, "$1");
}

function normalizeBlockLinks(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== "[") {
      output.push(lines[i] ?? "");
      continue;
    }

    const closeIndex = lines.findIndex((line, index) => index > i && /^\]\(([^)]+)\)$/.test(line.trim()));
    if (closeIndex === -1) {
      output.push(lines[i] ?? "");
      continue;
    }

    const href = lines[closeIndex]?.trim().match(/^\]\(([^)]+)\)$/)?.[1] ?? "";
    const inner = trimBlankLines(lines.slice(i + 1, closeIndex));
    output.push(...inner);
    if (!isImageOnlyBlock(inner) && href) {
      if (inner.length > 0) output.push("");
      output.push(`[Link](${href})`);
    }
    i = closeIndex;
  }

  return output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function isImageOnlyBlock(lines: string[]): boolean {
  const nonBlank = lines.map((line) => line.trim()).filter(Boolean);
  return nonBlank.length === 1 && /^!\[[^\]]*\]\([^)]+\)$/.test(nonBlank[0] ?? "");
}

function isPdf(contentType: string, url: string, kind: CaptureCandidateKind): boolean {
  return kind === "pdf" || /application\/pdf/i.test(contentType) || new URL(url).pathname.toLowerCase().endsWith(".pdf");
}

function isHtml(raw: string, contentType: string, kind: CaptureCandidateKind): boolean {
  return kind === "html"
    || /text\/html|application\/xhtml\+xml/i.test(contentType)
    || /^\s*<!doctype html/i.test(raw)
    || /^\s*<html[\s>]/i.test(raw);
}

function isMarkdown(contentType: string, url: string, kind: CaptureCandidateKind): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return kind === "markdown"
    || /text\/(markdown|x-markdown)|application\/markdown/i.test(contentType)
    || path.endsWith(".md")
    || path.endsWith(".markdown")
    || path.endsWith(".mdx");
}

function titleFromUrl(url: string): string {
  const parsed = new URL(url);
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  return normalizeWhitespace(decodeURIComponent(last || parsed.hostname).replace(/[-_]+/g, " ")) || parsed.hostname;
}

function stripMarkdown(value: string): string {
  return value.replace(/^[#>*\-\s]+/, "").replace(/[`*_~\[\]()]/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizeWhitespace(value) : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
