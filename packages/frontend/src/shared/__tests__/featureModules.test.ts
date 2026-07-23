import { describe, expect, it } from "vitest";
import {
  INSTAFY_FEATURE_MODULE_API_VERSION,
  collectInstafyFeatureModuleContributions,
  defineInstafyFeatureModule,
  validateInstafyFeatureModules,
} from "@instafy/sdk/feature-modules";

describe("Instafy feature modules", () => {
  it("collects neutral compile-time contributions in module order", () => {
    type FixtureContributions = {
      capabilityProviders: readonly { id: string }[];
    };
    const core = defineInstafyFeatureModule<FixtureContributions>({
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "instafy.core",
      capabilityProviders: [{ id: "core-capability" }],
    });
    const fixture = defineInstafyFeatureModule<FixtureContributions>({
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.weather",
      capabilityProviders: [{ id: "fixture-weather" }],
    });

    expect(
      collectInstafyFeatureModuleContributions([core, fixture], "capabilityProviders"),
    ).toEqual([{ id: "core-capability" }, { id: "fixture-weather" }]);
  });

  it("fails closed on duplicate module ids", () => {
    const first = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate",
    } as const;
    const second = {
      apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
      id: "fixture.duplicate",
    } as const;

    expect(() => validateInstafyFeatureModules([first, second])).toThrow(
      'Duplicate Instafy feature module id "fixture.duplicate".',
    );
  });

  it("fails closed on unsupported API versions", () => {
    expect(() =>
      validateInstafyFeatureModules([
        {
          apiVersion: 2,
          id: "fixture.future",
        },
      ]),
    ).toThrow('Instafy feature module "fixture.future" uses unsupported apiVersion 2; expected 1.');
  });

  it("rejects malformed module ids and contribution collections", () => {
    expect(() =>
      validateInstafyFeatureModules([
        {
          apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
          id: " Fixture ",
        },
      ]),
    ).toThrow("has invalid id");

    expect(() =>
      collectInstafyFeatureModuleContributions(
        [
          {
            apiVersion: INSTAFY_FEATURE_MODULE_API_VERSION,
            id: "fixture.invalid-contributions",
            routes: {},
          },
        ],
        "routes",
      ),
    ).toThrow(
      'Instafy feature module "fixture.invalid-contributions" contribution "routes" must be an array.',
    );
  });
});
