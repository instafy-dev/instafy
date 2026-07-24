import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS,
  CodexMachineAuthPreflightError,
  requireFreshCodexMachineAuth,
} from "./codexMachineAuthExpiry.mjs";

const NOW_MS = Date.parse("2026-07-15T12:00:00.000Z");

function jwtWithExpiry(expirySeconds, marker = "private-token-marker") {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: expirySeconds, marker })}.signature`;
}

function writeAuthJson(accessToken) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-machine-auth-expiry-"));
  const authDirectory = path.join(home, ".codex");
  const authPath = path.join(authDirectory, "auth.json");
  fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: accessToken } })}\n`,
    { mode: 0o600 },
  );
  return { authPath, home };
}

test("accepts a private machine-auth file with at least 30 minutes remaining", () => {
  const expiresAtSeconds = Math.floor(
    (NOW_MS + CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS) / 1000,
  );
  const fixture = writeAuthJson(jwtWithExpiry(expiresAtSeconds));
  try {
    const result = requireFreshCodexMachineAuth({
      authPath: fixture.authPath,
      nowMs: NOW_MS,
    });
    assert.equal(result.remainingMs, CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("fails closed below 30 minutes without exposing token material", () => {
  const expiresAtSeconds = Math.floor(
    (NOW_MS + CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS - 60_000) / 1000,
  );
  const fixture = writeAuthJson(
    jwtWithExpiry(expiresAtSeconds, "never-log-this-token-marker"),
  );
  try {
    assert.throws(
      () =>
        requireFreshCodexMachineAuth({
          authPath: fixture.authPath,
          nowMs: NOW_MS,
        }),
      (error) => {
        assert.ok(error instanceof CodexMachineAuthPreflightError);
        assert.match(error.message, /at least 30 minutes/i);
        assert.doesNotMatch(error.message, /never-log-this-token-marker/);
        return true;
      },
    );
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("rejects malformed claims and unsafe auth-file permissions", () => {
  const malformed = writeAuthJson("not-a-jwt-token-marker");
  try {
    assert.throws(
      () =>
        requireFreshCodexMachineAuth({
          authPath: malformed.authPath,
          nowMs: NOW_MS,
        }),
      (error) => {
        assert.ok(error instanceof CodexMachineAuthPreflightError);
        assert.doesNotMatch(error.message, /not-a-jwt-token-marker/);
        return true;
      },
    );
  } finally {
    fs.rmSync(malformed.home, { recursive: true, force: true });
  }

  if (process.platform !== "win32") {
    const futureExpiry = Math.floor((NOW_MS + 3_600_000) / 1000);
    const unsafe = writeAuthJson(jwtWithExpiry(futureExpiry));
    try {
      fs.chmodSync(unsafe.authPath, 0o644);
      assert.throws(
        () =>
          requireFreshCodexMachineAuth({
            authPath: unsafe.authPath,
            nowMs: NOW_MS,
          }),
        CodexMachineAuthPreflightError,
      );
    } finally {
      fs.rmSync(unsafe.home, { recursive: true, force: true });
    }
  }
});
