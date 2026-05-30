/**
 * Tests for the privacy/redaction module.
 * Run with: node --experimental-sqlite --test test/privacy.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, isSensitivePath, shouldIgnoreFile } from "../src/privacy/index.js";

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
