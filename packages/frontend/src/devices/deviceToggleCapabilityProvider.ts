import type { CapabilityProviderDefinition } from "@instafy/sdk/capabilities";
import { DEVICE_TOGGLE_CAPABILITY } from "./deviceToggleCapability";

export const LOCAL_DEVICE_TOGGLE_CAPABILITY_PROVIDER: CapabilityProviderDefinition = {
  id: "local_device_toggle",
  title: "Local device toggle provider",
  description: "Registers simulated device power controls that execute through the local provider host.",
  capabilities: [DEVICE_TOGGLE_CAPABILITY],
};
