/** Robust bounded fetch helpers for vault source capture. */

import type { CaptureCandidate } from "./url-resolvers.js";

export const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

export interface CaptureFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  retries?: number;
}

export interface CaptureFetchAttempt {
  url: string;
  final_url?: string;
  status?: number;
  status_text?: string;
  content_type?: string;
  bytes?: number;
  strategy: string;
  error?: string;
}

export interface FetchedCandidate {
  candidate: CaptureCandidate;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  raw: string;
  bytes: number;
  attempts: CaptureFetchAttempt[];
}

export async function fetchCandidate(candidate: CaptureCandidate, options: CaptureFetchOptions = {}): Promise<FetchedCandidate> {
  const attempts: CaptureFetchAttempt[] = [];
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let attemptNumber = 0; attemptNumber <= retries; attemptNumber += 1) {
    try {
      const fetched = await fetchOnce(candidate, options);
      attempts.push(...fetched.attempts);
      return { ...fetched, attempts };
    } catch (error) {
      lastError = error;
      const attemptFromError = (error as Error & { attempt?: CaptureFetchAttempt }).attempt;
      attempts.push({
        ...(attemptFromError ?? { url: candidate.url, strategy: candidate.strategy }),
        error: error instanceof Error ? error.message : String(error),
      });

      if (attemptNumber >= retries || !isRetryableError(error)) break;
      await sleep(150 * 2 ** attemptNumber);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const error = new Error(message || `Failed to fetch ${candidate.url}`) as Error & { attempts?: CaptureFetchAttempt[] };
  error.attempts = attempts;
  throw error;
}

async function fetchOnce(candidate: CaptureCandidate, options: CaptureFetchOptions): Promise<FetchedCandidate> {
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    options.signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    const response = await fetch(candidate.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; pi-memory-stone/0.1; +https://github.com/nikolasp/pi-memory-stone)",
        "accept": "text/html, text/markdown, text/plain, application/xhtml+xml, application/pdf, */*;q=0.5",
      },
    });

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const attempt: CaptureFetchAttempt = {
      url: candidate.url,
      final_url: response.url,
      status: response.status,
      status_text: response.statusText,
      content_type: contentType,
      strategy: candidate.strategy,
    };

    if (!response.ok) {
      throw httpError(response, attempt);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) {
      throw new Error(`Response is too large (${contentLength} bytes; max ${maxBytes})`);
    }

    const buffer = await response.arrayBuffer();
    attempt.bytes = buffer.byteLength;
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response is too large (${buffer.byteLength} bytes; max ${maxBytes})`);
    }

    const raw = new TextDecoder(detectCharset(contentType)).decode(buffer);
    const headers = Object.fromEntries(response.headers.entries());

    return {
      candidate,
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers,
      raw,
      bytes: buffer.byteLength,
      attempts: [attempt],
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function httpError(response: Response, attempt: CaptureFetchAttempt): Error & { retryable?: boolean; attempt?: CaptureFetchAttempt } {
  const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim()) as Error & { retryable?: boolean; attempt?: CaptureFetchAttempt };
  error.retryable = response.status === 429 || response.status >= 500;
  error.attempt = attempt;
  return error;
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return Boolean((error as { retryable?: boolean }).retryable);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|aborted/i.test(message);
}

function detectCharset(contentType: string): string {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim();
  return charset || "utf-8";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
