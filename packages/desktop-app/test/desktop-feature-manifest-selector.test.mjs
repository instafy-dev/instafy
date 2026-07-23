import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const {
  DESKTOP_FEATURE_MANIFEST_ENV,
  PUBLIC_DESKTOP_FEATURE_MANIFEST_RELATIVE_PATH,
  resolveDesktopFeatureManifest,
} = await import(
  path.join(packageRoot, "dist", "desktopFeatureManifestSelector.js")
);

test("selects an explicitly configured absolute manifest", () => {
  const expected = path.resolve("/fixture/composition/desktop-manifest.ts");
  const selected = resolveDesktopFeatureManifest({
    packageRoot,
    configuredManifestPath: expected,
    fileIsPresent: (candidate) => candidate === expected,
  });

  assert.equal(selected, expected);
});

test("selects the public manifest by default", () => {
  const publicPath = path.join(
    packageRoot,
    PUBLIC_DESKTOP_FEATURE_MANIFEST_RELATIVE_PATH,
  );

  assert.equal(
    resolveDesktopFeatureManifest({
      packageRoot,
      fileIsPresent: (candidate) => candidate === publicPath,
    }),
    publicPath,
  );
});

test("rejects unsafe or missing configured manifests", () => {
  assert.throws(
    () =>
      resolveDesktopFeatureManifest({
        packageRoot,
        configuredManifestPath: "relative/desktop-manifest.ts",
      }),
    new RegExp(`${DESKTOP_FEATURE_MANIFEST_ENV} must be an absolute path`),
  );
  assert.throws(
    () =>
      resolveDesktopFeatureManifest({
        packageRoot,
        configuredManifestPath: path.resolve("/fixture/manifest.json"),
      }),
    /must point to a JavaScript or TypeScript module/,
  );
  assert.throws(
    () =>
      resolveDesktopFeatureManifest({
        packageRoot,
        configuredManifestPath: path.resolve("/fixture/missing.ts"),
        fileIsPresent: () => false,
      }),
    /Configured desktop feature manifest is missing/,
  );
});

test("fails closed when the required public default is absent", () => {
  assert.throws(
    () =>
      resolveDesktopFeatureManifest({
        packageRoot,
        fileIsPresent: () => false,
      }),
    /Public desktop feature manifest is missing/,
  );
  assert.throws(
    () =>
      resolveDesktopFeatureManifest({
        packageRoot: "relative/package",
      }),
    /requires an absolute package root/,
  );
});
