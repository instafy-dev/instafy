import { defineConfig } from "tsup";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_FEATURE_MANIFEST_ENV,
  resolveDesktopFeatureManifest,
} from "./desktopFeatureManifestSelector.js";

const require = createRequire(import.meta.url);
const desktopPackageRoot = fileURLToPath(new URL(".", import.meta.url));
const sdkFeatureModulesPath = require.resolve(
  "@instafy/sdk/feature-modules",
);
const desktopFeatureManifestPath = resolveDesktopFeatureManifest({
  packageRoot: desktopPackageRoot,
  configuredManifestPath: process.env[DESKTOP_FEATURE_MANIFEST_ENV],
});

export default defineConfig({
  entry: {
    main: "src/main.ts",
    preload: "src/preload.ts",
    logging: "src/logging.ts",
    deepLinks: "src/deepLinks.ts",
    bluetoothSelection: "src/bluetoothSelection.ts",
    desktopFeatureManifestSelector: "desktopFeatureManifestSelector.ts",
    desktopExtensionRegistry: "src/desktopExtensionRegistry.ts",
    speechHostSupervisor: "src/speechHostSupervisor.ts",
    speechLanAdvertiser: "src/speechLanAdvertiser.ts",
    speechTunnelSupervisor: "src/speechTunnelSupervisor.ts",
    smokeParentWatchdog: "src/smokeParentWatchdog.ts",
    codexCredentialBridge: "src/codexCredentialBridge.ts",
    personalBrowserIdentity: "src/personalBrowserIdentity.ts",
    personalBrowserSecurity: "src/personalBrowserSecurity.ts",
    personalBrowserPageBridge: "src/personalBrowserPageBridge.ts",
    personalBrowserHumanInput: "src/personalBrowserHumanInput.ts",
    personalBrowserInputShield: "src/personalBrowserInputShield.ts",
    personalBrowserControlServer: "src/personalBrowserControlServer.ts",
    bundledRuntimeAgent: "src/bundledRuntimeAgent.ts",
    desktopRuntimeActivity: "src/desktopRuntimeActivity.ts",
    desktopControllerTrust: "src/desktopControllerTrust.ts",
    desktopUpdaterDownload: "src/desktopUpdaterDownload.ts",
    desktopUpdaterProgress: "src/desktopUpdaterProgress.ts",
    desktopUpdaterPromptPolicy: "src/desktopUpdaterPromptPolicy.ts"
  },
  outDir: "dist",
  format: ["cjs"],
  target: "node20",
  external: ["electron"],
  noExternal: ["@instafy/sdk", "electron-updater", "fs-extra"],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "@instafy/sdk/feature-modules": sdkFeatureModulesPath,
      "virtual:instafy/desktop-feature-manifest":
        desktopFeatureManifestPath,
    };
  },
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false
});
