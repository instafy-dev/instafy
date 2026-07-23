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
