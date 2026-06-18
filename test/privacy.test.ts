/**
 * Tests for the privacy/redaction module.
 * Run with: node --experimental-sqlite --test test/privacy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, isSensitiveForGlobalMemory, isSensitivePath, shouldIgnoreFile } from "../src/privacy/index.js";

describe("redactSecrets", () => {
  it("redacts OpenAI API keys", () => {
    const input = "My key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:openai-key]"));
    assert.ok(!result.includes("sk-proj-"));
  });

  it("redacts GitHub tokens", () => {
    const input = "export GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:github-token]"));
  });

  it("redacts JWT tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:jwt]"));
  });

  it("redacts passwords in assignments", () => {
    const input = 'password="superSecret123" and pwd="admin123"';
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:password]"));
    assert.ok(!result.includes("superSecret123"));
    assert.ok(!result.includes("admin123"));
  });

  it("redacts unquoted password, token, and secret assignments", () => {
    const input = "password=superSecret123 pwd=admin123 TOKEN=abcdef0123456789 SECRET=shhDontKeepMe";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:password]"));
    assert.ok(result.includes("[REDACTED:token]"));
    assert.ok(result.includes("[REDACTED:secret]"));
    assert.ok(!result.includes("superSecret123"));
    assert.ok(!result.includes("abcdef0123456789"));
    assert.ok(!result.includes("shhDontKeepMe"));
  });

  it("redacts common API key assignments with whitespace", () => {
    const input = "api_key = abcdef0123456789XYZ client_secret: abcdef0123456789XYZ";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:api-key]"));
    assert.ok(!result.includes("abcdef0123456789XYZ"));
  });

  it("redacts AWS secret access key environment variables", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:aws-secret]"));
    assert.ok(!result.includes("wJalrXUtnFEMI"));
  });

  it("redacts connection strings", () => {
    const input = "DATABASE_URL=mongodb://user:pass@localhost:27017/db";
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED]@"));
    assert.ok(!result.includes("user:pass@"));
  });

  it("redacts private keys", () => {
    const input = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED:private-key]"));
    assert.ok(!result.includes("MIIEvQ"));
  });

  it("preserves normal text", () => {
    const input = "Just some normal conversation about code";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });
});

describe("isSensitiveForGlobalMemory", () => {
  it("flags paths, hostnames, secrets, and implementation details", () => {
    assert.ok(isSensitiveForGlobalMemory("Remember /Users/me/project/src/index.ts"));
    assert.ok(isSensitiveForGlobalMemory("API lives at api.internal.example.com"));
    assert.ok(isSensitiveForGlobalMemory("api_key = abcdef0123456789XYZ"));
    assert.ok(isSensitiveForGlobalMemory("Implementation detail: call AuthService.refreshToken"));
  });

  it("allows portable user preferences", () => {
    assert.equal(isSensitiveForGlobalMemory("User prefers concise bullet points."), false);
  });

  it("does not flag standalone filenames or generic technical words", () => {
    assert.equal(isSensitiveForGlobalMemory("Use .ts for examples"), false);
    assert.equal(isSensitiveForGlobalMemory("Use file.ts for examples"), false);
    assert.equal(isSensitiveForGlobalMemory("I prefer explicit schemas"), false);
    assert.equal(isSensitiveForGlobalMemory("The table has a column"), false);
    assert.equal(isSensitiveForGlobalMemory("localhost"), false);
    assert.equal(isSensitiveForGlobalMemory("localhost:8080"), false);
    assert.equal(isSensitiveForGlobalMemory("schema.json"), false);
    assert.equal(isSensitiveForGlobalMemory("query.sql"), false);
  });

  it("flags repo paths, sensitive filenames, and hostnames that look like extensions", () => {
    assert.equal(isSensitiveForGlobalMemory("Implementation detail lives in src/privacy/index.ts"), true);
    assert.equal(isSensitiveForGlobalMemory("Store settings in .env.local"), true);
    assert.equal(isSensitiveForGlobalMemory("Backup is prod.sqlite"), true);
    assert.equal(isSensitiveForGlobalMemory("Use private.key for signing"), true);
    assert.equal(isSensitiveForGlobalMemory("API lives at api.foo.rs"), true);
    assert.equal(isSensitiveForGlobalMemory("Script host is service.internal.sh"), true);
  });
});

describe("isSensitivePath", () => {
  it("flags .env files", () => {
    assert.ok(isSensitivePath(".env"));
    assert.ok(isSensitivePath(".env.local"));
    assert.ok(isSensitivePath("path/to/.env.production"));
  });

  it("flags key/cert files", () => {
    assert.ok(isSensitivePath("cert.pem"));
    assert.ok(isSensitivePath("private.key"));
    assert.ok(isSensitivePath("path/to/server.crt"));
  });

  it("flags SSH keys", () => {
    assert.ok(isSensitivePath("~/.ssh/id_rsa"));
    assert.ok(isSensitivePath("/home/user/.ssh/id_ed25519"));
  });

  it("flags AWS credentials", () => {
    assert.ok(isSensitivePath("~/.aws/credentials"));
    assert.ok(isSensitivePath("~/.aws/config"));
  });

  it("flags node_modules", () => {
    assert.ok(isSensitivePath("node_modules/foo/bar.ts"));
  });

  it("flags .git directory", () => {
    assert.ok(isSensitivePath(".git/config"));
  });

  it("allows normal source files", () => {
    assert.ok(!isSensitivePath("src/index.ts"));
    assert.ok(!isSensitivePath("components/Button.tsx"));
    assert.ok(!isSensitivePath("README.md"));
  });
});

describe("shouldIgnoreFile", () => {
  it("returns true for sensitive files", () => {
    assert.ok(shouldIgnoreFile(".env"));
    assert.ok(shouldIgnoreFile("secrets/config.json"));
  });

  it("returns false for normal files", () => {
    assert.ok(!shouldIgnoreFile("src/utils.ts"));
    assert.ok(!shouldIgnoreFile("package.json"));
  });
});
