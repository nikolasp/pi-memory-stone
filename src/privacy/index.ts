/**
 * Privacy & redaction module.
 * Safe-by-default: redact secrets before DB storage.
 * Ignores sensitive files/tool outputs.
 */

// ─── Secret patterns ────────────────────────────────────────────────

type SecretReplacement = string | ((substring: string, ...args: any[]) => string);

const SECRET_PATTERNS: { name: string; regex: RegExp; replacement: SecretReplacement }[] = [
  // API keys (common formats)
  {
    name: "openai-key",
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED:openai-key]",
  },
  {
    name: "github-token",
    regex: /gh[pousr]_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    name: "aws-key",
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED:aws-key]",
  },
  {
    name: "aws-secret",
    regex: /\b(?:aws[_-]?)?secret[_-]?access[_-]?key\b\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40,}['"]?/gi,
    replacement: "[REDACTED:aws-secret]",
  },
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    name: "generic-api-key",
    regex: /\b(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?key)\b\s*[=:]\s*['"]?[A-Za-z0-9_\-./+=]{16,}['"]?/gi,
    replacement: "[REDACTED:api-key]",
  },
  {
    name: "secret-assignment",
    regex: /\b(?:secret|secret[_-]?key|client[_-]?secret|app[_-]?secret|webhook[_-]?secret|signing[_-]?secret)\b\s*[=:]\s*(?:['"][^'"]+['"]|[^\s'"`]+)/gi,
    replacement: "[REDACTED:secret]",
  },
  {
    name: "private-key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    name: "password-assignment",
    regex: /\b(?:password|passwd|pwd)\b\s*[=:]\s*(?:['"][^'"]+['"]|[^\s'"`]+)/gi,
    replacement: "[REDACTED:password]",
  },
  {
    name: "token-assignment",
    regex: /\b(?:token|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[=:]\s*(?:['"][^'"]+['"]|[A-Za-z0-9_\-.]{16,})/gi,
    replacement: "[REDACTED:token]",
  },
  {
    name: "token-bearer",
    regex: /(?:Bearer|token)\s+[A-Za-z0-9_\-.]{20,}/gi,
    replacement: "[REDACTED:token]",
  },
  {
    name: "connection-string",
    regex: /(?:mongodb|postgres|mysql|redis|sqlite):\/\/[^\s"'`]+/gi,
    replacement: (match: string) => {
      // Keep the protocol but redact credentials
      const url = match.replace(/\/\/[^@]+@/, "//[REDACTED]@");
      return url;
    },
  },
];

function replaceSecretPattern(text: string, pattern: { regex: RegExp; replacement: SecretReplacement }): string {
  if (typeof pattern.replacement === "string") {
    return text.replace(pattern.regex, pattern.replacement);
  }
  return text.replace(pattern.regex, pattern.replacement);
}

// ─── Sensitive path patterns ────────────────────────────────────────

const DEFAULT_SENSITIVE_PATHS = [
  /\.env(\..*)?$/,
  /\.envrc$/,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /\.crt$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /\.gnupg\//,
  /\.aws\/(?:config|credentials)/,
  /secrets?\//i,
  /\.git-credentials/,
];

const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".terraform",
  ".serverless",
];

// ─── Redaction ──────────────────────────────────────────────────────

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = replaceSecretPattern(result, pattern);
  }
  return result;
}

export function isSensitiveForGlobalMemory(text: string): boolean {
  if (redactSecrets(text) !== text) return true;

  return [
    // Local/absolute/relative filesystem paths and common repo paths.
    /(?:^|\s)(?:~|\.|\.\.|[A-Za-z]:)?[/\\][^\s]+/,
    /\b(?:src|lib|test|tests|packages|apps|docs|config)\/[\w./-]+\b/i,
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|env|db|sqlite|pem|key|crt)\b/i,
    // Hostnames and network endpoints.
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/i,
    /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{2,5})?\b/i,
    // Implementation/internal detail markers that should stay project-local.
    /\b(?:internal|private|implementation detail|class|function|method|module|endpoint|schema|table|column)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function isSensitivePath(path: string, extraPatterns: RegExp[] = []): boolean {
  const allPatterns = [...DEFAULT_SENSITIVE_PATHS, ...extraPatterns];

  // Check directory ignore patterns
  const segments = path.split("/");
  for (const seg of segments) {
    if (DEFAULT_IGNORE_DIRS.includes(seg)) return true;
  }

  // Check path patterns
  for (const pattern of allPatterns) {
    if (pattern.test(path)) return true;
  }

  return false;
}

export function isSensitiveToolOutput(toolName: string, path?: string): boolean {
  // Never redact tool outputs in general, but flag sensitive paths
  if (path && isSensitivePath(path)) return true;
  return false;
}

export function redactSensitiveFileContent(content: string, path: string): string {
  if (isSensitivePath(path)) {
    return `[REDACTED: sensitive file at ${path}]`;
  }
  return redactSecrets(content);
}

export function shouldIgnoreFile(path: string): boolean {
  return isSensitivePath(path);
}

export function shouldIgnoreToolResult(toolName: string, args: Record<string, unknown>): boolean {
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path && isSensitivePath(path)) return true;
  return false;
}
