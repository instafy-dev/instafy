import { statSync } from "node:fs";
import path from "node:path";

export const FRONTEND_FEATURE_MANIFEST_ENV =
  "INSTAFY_FRONTEND_FEATURE_MANIFEST";
export const PUBLIC_FRONTEND_FEATURE_MANIFEST_RELATIVE_PATH =
  "src/features/publicFrontendFeatureManifest.ts";

type ResolveFrontendFeatureManifestOptions = {
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

export function resolveFrontendFeatureManifest({
  packageRoot,
  configuredManifestPath,
  fileIsPresent = isRegularFile,
}: ResolveFrontendFeatureManifestOptions) {
  if (!path.isAbsolute(packageRoot)) {
    throw new Error("Frontend feature manifest resolution requires an absolute package root.");
  }

  const configuredPath = configuredManifestPath?.trim() ?? "";
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) {
      throw new Error(
        `${FRONTEND_FEATURE_MANIFEST_ENV} must be an absolute build-time path.`,
      );
    }
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(configuredPath)) {
      throw new Error(
        `${FRONTEND_FEATURE_MANIFEST_ENV} must point to a JavaScript or TypeScript module.`,
      );
    }
    if (!fileIsPresent(configuredPath)) {
      throw new Error(
        `Configured frontend feature manifest is missing at ${configuredPath}.`,
      );
    }
    return configuredPath;
  }

  const publicManifestPath = path.join(
    packageRoot,
    PUBLIC_FRONTEND_FEATURE_MANIFEST_RELATIVE_PATH,
  );
  if (!fileIsPresent(publicManifestPath)) {
    throw new Error(
      `Public frontend feature manifest is missing at ${publicManifestPath}.`,
    );
  }
  return publicManifestPath;
}
