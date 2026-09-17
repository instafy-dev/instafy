import type {
  KnoshRuntimeStatus,
  RobotPowerStatusValue,
  RobotRuntimeStatusValue,
} from "../robot";

export type KnoshRuntimeOrientation = "portrait" | "landscape";
export type KnoshRuntimeInteractionMode = "actions" | "conversation";
export type KnoshVoiceInteractionMode = "hold" | "tap" | "continuous";
export const KNOSH_RUNTIME_ONBOARDING_STORAGE_KEY = "instafy:knosh-runtime:onboarding-dismissed";
export const KNOSH_RUNTIME_VOICE_INTERACTION_MODE_STORAGE_KEY =
  "instafy:knosh-runtime:voice-interaction-mode";

export type KnoshFaceMood =
  | "idle"
  | "listening"
  | "speaking"
  | "thinking"
  | "acting"
  | "sleeping"
  | "error";

export function inferKnoshRuntimeOrientation(
  width: number,
  height: number,
): KnoshRuntimeOrientation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "portrait";
  }
  return height >= width ? "portrait" : "landscape";
}

export function selectKnoshFaceMood(options: {
  voiceStarting: boolean;
  voiceListening: boolean;
  speaking: boolean;
  actionBusy: boolean;
  connected: boolean;
  error: string | null;
  lastPrompt: string | null;
}): KnoshFaceMood {
  const prompt = options.lastPrompt?.trim().toLowerCase() ?? "";

  if (options.error) {
    return "error";
  }
  if (options.voiceListening || options.voiceStarting) {
    return "listening";
  }
  if (options.speaking) {
    return "speaking";
  }
  if (options.actionBusy) {
    return "thinking";
  }
  if (/\b(sleep|good night|rest|nap|power down)\b/.test(prompt)) {
    return "sleeping";
  }
  if (/\b(stop|wake up|look|greet|come here|scan|turn)\b/.test(prompt)) {
    return "acting";
  }
  return options.connected ? "idle" : "sleeping";
}

export function summarizeKnoshRuntimeHardware(options: {
  deviceStatus: KnoshRuntimeStatus | null;
  providerRuntimeStatus: RobotRuntimeStatusValue | null;
  powerStatus: RobotPowerStatusValue | null;
}): string[] {
  const items: string[] = [];
  const connected = options.deviceStatus?.connection.connected === true;
  const ready = options.deviceStatus?.connection.ready === true;
  const batteryVoltage = options.powerStatus?.battery_voltage_v;
  const watchdogState = options.powerStatus?.watchdog_state?.trim();
  const backendId =
    options.providerRuntimeStatus?.configured_runtime_backend_id?.trim() ||
    options.providerRuntimeStatus?.preferred_runtime_backend_id?.trim();

  items.push(
    ready ? "Connected" : connected ? "Connecting" : "Waiting for Knosh",
  );

  if (typeof batteryVoltage === "number" && Number.isFinite(batteryVoltage)) {
    items.push(`${batteryVoltage.toFixed(2)}V`);
  }

  if (watchdogState) {
    items.push(watchdogState === "ok" ? "Watchdog ok" : `Watchdog ${watchdogState}`);
  }

  if (backendId) {
    items.push(backendId);
  }

  return items;
}

export function normalizeKnoshConversationPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    return trimmed;
  }
  return `@knosh ${trimmed}`;
}

export function getKnoshVoiceInteractionModeStorageKey(projectId?: string | null) {
  const normalizedProjectId =
    typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
  return normalizedProjectId
    ? `${KNOSH_RUNTIME_VOICE_INTERACTION_MODE_STORAGE_KEY}:${normalizedProjectId}`
    : KNOSH_RUNTIME_VOICE_INTERACTION_MODE_STORAGE_KEY;
}

export function readKnoshVoiceInteractionMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
): KnoshVoiceInteractionMode {
  if (!storage) {
    return "hold";
  }
  const storedValue = storage.getItem(getKnoshVoiceInteractionModeStorageKey(projectId))?.trim();
  return storedValue === "tap" || storedValue === "continuous" ? storedValue : "hold";
}

export function writeKnoshVoiceInteractionMode(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  mode: KnoshVoiceInteractionMode,
  projectId?: string | null,
) {
  if (!storage) {
    return;
  }
  const key = getKnoshVoiceInteractionModeStorageKey(projectId);
  if (mode === "hold") {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, mode);
}
