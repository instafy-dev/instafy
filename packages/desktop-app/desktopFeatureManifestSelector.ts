import { statSync } from "node:fs";
import path from "node:path";

export const DESKTOP_FEATURE_MANIFEST_ENV =
  "INSTAFY_DESKTOP_FEATURE_MANIFEST";
export const PUBLIC_DESKTOP_FEATURE_MANIFEST_RELATIVE_PATH =
  "src/publicDesktopFeatureManifest.ts";

type ResolveDesktopFeatureManifestOptions = {
  packageRoot: string;
  configuredManifestPath?: string | null;
  fileIsPresent?: (filePath: string) => boolean;
};

function isRegularFile(filePath: string) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveDesktopFeatureManifest({
  packageRoot,
  configuredManifestPath,
  fileIsPresent = isRegularFile,
}: ResolveDesktopFeatureManifestOptions) {
  if (!path.isAbsolute(packageRoot)) {
    throw new Error(
      "Desktop feature manifest resolution requires an absolute package root.",
    );
  }

  const configuredPath = configuredManifestPath?.trim() ?? "";
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) {
      throw new Error(
        `${DESKTOP_FEATURE_MANIFEST_ENV} must be an absolute path.`,
      );
    }
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(configuredPath)) {
      throw new Error(
        `${DESKTOP_FEATURE_MANIFEST_ENV} must point to a JavaScript or TypeScript module.`,
      );
    }
    if (!fileIsPresent(configuredPath)) {
      throw new Error(
        `Configured desktop feature manifest is missing at ${configuredPath}.`,
      );
    }
    return configuredPath;
  }

  const publicManifestPath = path.join(
    packageRoot,
    PUBLIC_DESKTOP_FEATURE_MANIFEST_RELATIVE_PATH,
  );
  if (!fileIsPresent(publicManifestPath)) {
    throw new Error(
      `Public desktop feature manifest is missing at ${publicManifestPath}.`,
    );
  }
  return publicManifestPath;
}
