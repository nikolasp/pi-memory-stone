/** Natural-language intent parsing for lightweight vault capture requests. */

import { isVaultScope, type VaultScope } from "./paths.js";

const URL_PATTERN = /https?:\/\/[^\s<>)\]"']+/i;

export interface VaultCaptureIntent {
  url: string;
  scope: VaultScope;
}

export function parseVaultCaptureIntent(prompt: string): VaultCaptureIntent | null {
  const url = extractFirstUrl(prompt);
  if (!url) return null;

  const lower = prompt.toLowerCase();
  if (!lower.includes("vault")) return null;
  if (!/\b(add|capture|save|store|clip|archive|ingest)\b/.test(lower)) return null;

  return {
    url,
    scope: inferScope(lower),
  };
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

function inferScope(lowerPrompt: string): VaultScope {
  const explicit = lowerPrompt.match(/--scope\s+(project|personal)\b/)?.[1];
  if (explicit && isVaultScope(explicit)) return explicit;
  if (/--personal\b|\bpersonal(?:\s+memory)?\s+vault\b|\bglobal(?:\s+memory)?\s+vault\b/.test(lowerPrompt)) return "personal";
  return "project";
}
