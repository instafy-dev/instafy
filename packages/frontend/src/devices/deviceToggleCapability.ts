import type {
  CapabilityDefinition,
  CapabilityExecutionFailure,
  CapabilityExecutionResult,
  CapabilityExecutor,
  CapabilityInvocation,
} from "@instafy/sdk/capabilities";
import {
  DEVICE_TOGGLE_ACTIONS,
  DEVICE_TOGGLE_CAPABILITY_ID,
} from "./deviceToggleCapabilityMetadata";

export type SimulatedDeviceId = "desk_lamp";
export type SimulatedDevicePowerState = "on" | "off";
export type SimulatedDeviceTargetState = SimulatedDevicePowerState | "toggle";

export interface ResolvedDeviceToggleAction {
  deviceId: SimulatedDeviceId;
  deviceLabel: string;
  targetState: SimulatedDeviceTargetState;
  normalizedPrompt: string;
  summary: string;
}

export interface DeviceToggleInvocationInput {
  prompt: string;
}

export interface DeviceToggleInvocation extends CapabilityInvocation<DeviceToggleInvocationInput> {
  capabilityId: typeof DEVICE_TOGGLE_CAPABILITY_ID;
  actionId: "set_device_power";
}

export interface DeviceToggleExecutionValue {
  action: ResolvedDeviceToggleAction;
  powerState: SimulatedDevicePowerState;
}

export interface DeviceToggleExecutorContext {
  onStatus?: (text: string) => void;
  onCapabilityEvent?: (event: Record<string, unknown>) => void;
}

const SIMULATED_DEVICE_LABELS: Record<SimulatedDeviceId, string> = {
  desk_lamp: "desk lamp",
};

const SIMULATED_DEVICE_POWER = new Map<SimulatedDeviceId, SimulatedDevicePowerState>([
  ["desk_lamp", "off"],
]);

function stripLeadingMention(prompt: string) {
  return prompt.trim().replace(/^@\S+\s*/u, "");
}

function normalizePrompt(prompt: string) {
  return stripLeadingMention(prompt).toLowerCase().replace(/\s+/gu, " ").trim();
}

function resolveDeviceId(normalizedPrompt: string): SimulatedDeviceId | null {
  if (/\b(desk lamp|lamp|light|lights)\b/u.test(normalizedPrompt)) {
    return "desk_lamp";
  }
  return null;
}

function resolveTargetState(normalizedPrompt: string): SimulatedDeviceTargetState | null {
  if (/\b(turn|switch)\s+on\b/u.test(normalizedPrompt) || /\bactivate\b/u.test(normalizedPrompt)) {
    return "on";
  }
  if (/\b(turn|switch)\s+off\b/u.test(normalizedPrompt) || /\bdeactivate\b/u.test(normalizedPrompt)) {
    return "off";
  }
  if (/\btoggle\b/u.test(normalizedPrompt)) {
    return "toggle";
  }
  return null;
}

export function resolveDeviceTogglePrompt(
  prompt: string,
): ResolvedDeviceToggleAction | null {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  const deviceId = resolveDeviceId(normalizedPrompt);
  const targetState = resolveTargetState(normalizedPrompt);
  if (!deviceId || !targetState) {
    return null;
  }

  const deviceLabel = SIMULATED_DEVICE_LABELS[deviceId];
  const summary =
    targetState === "toggle"
      ? `Toggle the ${deviceLabel}`
      : `Turn ${targetState} the ${deviceLabel}`;

  return {
    deviceId,
    deviceLabel,
    targetState,
    normalizedPrompt,
    summary,
  };
}

function applySimulatedDeviceToggleAction(
  action: ResolvedDeviceToggleAction,
): SimulatedDevicePowerState {
  const current = SIMULATED_DEVICE_POWER.get(action.deviceId) ?? "off";
  const next =
    action.targetState === "toggle"
      ? current === "on"
        ? "off"
        : "on"
      : action.targetState;
  SIMULATED_DEVICE_POWER.set(action.deviceId, next);
  return next;
}

export function getSimulatedDevicePowerState(
  deviceId: SimulatedDeviceId,
): SimulatedDevicePowerState {
  return SIMULATED_DEVICE_POWER.get(deviceId) ?? "off";
}

export function resetSimulatedDevicePowerState() {
  SIMULATED_DEVICE_POWER.clear();
  SIMULATED_DEVICE_POWER.set("desk_lamp", "off");
}

export const DEVICE_TOGGLE_CAPABILITY: CapabilityDefinition = {
  id: DEVICE_TOGGLE_CAPABILITY_ID,
  title: "Device toggle",
  description: "Allows an agent to control simulated power-state devices like lamps.",
  actions: DEVICE_TOGGLE_ACTIONS,
  promptContext: {
    summary: "Translate simple natural-language toggle requests into device power changes.",
    instructions: [
      "Use this capability for simple on, off, or toggle requests against known simulated devices.",
      "Keep the response grounded in the declared device list and its current power state.",
    ],
    constraints: [
      "Do not invent devices that are not registered.",
      "If the request does not clearly identify a supported device action, decline and let the normal assistant path handle it.",
    ],
    examples: [
      "@octo turn on the desk lamp",
      "@octo switch off the lamp",
      "@octo toggle the light",
    ],
  },
};

function buildFailure(
  actionId: DeviceToggleInvocation["actionId"],
  error: string,
  code: string,
): CapabilityExecutionFailure {
  return {
    ok: false,
    capabilityId: DEVICE_TOGGLE_CAPABILITY_ID,
    actionId,
    error,
    code,
  };
}

export function createDeviceToggleExecutor(
  context: DeviceToggleExecutorContext,
): CapabilityExecutor<DeviceToggleInvocation, DeviceToggleExecutionValue> {
  return {
    capabilityId: DEVICE_TOGGLE_CAPABILITY_ID,
    execute(
      invocation,
    ): CapabilityExecutionResult<DeviceToggleExecutionValue> {
      const action = resolveDeviceTogglePrompt(invocation.input.prompt);
      if (!action) {
        return buildFailure(
          invocation.actionId,
          "No supported simulated device action matched that prompt.",
          "unknown_device_action",
        );
      }

      context.onStatus?.(`${action.summary}…`);
      context.onCapabilityEvent?.({
        kind: "capability_invocation",
        capability_id: DEVICE_TOGGLE_CAPABILITY_ID,
        action_id: invocation.actionId,
        status: "started",
        device_id: action.deviceId,
        target_state: action.targetState,
      });

      const powerState = applySimulatedDeviceToggleAction(action);

      context.onCapabilityEvent?.({
        kind: "capability_invocation",
        capability_id: DEVICE_TOGGLE_CAPABILITY_ID,
        action_id: invocation.actionId,
        status: "completed",
        device_id: action.deviceId,
        target_state: action.targetState,
        power_state: powerState,
      });
      context.onStatus?.(`Set ${action.deviceLabel} -> ${powerState}`);

      return {
        ok: true,
        capabilityId: DEVICE_TOGGLE_CAPABILITY_ID,
        actionId: invocation.actionId,
        value: {
          action,
          powerState,
        },
      };
    },
  };
}
