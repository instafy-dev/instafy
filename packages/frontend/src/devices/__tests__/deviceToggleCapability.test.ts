import { beforeEach, describe, expect, it } from "vitest";
import {
  createDeviceToggleExecutor,
  resetSimulatedDevicePowerState,
  resolveDeviceTogglePrompt,
} from "../deviceToggleCapability";

describe("device toggle capability", () => {
  beforeEach(() => {
    resetSimulatedDevicePowerState();
  });

  it("parses supported desk lamp prompts", () => {
    expect(resolveDeviceTogglePrompt("@octo turn on the desk lamp")).toMatchObject({
      deviceId: "desk_lamp",
      targetState: "on",
    });
    expect(resolveDeviceTogglePrompt("@octo switch off the lamp")).toMatchObject({
      deviceId: "desk_lamp",
      targetState: "off",
    });
    expect(resolveDeviceTogglePrompt("@octo hello")).toBeNull();
  });

  it("toggles simulated device state through the executor", () => {
    const executor = createDeviceToggleExecutor({});

    const first = executor.execute({
      capabilityId: "device_toggle",
      actionId: "set_device_power",
      input: {
        prompt: "@octo turn on the desk lamp",
      },
    });
    expect(first).toMatchObject({
      ok: true,
      capabilityId: "device_toggle",
      actionId: "set_device_power",
      value: {
        powerState: "on",
      },
    });

    const second = executor.execute({
      capabilityId: "device_toggle",
      actionId: "set_device_power",
      input: {
        prompt: "@octo toggle the lamp",
      },
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        powerState: "off",
      },
    });
  });
});
