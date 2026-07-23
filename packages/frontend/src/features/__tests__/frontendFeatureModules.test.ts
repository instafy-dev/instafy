import { describe, expect, it } from "vitest";
import { INSTAFY_FEATURE_MODULE_API_VERSION } from "@instafy/sdk/feature-modules";
import { createFrontendApplicationComposition } from "../frontendApplicationComposition";
import {
  createFrontendFeatureComposition,
  type FrontendFeatureModule,
} from "../frontendFeatureModule";
import { createFrontendFeatureServices } from "../frontendFeatureServices";
import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "../publicCoreFrontendFeatureModule";

describe("frontend feature-module composition", () => {
  it("keeps public core registrations when no private feature module is supplied", () => {
    const composition = createFrontendFeatureComposition([
      PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
    ]);

    expect(composition.assistantProviders.map((provider) => provider.id)).toEqual([
      "local_core_assistants",
    ]);
    expect(composition.capabilityProviders.map((provider) => provider.id)).toEqual([
      "local_camera",
      "local_device_toggle",
    ]);
    expect(composition.executorProviders.map((provider) => provider.id)).toEqual([
      "local_device_toggle_executor",
    ]);
    expect(
      composition.nativeExtensionRegistrations.map(
        (registration) => registration.definition.familyId,
      ),
    ).toEqual(["camera"]);
    expect(composition.routes).toEqual([]);
  });

  it("adds a neutral fake module without changing public core definitions", () => {
    const fakeModule: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.weather",
      capabilityProviders: [
        {
          id: "fixture_weather",
          title: "Fixture weather",
          description: "Neutral test provider.",
          capabilities: [
            {
              id: "fixture_weather_forecast",
              title: "Fixture forecast",
              description: "Returns a neutral fixture forecast.",
              actions: [],
            },
          ],
        },
      ],
      routes: [
        {
          id: "fixture.weather.settings",
          path: "fixture-weather",
          element: null,
        },
      ],
    };

    const application = createFrontendApplicationComposition([
      PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
      fakeModule,
    ]);
    const composition = application.features;

    expect(composition.modules.map((module) => module.id)).toEqual([
      "instafy.public-core",
      "fixture.weather",
    ]);
    expect(composition.capabilityProviders.map((provider) => provider.id)).toEqual([
      "local_camera",
      "local_device_toggle",
      "fixture_weather",
    ]);
    expect(composition.routes.map((route) => route.path)).toEqual(["fixture-weather"]);
    expect(
      application.registrations.capabilityProviderRegistry.get("fixture_weather"),
    ).toMatchObject({
      id: "fixture_weather",
      title: "Fixture weather",
    });
    expect(application.registrations.builtInAssistantRegistry.getDefaultHandle()).toBe("octo");
  });

  it("fails closed when a module shadows a public contribution", () => {
    const conflictingModule: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.conflict",
      capabilityProviders: [
        {
          id: "local_camera",
          title: "Conflicting camera",
          description: "Must not replace public core.",
          capabilities: [],
        },
      ],
    };

    expect(() =>
      createFrontendFeatureComposition([
        PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
        conflictingModule,
      ]),
    ).toThrow('Duplicate frontend feature capability provider contribution id "local_camera".');
  });

  it("fails closed on duplicate module ids and route paths", () => {
    const first: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate",
      routes: [{ id: "fixture.first", path: "fixture", element: null }],
    };
    const duplicateModule: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate",
    };
    expect(() => createFrontendFeatureComposition([first, duplicateModule])).toThrow(
      'Duplicate Instafy feature module id "fixture.duplicate".',
    );

    const second: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.second",
      routes: [{ id: "fixture.second-route", path: "fixture", element: null }],
    };
    expect(() => createFrontendFeatureComposition([first, second])).toThrow(
      'Duplicate frontend feature route path "fixture".',
    );
  });

  it("rejects malformed contribution and duplicate service ids", () => {
    const invalid: FrontendFeatureModule = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.invalid",
      routes: [{ id: " Fixture Route ", path: "fixture", element: null }],
    };

    expect(() => createFrontendFeatureComposition([invalid])).toThrow(
      'Frontend feature route contribution has invalid id " Fixture Route ".',
    );
    expect(() =>
      createFrontendFeatureServices([
        ["fixture.service", null],
        ["fixture.service", {}],
      ]),
    ).toThrow('Duplicate frontend feature service id "fixture.service".');
  });
});
