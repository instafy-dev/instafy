import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTEND_FEATURE_MANIFEST_ENV,
  PUBLIC_FRONTEND_FEATURE_MANIFEST_RELATIVE_PATH,
  resolveFrontendFeatureManifest,
} from "../../featureManifestSelector.js";

const PACKAGE_ROOT = path.resolve("/workspace/private-distribution/core/packages/frontend");
const PRIVATE_MANIFEST_PATH = path.resolve(
  "/workspace/private-distribution/overlays/frontend-feature-manifest.ts",
);
const PUBLIC_MANIFEST_PATH = path.join(
  PACKAGE_ROOT,
  PUBLIC_FRONTEND_FEATURE_MANIFEST_RELATIVE_PATH,
);

describe("frontend feature manifest selection", () => {
  it("selects an explicit private manifest independently of the pinned core layout", () => {
    expect(
      resolveFrontendFeatureManifest({
        packageRoot: PACKAGE_ROOT,
        configuredManifestPath: PRIVATE_MANIFEST_PATH,
        fileIsPresent: (filePath) => filePath === PRIVATE_MANIFEST_PATH,
      }),
    ).toBe(PRIVATE_MANIFEST_PATH);
  });

  it("selects the standalone public manifest when no build-time input is provided", () => {
    expect(
      resolveFrontendFeatureManifest({
        packageRoot: PACKAGE_ROOT,
        fileIsPresent: (filePath) => filePath === PUBLIC_MANIFEST_PATH,
      }),
    ).toBe(PUBLIC_MANIFEST_PATH);
  });

  it("rejects relative private-manifest inputs instead of resolving them implicitly", () => {
    expect(() =>
      resolveFrontendFeatureManifest({
        packageRoot: PACKAGE_ROOT,
        configuredManifestPath: "../../overlays/frontend-feature-manifest.ts",
      }),
    ).toThrow(`${FRONTEND_FEATURE_MANIFEST_ENV} must be an absolute build-time path.`);
  });

  it("fails closed when an explicit private manifest is missing", () => {
    expect(() =>
      resolveFrontendFeatureManifest({
        packageRoot: PACKAGE_ROOT,
        configuredManifestPath: PRIVATE_MANIFEST_PATH,
        fileIsPresent: () => false,
      }),
    ).toThrow(`Configured frontend feature manifest is missing at ${PRIVATE_MANIFEST_PATH}.`);
  });

  it("fails closed when neither exact manifest exists", () => {
    expect(() =>
      resolveFrontendFeatureManifest({
        packageRoot: PACKAGE_ROOT,
        fileIsPresent: () => false,
      }),
    ).toThrow(`Public frontend feature manifest is missing at ${PUBLIC_MANIFEST_PATH}.`);
  });
});
