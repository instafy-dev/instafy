import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "desktopExtensionRegistry.js");
const { createDesktopExtensionRegistry } = await import(modulePath);

function createFixtureModule(overrides = {}) {
  return {
    apiVersion: 1,
    id: "test.weather-desktop",
    desktopExtensions: [
      {
        id: "weather",
        methods: {
          forecast: (payload) => ({ ok: true, payload }),
        },
      },
    ],
    ...overrides,
  };
}

test("a neutral fake feature module can register and invoke a desktop method", async () => {
  const registry = createDesktopExtensionRegistry([createFixtureModule()]);

  assert.deepEqual(registry.extensionIds, ["weather"]);
  assert.deepEqual(
    await registry.invoke("weather", "forecast", { city: "Stockholm" }),
    {
      ok: true,
      payload: { city: "Stockholm" },
    },
  );
});

test("the public desktop composition can be empty", async () => {
  const registry = createDesktopExtensionRegistry([]);

  assert.deepEqual(registry.extensionIds, []);
  await assert.rejects(
    registry.invoke("not-registered", "status"),
    /Unknown desktop extension "not-registered"/,
  );
  await registry.shutdownAll();
});

test("desktop extension composition fails closed on module incompatibility", () => {
  const module = createFixtureModule();

  assert.throws(
    () => createDesktopExtensionRegistry([module, module]),
    /Duplicate Instafy feature module id/,
  );
  assert.throws(
    () =>
      createDesktopExtensionRegistry([
        createFixtureModule({ apiVersion: 2 }),
      ]),
    /uses unsupported apiVersion/,
  );
});

test("desktop extension composition rejects duplicate registrations and unknown calls", async () => {
  assert.throws(
    () =>
      createDesktopExtensionRegistry([
        createFixtureModule(),
        createFixtureModule({
          id: "test.weather-desktop-copy",
        }),
      ]),
    /Duplicate desktop extension id/,
  );

  const registry = createDesktopExtensionRegistry([createFixtureModule()]);
  await assert.rejects(
    registry.invoke("weather", "missing"),
    /Unknown method "missing"/,
  );
  await assert.rejects(
    registry.invoke("not-registered", "forecast"),
    /Unknown desktop extension "not-registered"/,
  );
});

// ------------------------------------------------ host context and consent

const {
  createDesktopExtensionConsentStore,
  desktopRuntimeLaunchGrantsEqual,
  desktopRuntimeLaunchGrantsForStart,
  desktopRuntimeLaunchGrantsHeld,
  invokeDesktopExtensionWithLaunchGrants,
  normalizeDesktopExtensionConsentData,
  restoreDesktopExtensionConsents,
  snapshotDesktopExtensionConsents,
} = await import(modulePath);

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTROLLER = "https://controller.example";
const OTHER_CONTROLLER = "http://127.0.0.1:18788";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function memoryConsents(initial = {}) {
  let data = structuredClone(initial);
  return {
    read: () => structuredClone(data),
    write: (next) => {
      data = structuredClone(next);
    },
  };
}

function hostFor({ userId = USER_A, controllerOrigin = CONTROLLER, consents = memoryConsents() } = {}) {
  return {
    session: userId ? { userId, email: "person@example.test" } : null,
    controllerOrigin,
    consents,
    dialogs: {
      showMessageBox: async () => 1,
      pickFile: async () => null,
    },
    desktopOwnedPaths: ["/fixture/workspace"],
  };
}

// A neutral module that turns a "fixture engine" on and off, and grants it.
function createEngineModule({ id = "test.fixture-engine", grantId = "fixture-engine", keys } = {}) {
  const protectedEnvKeys = keys ?? ["INSTAFY_FIXTURE_ENGINE_BIN", "INSTAFY_FIXTURE_ENGINE_USER_ID"];
  return {
    apiVersion: 1,
    id,
    desktopExtensions: [
      {
        id: grantId,
        methods: {
          context: (payload, host) => ({
            payload,
            session: host.session,
            controllerOrigin: host.controllerOrigin,
            hasConsentStore: host.consentStore !== null,
            desktopOwnedPaths: host.desktopOwnedPaths,
          }),
          enable: (payload, host) => {
            host.consentStore.write({ bin: payload?.bin ?? "/fixture/engine" });
            return { on: true };
          },
          disable: (_payload, host) => {
            host.consentStore.remove();
            return { on: false };
          },
          read: (_payload, host) => host.consentStore?.read() ?? null,
          others: (_payload, host) => host.consentStore.hasOtherAccounts(),
        },
      },
    ],
    desktopRuntimeLaunchGrants: [
      {
        id: grantId,
        protectedEnvKeys,
        resolve: ({ consent, instafyUserId }) =>
          consent
            ? {
                env: { [protectedEnvKeys[0]]: consent.bin, [protectedEnvKeys[1]]: instafyUserId },
                localEngine: "fixture-engine",
              }
            : null,
      },
    ],
  };
}

test("a method gets the host context, never identity from its payload", async () => {
  const registry = createDesktopExtensionRegistry([createEngineModule()]);
  const consents = memoryConsents();
  const seen = await registry.invoke(
    "fixture-engine",
    "context",
    { userId: USER_B, controllerOrigin: OTHER_CONTROLLER },
    hostFor({ userId: USER_A.toUpperCase(), consents }),
  );
  assert.deepEqual(seen.session, { userId: USER_A, email: "person@example.test" });
  assert.equal(seen.controllerOrigin, CONTROLLER);
  assert.equal(seen.hasConsentStore, true);
  assert.deepEqual(seen.desktopOwnedPaths, ["/fixture/workspace"]);

  await registry.invoke("fixture-engine", "enable", { userId: USER_B }, hostFor({ consents }));
  assert.deepEqual(Object.keys(consents.read()["test.fixture-engine"][CONTROLLER]), [USER_A]);

  // No session or no trusted controller: no consent store at all.
  for (const host of [hostFor({ userId: null }), hostFor({ controllerOrigin: null }), hostFor({ controllerOrigin: "not a url" })]) {
    assert.equal((await registry.invoke("fixture-engine", "context", {}, host)).hasConsentStore, false);
  }
  // Called without a host, as before: no session, no store.
  const bare = await registry.invoke("fixture-engine", "context", { x: 1 });
  assert.equal(bare.session, null);
  assert.equal(bare.hasConsentStore, false);
});

test("consent records are kept per module, controller origin and user", async () => {
  const consents = memoryConsents();
  const registry = createDesktopExtensionRegistry([
    createEngineModule(),
    createEngineModule({
      id: "test.other-engine",
      grantId: "other-engine",
      keys: ["INSTAFY_OTHER_ENGINE_BIN", "INSTAFY_OTHER_ENGINE_USER_ID"],
    }),
  ]);
  await registry.invoke("fixture-engine", "enable", { bin: "/a" }, hostFor({ consents }));
  assert.equal(await registry.invoke("fixture-engine", "others", {}, hostFor({ consents })), false);
  await registry.invoke("fixture-engine", "enable", { bin: "/b" }, hostFor({ consents, userId: USER_B }));
  await registry.invoke(
    "fixture-engine",
    "enable",
    { bin: "/c" },
    hostFor({ consents, controllerOrigin: OTHER_CONTROLLER }),
  );

  assert.deepEqual(await registry.invoke("fixture-engine", "read", {}, hostFor({ consents })), { bin: "/a" });
  assert.deepEqual(
    await registry.invoke("fixture-engine", "read", {}, hostFor({ consents, userId: USER_B })),
    { bin: "/b" },
  );
  assert.equal(await registry.invoke("other-engine", "read", {}, hostFor({ consents })), null);
  assert.equal(await registry.invoke("fixture-engine", "others", {}, hostFor({ consents })), true);

  await registry.invoke("fixture-engine", "disable", {}, hostFor({ consents }));
  assert.equal(await registry.invoke("fixture-engine", "read", {}, hostFor({ consents })), null);
  assert.deepEqual(Object.keys(consents.read()["test.fixture-engine"]).sort(), [CONTROLLER, OTHER_CONTROLLER].sort());

  // Malformed stored data is ignored, not trusted.
  assert.deepEqual(
    normalizeDesktopExtensionConsentData({
      "test.fixture-engine": {
        "not an origin": { [USER_A]: { bin: "/x" } },
        [`${CONTROLLER}/path`]: { [USER_A]: { bin: "/x" } },
        [CONTROLLER]: { "not-a-user": { bin: "/x" }, [USER_A]: "not an object", [USER_B]: { bin: "/b" } },
      },
      "Not A Module": { [CONTROLLER]: { [USER_A]: { bin: "/x" } } },
    }),
    { "test.fixture-engine": { [CONTROLLER]: { [USER_B]: { bin: "/b" } } } },
  );
  assert.throws(
    () => createDesktopExtensionConsentStore(consents, { moduleId: "test.fixture-engine", controllerOrigin: CONTROLLER, userId: "someone" }),
    /Instafy user/,
  );
});

test("a module's consent snapshot puts back exactly what it held", () => {
  const consents = memoryConsents({
    "test.other-engine": { [CONTROLLER]: { [USER_A]: { bin: "/other" } } },
  });
  const store = createDesktopExtensionConsentStore(consents, {
    moduleId: "test.fixture-engine",
    controllerOrigin: CONTROLLER,
    userId: USER_A,
  });
  const empty = snapshotDesktopExtensionConsents(consents, "test.fixture-engine");
  store.write({ bin: "/a" });
  const withA = snapshotDesktopExtensionConsents(consents, "test.fixture-engine");
  store.write({ bin: "/changed" });
  restoreDesktopExtensionConsents(consents, withA);
  assert.deepEqual(store.read(), { bin: "/a" });
  restoreDesktopExtensionConsents(consents, empty);
  assert.equal(store.read(), null);
  // Another module's records are untouched.
  assert.deepEqual(consents.read(), {
    "test.other-engine": { [CONTROLLER]: { [USER_A]: { bin: "/other" } } },
  });
});

// ------------------------------------------------------------ launch grants

test("launch grant contributions are validated at composition", () => {
  const withKeys = (keys, extra = {}) => ({
    ...createEngineModule(),
    desktopRuntimeLaunchGrants: [{ id: "fixture-engine", protectedEnvKeys: keys, resolve: () => null, ...extra }],
  });
  for (const keys of [
    [],
    ["PATH"],
    ["RUNTIME_ID"],
    ["INSTAFY_RUNTIME_AGENT_BIN"],
    ["INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN"],
    ["instafy_lower"],
  ]) {
    assert.throws(() => createDesktopExtensionRegistry([withKeys(keys)]), /protectedEnvKeys|cannot set/);
  }
  assert.throws(
    () => createDesktopExtensionRegistry([withKeys(["INSTAFY_FIXTURE_ENGINE_BIN"], { resolve: "nope" })]),
    /resolve function/,
  );
  assert.throws(
    () =>
      createDesktopExtensionRegistry([
        createEngineModule(),
        createEngineModule({ id: "test.copy", grantId: "copy-engine" }),
      ]),
    /more than once/,
  );
});

test("launch grants resolve only for a bound user, from that user's consent, and strip every key", async () => {
  const consents = memoryConsents();
  const registry = createDesktopExtensionRegistry([createEngineModule()]);
  await registry.invoke("fixture-engine", "enable", { bin: "/fixture/engine" }, hostFor({ consents }));
  const resolve = (instafyUserId, controllerOrigin = CONTROLLER) =>
    registry.resolveLaunchGrants({ projectId: PROJECT_ID, controllerOrigin, instafyUserId, consents });

  const granted = await resolve(USER_A.toUpperCase());
  assert.deepEqual(granted, [
    {
      id: "fixture-engine",
      moduleId: "test.fixture-engine",
      protectedEnvKeys: ["INSTAFY_FIXTURE_ENGINE_BIN", "INSTAFY_FIXTURE_ENGINE_USER_ID"],
      grant: {
        env: { INSTAFY_FIXTURE_ENGINE_BIN: "/fixture/engine", INSTAFY_FIXTURE_ENGINE_USER_ID: USER_A },
        localEngine: "fixture-engine",
      },
    },
  ]);
  assert.equal(desktopRuntimeLaunchGrantsHeld(granted), true);
  assert.deepEqual(desktopRuntimeLaunchGrantsForStart(granted), [
    {
      protectedEnvKeys: ["INSTAFY_FIXTURE_ENGINE_BIN", "INSTAFY_FIXTURE_ENGINE_USER_ID"],
      env: { INSTAFY_FIXTURE_ENGINE_BIN: "/fixture/engine", INSTAFY_FIXTURE_ENGINE_USER_ID: USER_A },
      localEngine: "fixture-engine",
    },
  ]);

  // Unbound starts, other users and other controllers get nothing, but the
  // keys are still declared so the start strips them.
  for (const grants of [await resolve(null), await resolve(USER_B), await resolve(USER_A, OTHER_CONTROLLER)]) {
    assert.equal(desktopRuntimeLaunchGrantsHeld(grants), false);
    assert.deepEqual(desktopRuntimeLaunchGrantsForStart(grants), [
      { protectedEnvKeys: ["INSTAFY_FIXTURE_ENGINE_BIN", "INSTAFY_FIXTURE_ENGINE_USER_ID"] },
    ]);
    assert.equal(desktopRuntimeLaunchGrantsEqual(grants, granted), false);
  }
  assert.deepEqual(registry.launchGrantsWithoutValues(), await resolve(null));
  assert.equal(desktopRuntimeLaunchGrantsEqual(await resolve(USER_A), granted), true);
});

test("a grant that throws or oversteps is not granted, and the error is reported", async () => {
  const errors = [];
  const consents = memoryConsents();
  const make = (resolve) =>
    createDesktopExtensionRegistry([
      { ...createEngineModule(), desktopRuntimeLaunchGrants: [{ id: "fixture-engine", protectedEnvKeys: ["INSTAFY_FIXTURE_ENGINE_BIN"], resolve }] },
    ]);
  for (const resolve of [
    () => {
      throw new Error("config unreadable");
    },
    () => ({ env: { INSTAFY_NOT_DECLARED: "x" } }),
    () => ({ env: { INSTAFY_FIXTURE_ENGINE_BIN: 42 } }),
    () => ({ env: { INSTAFY_FIXTURE_ENGINE_BIN: "/x" }, localEngine: "Bad Engine" }),
    () => ({ notEnv: true }),
  ]) {
    const [entry] = await make(resolve).resolveLaunchGrants({
      projectId: PROJECT_ID,
      controllerOrigin: CONTROLLER,
      instafyUserId: USER_A,
      consents,
      onError: (grantId, error) => errors.push([grantId, error.message]),
    });
    assert.equal(entry.grant, null);
  }
  assert.equal(errors.length, 5);
  assert.ok(errors.every(([grantId]) => grantId === "fixture-engine"));
});

test("a consent change replaces the runtime only when its own grant changed; keeping the work undoes it", async () => {
  const consents = memoryConsents();
  const registry = createDesktopExtensionRegistry([createEngineModule()]);
  const replaced = [];
  let decision = "replaced";
  let runtime = {
    handle: "runtime-1",
    projectId: PROJECT_ID,
    controllerOrigin: CONTROLLER,
    instafyUserId: USER_A,
    launchGrants: registry.launchGrantsWithoutValues(),
  };
  let locked = 0;
  const invoke = (methodId, host, payload = {}) =>
    invokeDesktopExtensionWithLaunchGrants({
      registry,
      extensionId: "fixture-engine",
      methodId,
      payload,
      host,
      withRuntimeLock: async (operation) => {
        locked += 1;
        return await operation();
      },
      runningRuntime: () => runtime,
      replaceRuntime: async (current) => {
        replaced.push(current.handle);
        if (decision === "kept") {
          return "kept";
        }
        runtime = {
          ...current,
          handle: `runtime-${replaced.length + 1}`,
          launchGrants: await registry.resolveLaunchGrants({
            projectId: current.projectId,
            controllerOrigin: current.controllerOrigin,
            instafyUserId: current.instafyUserId,
            consents,
          }),
        };
        return "replaced";
      },
    });

  assert.deepEqual(await invoke("enable", hostFor({ consents })), { on: true });
  assert.deepEqual(replaced, ["runtime-1"]);
  await invoke("enable", hostFor({ consents }));
  await invoke("enable", hostFor({ consents, userId: USER_B }));
  await invoke("read", hostFor({ consents }));
  assert.deepEqual(replaced, ["runtime-1"]);
  await invoke("enable", hostFor({ consents }), { bin: "/new/engine" });
  assert.deepEqual(replaced, ["runtime-1", "runtime-2"]);

  decision = "kept";
  const before = consents.read();
  await assert.rejects(invoke("disable", hostFor({ consents })), (error) => {
    assert.equal(error.name, "DesktopExtensionChangeNotMadeError");
    assert.equal(error.code, "desktop_extension_change_not_made");
    return true;
  });
  assert.deepEqual(consents.read(), before);
  assert.equal(runtime.handle, "runtime-3");
  assert.ok(locked > 0);

  // A module that grants nothing never takes the runtime lock.
  const plain = createDesktopExtensionRegistry([
    { apiVersion: 1, id: "test.plain", desktopExtensions: [{ id: "plain", methods: { ping: () => "pong" } }] },
  ]);
  const lockedBefore = locked;
  assert.equal(
    await invokeDesktopExtensionWithLaunchGrants({
      registry: plain,
      extensionId: "plain",
      methodId: "ping",
      payload: {},
      host: hostFor({ consents }),
      withRuntimeLock: async (operation) => {
        locked += 1;
        return await operation();
      },
      runningRuntime: () => runtime,
      replaceRuntime: async () => "replaced",
    }),
    "pong",
  );
  assert.equal(locked, lockedBefore);
  await assert.rejects(
    invokeDesktopExtensionWithLaunchGrants({
      registry: plain,
      extensionId: "missing",
      methodId: "ping",
      payload: {},
      host: hostFor({ consents }),
      withRuntimeLock: async (operation) => await operation(),
      runningRuntime: () => null,
      replaceRuntime: async () => "replaced",
    }),
    /Unknown desktop extension "missing"/,
  );
});
