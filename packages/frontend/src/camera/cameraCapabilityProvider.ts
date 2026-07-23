import type { CapabilityProviderDefinition } from "@instafy/sdk/capabilities";
import { CAMERA_OBSERVATION_CAPABILITY } from "./cameraObservationCapability";

export const LOCAL_CAMERA_CAPABILITY_PROVIDER: CapabilityProviderDefinition = {
  id: "local_camera",
  title: "Local camera provider",
  description: "Registers provider-backed camera observation for the current Instafy frontend environment.",
  capabilities: [CAMERA_OBSERVATION_CAPABILITY],
};
