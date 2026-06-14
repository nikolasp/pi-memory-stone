/** Extraction quality scoring for captured source pages. */

export type CaptureQuality = "good" | "weak";

export interface CaptureQualityReport {
  quality: CaptureQuality;
  score: number;
  warnings: string[];
  plainTextChars: number;
}

export function assessCaptureQuality(input: { title: string; markdown: string; extractor: string }): CaptureQualityReport {
  const plain = markdownToPlainText(input.markdown);
  const warnings: string[] = [];
  let score = 0;

  if (input.title.trim().length > 0) score += 0.2;
  else warnings.push("missing title");

  if (plain.length >= 500) score += 0.35;
  else if (plain.length >= 120) {
    score += 0.18;
    warnings.push("short extracted text");
  } else {
    warnings.push("very short extracted text");
  }

  const paragraphCount = input.markdown.split(/\n{2,}/).filter((paragraph) => markdownToPlainText(paragraph).length >= 40).length;
  if (paragraphCount >= 3) score += 0.2;
  else warnings.push("few article-like paragraphs");

  const linkOnlyRatio = linkOnlyLineRatio(input.markdown);
  if (linkOnlyRatio <= 0.35) score += 0.15;
  else warnings.push("high link/navigation ratio");

  if (input.extractor === "html-readability" || input.extractor === "markdown" || input.extractor === "text") {
    score += 0.1;
  }

  score = Math.min(1, Number(score.toFixed(2)));
  return {
    quality: score >= 0.65 ? "good" : "weak",
    score,
    warnings,
    plainTextChars: plain.length,
  };
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkOnlyLineRatio(markdown: string): number {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return 1;
  const linkish = lines.filter((line) => /^[-*]?\s*\[[^\]]+][^)]+\)?\s*$/.test(line) || /^[-*]?\s*https?:\/\//.test(line)).length;
  return linkish / lines.length;
}
