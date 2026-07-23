import type { FrontendFeatureModule } from "./frontendFeatureModule";
import { createFrontendFeatureComposition } from "./frontendFeatureModule";
import { createFrontendRegistrationInputs } from "./frontendRegistrationInputs";

export function createFrontendApplicationComposition(
  featureModules: readonly FrontendFeatureModule[],
) {
  const features = createFrontendFeatureComposition(featureModules);
  return Object.freeze({
    features,
    registrations: createFrontendRegistrationInputs(features),
  });
}
