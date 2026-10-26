import type { CapabilityProviderDefinition } from "@instafy/sdk/capabilities";
import { ROBOT_EMBODIMENT_CAPABILITY } from "./robotCapability";

export const LOCAL_ROBOT_CAPABILITY_PROVIDER: CapabilityProviderDefinition = {
  id: "local_robot",
  title: "Local robot provider",
  description: "Registers local embodied robot control against the current Instafy frontend environment.",
  capabilities: [ROBOT_EMBODIMENT_CAPABILITY],
};
