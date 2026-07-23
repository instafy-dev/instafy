import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectDefaultCodexCredential,
  getDefaultCodexAuthJsonStatus,
  resolveCodexCredentialControllerEndpoint,
  sanitizeCodexSubscriptionAuthJson,
} from "../dist/codexCredentialBridge.js";

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function visibleSession(userId = USER_ID, tokenSubject = userId) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    accessToken: `${encodeJwtPart({ alg: "HS256", typ: "JWT" })}.${encodeJwtPart({
      sub: tokenSubject,
      exp: expiresAt,
    })}.test-signature`,
    userId,
    expiresAt,
  };
}

function withAuthHome(authJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-codex-bridge-"));
  const directory = path.join(home, ".codex");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, "auth.json"),
    `${JSON.stringify(authJson)}\n`,
    { mode: 0o600 },
  );
  return home;
}

test("sanitizes a Codex subscription login and strips API keys and unknown fields", () => {
  const sanitized = sanitizeCodexSubscriptionAuthJson({
    OPENAI_API_KEY: "secret-openai-key-marker",
    auth_mode: "chatgpt",
    last_refresh: "2026-07-14T00:00:00Z",
    unrelated: "secret-unrelated-marker",
    tokens: {
      access_token: "secret-access-marker",
      account_id: "account-1",
      id_token: "secret-id-marker",
      refresh_token: "secret-refresh-marker",
      unexpected: "secret-unexpected-marker",
    },
  });

  assert.deepEqual(sanitized, {
    auth_mode: "chatgpt",
    last_refresh: "2026-07-14T00:00:00Z",
    tokens: {
      access_token: "secret-access-marker",
      account_id: "account-1",
      id_token: "secret-id-marker",
      refresh_token: "secret-refresh-marker",
    },
  });
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /secret-(?:openai-key|unrelated|unexpected)-marker/,
  );
});

test("main-process onboarding uploads only sanitized subscription auth and returns metadata", async () => {
  const activeSession = visibleSession();
  const home = withAuthHome({
    OPENAI_API_KEY: "secret-openai-key-marker",
    auth_mode: "chatgpt",
    tokens: {
      access_token: "secret-access-marker",
      refresh_token: "secret-refresh-marker",
    },
  });
  let observedRequest = null;
  try {
    const result = await connectDefaultCodexCredential(
      {
        controllerUrl: "https://controller.instafy.dev",
        label: "  My local Codex\nlogin  ",
        makeDefault: true,
      },
      {
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio?projectId=test",
        homeDirectory: home,
        resolveCurrentSession: async () => activeSession,
        fetch: async (url, init) => {
          observedRequest = { url, init };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              credentialId: CREDENTIAL_ID,
              kind: "codex_auth_json",
              isDefault: true,
              ignoredSecret: "secret-response-marker",
            }),
          };
        },
      },
    );

    assert.deepEqual(result, {
      credentialId: CREDENTIAL_ID,
      kind: "codex_auth_json",
      isDefault: true,
    });
    assert.equal(
      observedRequest.url,
      "https://controller.instafy.dev/me/credentials/codex",
    );
    assert.equal(observedRequest.init.redirect, "error");
    assert.equal(
      observedRequest.init.headers.authorization,
      `Bearer ${activeSession.accessToken}`,
    );
    const body = JSON.parse(observedRequest.init.body);
    assert.equal(body.label, "My local Codex login");
    assert.equal(body.makeDefault, true);
    assert.equal(body.authJson.OPENAI_API_KEY, undefined);
    assert.equal(body.authJson.tokens.access_token, "secret-access-marker");
    assert.doesNotMatch(JSON.stringify(result), /secret-/);
    assert.deepEqual(await getDefaultCodexAuthJsonStatus(home), { exists: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refuses an API-key-only auth.json without contacting the controller", async () => {
  const home = withAuthHome({ OPENAI_API_KEY: "secret-openai-key-marker" });
  let fetchCalled = false;
  try {
    assert.deepEqual(await getDefaultCodexAuthJsonStatus(home), { exists: false });
    await assert.rejects(
      connectDefaultCodexCredential(
        {
          controllerUrl: "https://controller.instafy.dev",
        },
        {
          appUrl: "https://prod.instafy.dev/studio",
          callerUrl: "https://prod.instafy.dev/studio",
          homeDirectory: home,
          resolveCurrentSession: async () => visibleSession(),
          fetch: async () => {
            fetchCalled = true;
            throw new Error("should not run");
          },
        },
      ),
      /unavailable or invalid/i,
    );
    assert.equal(fetchCalled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refuses a group- or world-readable auth.json on POSIX hosts", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows protects the file with ACLs instead of POSIX mode bits");
    return;
  }
  const home = withAuthHome({
    auth_mode: "chatgpt",
    tokens: { access_token: "secret-access-marker" },
  });
  let fetchCalled = false;
  try {
    fs.chmodSync(path.join(home, ".codex", "auth.json"), 0o644);
    assert.deepEqual(await getDefaultCodexAuthJsonStatus(home), { exists: false });
    await assert.rejects(
      connectDefaultCodexCredential(
        {
          controllerUrl: "https://controller.instafy.dev",
        },
        {
          appUrl: "https://prod.instafy.dev/studio",
          callerUrl: "https://prod.instafy.dev/studio",
          homeDirectory: home,
          resolveCurrentSession: async () => visibleSession(),
          fetch: async () => {
            fetchCalled = true;
            throw new Error("should not run");
          },
        },
      ),
      /unavailable or invalid/i,
    );
    assert.equal(fetchCalled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pins production uploads to the trusted controller and local uploads to loopback", () => {
  assert.equal(
    resolveCodexCredentialControllerEndpoint(
      "https://prod.instafy.dev/studio",
      "https://prod.instafy.dev/settings",
      "https://controller.instafy.dev/",
    ),
    "https://controller.instafy.dev/me/credentials/codex",
  );
  assert.equal(
    resolveCodexCredentialControllerEndpoint(
      "http://127.0.0.1:5173/studio",
      "http://127.0.0.1:5173/studio",
      "http://localhost:8788",
    ),
    "http://localhost:8788/me/credentials/codex",
  );
  assert.throws(
    () =>
      resolveCodexCredentialControllerEndpoint(
        "https://prod.instafy.dev/studio",
        "https://prod.instafy.dev/studio",
        "https://evil.example/steal",
      ),
    /controller url|Instafy controller/i,
  );
  assert.throws(
    () =>
      resolveCodexCredentialControllerEndpoint(
        "https://prod.instafy.dev/studio",
        "https://evil.example/studio",
        "https://controller.instafy.dev",
      ),
    /active Instafy app/i,
  );
  assert.throws(
    () =>
      resolveCodexCredentialControllerEndpoint(
        "https://attacker.example/studio",
        "https://attacker.example/studio",
        "https://attacker.example",
      ),
    /not trusted/i,
  );
  assert.throws(
    () =>
      resolveCodexCredentialControllerEndpoint(
        "https://attacker.instafy.dev/studio",
        "https://attacker.instafy.dev/studio",
        "https://controller.instafy.dev",
      ),
    /not trusted/i,
  );
  assert.throws(
    () =>
      resolveCodexCredentialControllerEndpoint(
        "https://prod.instafy.dev/studio",
        "https://prod.instafy.dev/studio?controllerAccessToken=attacker-token",
        "https://controller.instafy.dev",
      ),
    /overridden Desktop session/i,
  );
});

test("rejects renderer-supplied bearer tokens before resolving the visible session", async () => {
  let sessionResolved = false;
  let fetchCalled = false;
  await assert.rejects(
    connectDefaultCodexCredential(
      {
        controllerUrl: "https://controller.instafy.dev",
        controllerAccessToken: "attacker-account-token",
      },
      {
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio",
        resolveCurrentSession: async () => {
          sessionResolved = true;
          return visibleSession();
        },
        fetch: async () => {
          fetchCalled = true;
          throw new Error("should not run");
        },
      },
    ),
    /must not include session tokens/i,
  );
  assert.equal(sessionResolved, false);
  assert.equal(fetchCalled, false);
});

test("binds the visible Supabase user to the access-token subject", async () => {
  const attackerUserId = "33333333-3333-4333-8333-333333333333";
  let fetchCalled = false;
  await assert.rejects(
    connectDefaultCodexCredential(
      { controllerUrl: "https://controller.instafy.dev" },
      {
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio",
        resolveCurrentSession: async () => visibleSession(USER_ID, attackerUserId),
        fetch: async () => {
          fetchCalled = true;
          throw new Error("should not run");
        },
      },
    ),
    /active Instafy session changed/i,
  );
  assert.equal(fetchCalled, false);
});
