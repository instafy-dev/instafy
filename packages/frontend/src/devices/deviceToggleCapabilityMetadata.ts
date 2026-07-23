import type { CapabilityActionDefinition } from "@instafy/sdk/capabilities";

export const DEVICE_TOGGLE_CAPABILITY_ID = "device_toggle";
export const SIMULATED_DEVICE_PROVIDER_ID = "simulated-devices";
export const DEVICE_TOGGLE_SET_POWER_TOOL_ID = "instafy.device_toggle.set_power";
export const DEVICE_TOGGLE_STATE_RESOURCE_URI = "instafy://devices/desk_lamp/state";
export const DEVICE_TOGGLE_STATUS_SUMMARY_RESOURCE_URI = "instafy://devices/status-summary";

export const DEVICE_TOGGLE_ACTIONS: CapabilityActionDefinition[] = [
  {
    id: "set_device_power",
    title: "Set device power",
    description: "Turn a simulated device on, off, or toggle it.",
  },
  {
    id: "get_device_state",
    title: "Get device state",
    description: "Read the current state of a simulated device.",
  },
];

export const DEVICE_TOGGLE_ACTION_IDS = DEVICE_TOGGLE_ACTIONS.map((action) => action.id);
