import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  defineInstafyFeatureModule,
} from "@instafy/sdk/feature-modules";
import { createLocalProviderFeatureComposition } from "./local-provider-feature-module.mjs";
import { createLocalProviderRegistry } from "./local-provider-registry.mjs";
import { PUBLIC_CORE_LOCAL_PROVIDER_FEATURE_MODULE } from "./public-core-local-provider-feature-module.mjs";

function defineFakeProviderModule(overrides = {}) {
  return defineInstafyFeatureModule({
    apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
    id: "test.weather-provider",
    providerFactories: [
      {
        type: "weather",
        create: ({ id }) => ({ id, summary: { id } }),
      },
    ],
    ...overrides,
  });
}

test("a neutral provider module reaches the provider registry", () => {
  const registry = createLocalProviderRegistry({
    featureModules: [defineFakeProviderModule()],
    defaultConfig: {
      defaultProviderId: "weather-local",
      providers: [{ type: "weather", id: "weather-local", enabled: true }],
    },
    configResult: {
      configPath: "/test/provider-host.json",
      config: {
        defaultProviderId: "weather-local",
        providers: [{ type: "weather", id: "weather-local", enabled: true }],
      },
      error: null,
    },
  });

  assert.equal(registry.defaultProviderId, "weather-local");
  assert.deepEqual(
    registry.providers.map((provider) => provider.id),
    ["weather-local"],
  );
});

test("the public provider composition contains no private provider type", () => {
  const composition = createLocalProviderFeatureComposition([
    PUBLIC_CORE_LOCAL_PROVIDER_FEATURE_MODULE,
  ]);

  assert.deepEqual(
    [...composition.providerFactories.keys()].sort(),
    ["camera", "simulated_devices", "speech"],
  );
});

test("provider composition fails closed on invalid modules and contributions", () => {
  const module = defineFakeProviderModule();

  assert.throws(
    () => createLocalProviderFeatureComposition([module, module]),
    /Duplicate Instafy feature module id/,
  );
  assert.throws(
    () =>
      createLocalProviderFeatureComposition([
        defineFakeProviderModule({
          apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION + 1,
        }),
      ]),
    /uses unsupported apiVersion/,
  );
  assert.throws(
    () =>
      createLocalProviderFeatureComposition([
        module,
        defineFakeProviderModule({
          id: "test.weather-provider-copy",
        }),
      ]),
    /Duplicate local provider factory type/,
  );
});
