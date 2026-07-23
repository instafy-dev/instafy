import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryCodexPreflightAuth,
  removeTemporaryCodexPreflightAuth,
  type TemporaryCodexPreflightAuth,
} from "./codexPreflightAuth.js";

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const cleanupPath of cleanupPaths) {
    fs.rmSync(cleanupPath, { force: true, recursive: true });
  }
  cleanupPaths.clear();
});

describe("createTemporaryCodexPreflightAuth", () => {
  it("creates an isolated protected copy without exposing the source to writes", () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "instafy-codex-preflight-source-"),
    );
    cleanupPaths.add(sourceDirectory);
    const sourceAuthPath = path.join(sourceDirectory, "auth.json");
    const sourceContents = JSON.stringify({ tokens: { access_token: "test-token" } });
    fs.writeFileSync(sourceAuthPath, sourceContents, { mode: 0o600 });

    const temporaryAuth = createTemporaryCodexPreflightAuth(
      sourceAuthPath,
      sourceDirectory,
    );
    cleanupPaths.add(temporaryAuth.directory);

    expect(temporaryAuth.directory).not.toBe(sourceDirectory);
    expect(path.dirname(temporaryAuth.directory)).toBe(sourceDirectory);
    expect(fs.statSync(temporaryAuth.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(temporaryAuth.authPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(temporaryAuth.authPath, "utf8")).toBe(sourceContents);

    fs.writeFileSync(temporaryAuth.authPath, "refreshed-copy", { mode: 0o600 });
    expect(fs.readFileSync(sourceAuthPath, "utf8")).toBe(sourceContents);

    removeTemporaryCodexPreflightAuth(temporaryAuth);
    cleanupPaths.delete(temporaryAuth.directory);
    expect(fs.existsSync(temporaryAuth.directory)).toBe(false);
  });

  it("removes its protected directory when the source copy fails", () => {
    const parentDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "instafy-codex-preflight-failure-"),
    );
    cleanupPaths.add(parentDirectory);
    const missingSource = path.join(parentDirectory, "missing-auth.json");
    let temporaryAuth: TemporaryCodexPreflightAuth | null = null;

    expect(() => {
      temporaryAuth = createTemporaryCodexPreflightAuth(
        missingSource,
        parentDirectory,
      );
    }).toThrow();
    expect(temporaryAuth).toBeNull();
    expect(fs.readdirSync(parentDirectory)).toEqual([]);
  });
});
