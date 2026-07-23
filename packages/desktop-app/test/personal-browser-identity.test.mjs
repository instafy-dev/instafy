import assert from "node:assert/strict";
import test from "node:test";

import {
  attestPersonalBrowserIdentity,
  resolvePersonalBrowserRuntimeConnection,
} from "../dist/personalBrowserIdentity.js";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";

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

function productionOptions(overrides = {}) {
  return {
    appUrl: "https://prod.instafy.dev/studio",
    callerUrl: "https://prod.instafy.dev/studio?projectId=test",
    resolveCurrentSession: async () => visibleSession(),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ userId: USER_ID }),
    }),
    ...overrides,
  };
}

test("uses the authenticated controller identity and sealed visible bearer", async () => {
  const activeSession = visibleSession();
  let observed = null;
  const userId = await attestPersonalBrowserIdentity(
    { controllerUrl: "https://controller.instafy.dev" },
    productionOptions({
      resolveCurrentSession: async () => activeSession,
      fetch: async (url, init) => {
        observed = { url, init };
        return {
          ok: true,
          status: 200,
          json: async () => ({ userId: USER_ID }),
        };
      },
    }),
  );

  assert.equal(userId, USER_ID);
  assert.equal(observed.url, "https://controller.instafy.dev/me/session");
  assert.equal(observed.init.method, "GET");
  assert.equal(
    observed.init.headers.authorization,
    `Bearer ${activeSession.accessToken}`,
  );
  assert.equal(observed.init.redirect, "error");
});

test("fails closed when the controller and visible session identify different users", async () => {
  await assert.rejects(
    attestPersonalBrowserIdentity(
      { controllerUrl: "https://controller.instafy.dev" },
      productionOptions({
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ userId: OTHER_USER_ID }),
        }),
      }),
    ),
    /active Instafy session changed/i,
  );
});

test("fails closed when the visible account changes during attestation", async () => {
  let resolution = 0;
  await assert.rejects(
    attestPersonalBrowserIdentity(
      { controllerUrl: "https://controller.instafy.dev" },
      productionOptions({
        resolveCurrentSession: async () => {
          resolution += 1;
          return resolution === 1
            ? visibleSession(USER_ID)
            : visibleSession(OTHER_USER_ID);
        },
      }),
    ),
    /active Instafy session changed/i,
  );
  assert.equal(resolution, 2);
});

test("rejects a forged local subject before contacting the controller", async () => {
  let fetchCalled = false;
  await assert.rejects(
    attestPersonalBrowserIdentity(
      { controllerUrl: "https://controller.instafy.dev" },
      productionOptions({
        resolveCurrentSession: async () => visibleSession(USER_ID, OTHER_USER_ID),
        fetch: async () => {
          fetchCalled = true;
          throw new Error("should not run");
        },
      }),
    ),
    /active Instafy session changed/i,
  );
  assert.equal(fetchCalled, false);
});

test("does not accept renderer identity or bearer credentials", async () => {
  let sessionResolved = false;
  for (const request of [
    {
      controllerUrl: "https://controller.instafy.dev",
      profileUserId: OTHER_USER_ID,
    },
    {
      controllerUrl: "https://controller.instafy.dev",
      controllerAccessToken: "renderer-token",
    },
  ]) {
    await assert.rejects(
      attestPersonalBrowserIdentity(
        request,
        productionOptions({
          resolveCurrentSession: async () => {
            sessionResolved = true;
            return visibleSession();
          },
        }),
      ),
      /must not include identity credentials/i,
    );
  }
  assert.equal(sessionResolved, false);
});

test("pins production attestation to the trusted controller", async () => {
  let fetchCalled = false;
  await assert.rejects(
    attestPersonalBrowserIdentity(
      { controllerUrl: "https://attacker.example" },
      productionOptions({
        fetch: async () => {
          fetchCalled = true;
          throw new Error("should not run");
        },
      }),
    ),
    /Instafy controller/i,
  );
  assert.equal(fetchCalled, false);
});

test("seals a packaged Personal runtime to the native session and trusted controller", async () => {
  const activeSession = visibleSession();
  const connection = await resolvePersonalBrowserRuntimeConnection(
    { controllerUrl: "https://controller.instafy.dev" },
    {
      appUrl: "https://prod.instafy.dev/studio",
      callerUrl: "https://prod.instafy.dev/studio?projectId=test",
      packaged: true,
      attestedProfileUserId: USER_ID,
      resolveCurrentSession: async () => activeSession,
    },
  );

  assert.deepEqual(connection, {
    controllerUrl: "https://controller.instafy.dev",
    controllerAccessToken: activeSession.accessToken,
    proxyBaseUrl: "https://controller.instafy.dev",
  });
});

test("rejects renderer and ambient proxy overrides for packaged Personal runtimes", async () => {
  for (const request of [
    {
      controllerUrl: "https://controller.instafy.dev",
      proxyBaseUrl: "http://127.0.0.1:8789",
    },
    {
      controllerUrl: "https://controller.instafy.dev",
      ambientProxyBaseUrl: "http://127.0.0.1:8789",
    },
  ]) {
    await assert.rejects(
      resolvePersonalBrowserRuntimeConnection(request, {
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio",
        packaged: true,
        attestedProfileUserId: USER_ID,
        resolveCurrentSession: async () => visibleSession(),
      }),
      /controller-issued proxy/i,
    );
  }
});

test("rejects a Personal runtime when the visible account no longer owns the profile", async () => {
  await assert.rejects(
    resolvePersonalBrowserRuntimeConnection(
      { controllerUrl: "https://controller.instafy.dev" },
      {
        appUrl: "https://prod.instafy.dev/studio",
        callerUrl: "https://prod.instafy.dev/studio",
        packaged: true,
        attestedProfileUserId: USER_ID,
        resolveCurrentSession: async () => visibleSession(OTHER_USER_ID),
      },
    ),
    /active Instafy session changed/i,
  );
});

test("allows only origin-only loopback runtime endpoints in development", async () => {
  const options = {
    appUrl: "http://127.0.0.1:5173/studio",
    callerUrl: "http://127.0.0.1:5173/studio",
    packaged: false,
    attestedProfileUserId: USER_ID,
    resolveCurrentSession: async () => visibleSession(),
  };

  const defaultProxy = await resolvePersonalBrowserRuntimeConnection(
    { controllerUrl: "http://localhost:8788" },
    options,
  );
  assert.equal(defaultProxy.controllerUrl, "http://localhost:8788");
  assert.equal(defaultProxy.proxyBaseUrl, "http://127.0.0.1:8789");

  const explicitProxy = await resolvePersonalBrowserRuntimeConnection(
    {
      controllerUrl: "http://127.0.0.1:8788",
      proxyBaseUrl: "http://localhost:9797",
    },
    options,
  );
  assert.equal(explicitProxy.proxyBaseUrl, "http://localhost:9797");

  for (const request of [
    {
      controllerUrl: "http://127.0.0.1:8788",
      proxyBaseUrl: "https://attacker.example",
    },
    {
      controllerUrl: "http://127.0.0.1:8788",
      proxyBaseUrl: "http://user:pass@127.0.0.1:8789",
    },
    {
      controllerUrl: "http://127.0.0.1:8788",
      proxyBaseUrl: "http://127.0.0.1:8789/v1",
    },
  ]) {
    await assert.rejects(
      resolvePersonalBrowserRuntimeConnection(request, options),
      /loopback origins/i,
    );
  }
});

test("rejects production controller overrides before resolving the runtime session", async () => {
  let sessionResolved = false;
  for (const [callerUrl, controllerUrl] of [
    ["https://prod.instafy.dev/studio", "https://attacker.example"],
    [
      "https://prod.instafy.dev/studio?controllerUrl=https%3A%2F%2Fattacker.example",
      "https://controller.instafy.dev",
    ],
  ]) {
    await assert.rejects(
      resolvePersonalBrowserRuntimeConnection(
        { controllerUrl },
        {
          appUrl: "https://prod.instafy.dev/studio",
          callerUrl,
          packaged: true,
          attestedProfileUserId: USER_ID,
          resolveCurrentSession: async () => {
            sessionResolved = true;
            return visibleSession();
          },
        },
      ),
      /Instafy controller|overridden Desktop session/i,
    );
  }
  assert.equal(sessionResolved, false);
});
