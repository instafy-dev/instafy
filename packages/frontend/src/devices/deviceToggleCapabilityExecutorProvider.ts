import type { CapabilityExecutorProviderDefinition } from "@instafy/sdk/capabilities";
import {
  createDeviceToggleExecutor,
  type DeviceToggleExecutorContext,
} from "./deviceToggleCapability";

export interface LocalDeviceToggleCapabilityExecutorContext {
  deviceToggle: DeviceToggleExecutorContext | null;
}

export const LOCAL_DEVICE_TOGGLE_CAPABILITY_EXECUTOR_PROVIDER: CapabilityExecutorProviderDefinition<LocalDeviceToggleCapabilityExecutorContext> = {
  id: "local_device_toggle_executor",
  title: "Local device toggle executor provider",
  description: "Registers local simulated device toggle executors against the current frontend environment.",
  createExecutors: (context) =>
    context.deviceToggle ? [createDeviceToggleExecutor(context.deviceToggle)] : [],
};
