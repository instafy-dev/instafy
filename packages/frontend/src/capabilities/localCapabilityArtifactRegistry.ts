import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import type {
  LocalCapabilityArtifact,
  LocalCapabilityArtifactRegistration,
  LocalCapabilityConversationMessage,
} from "./localCapabilityContributions";

export type ResolvedLocalCapabilityArtifact = {
  artifact: LocalCapabilityArtifact;
  registration: LocalCapabilityArtifactRegistration;
};

export function resolveLocalCapabilityArtifact(
  message: LocalCapabilityConversationMessage,
): ResolvedLocalCapabilityArtifact | null {
  for (const registration of APPLICATION_FRONTEND_FEATURES.localCapabilityArtifactRegistrations) {
    const artifact = registration.extract(message);
    if (artifact) {
      return { artifact, registration };
    }
  }
  return null;
}
