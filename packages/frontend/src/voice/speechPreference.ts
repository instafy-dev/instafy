import { selectVoiceTurnCaptureRoute } from "./useVoiceTurnController";

export const PROJECT_SPEECH_MODE_STORAGE_KEY = "instafy:project-speech:mode";
export const PROJECT_PROVIDER_VOICE_STORAGE_KEY = "instafy:project-speech:provider-voice";
export const PROJECT_DEVICE_VOICE_STORAGE_KEY = "instafy:project-speech:device-voice";
export type ProjectSpeechMode = "auto" | "provider" | "device";

export function getProjectSpeechModeStorageKey(projectId?: string | null): string {
  const normalizedProjectId =
    typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
  return normalizedProjectId
    ? `${PROJECT_SPEECH_MODE_STORAGE_KEY}:${normalizedProjectId}`
    : PROJECT_SPEECH_MODE_STORAGE_KEY;
}

export function readProjectSpeechMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
): ProjectSpeechMode {
  if (!storage) {
    return "auto";
  }
  const storedValue = storage.getItem(getProjectSpeechModeStorageKey(projectId))?.trim();
  return storedValue === "provider" || storedValue === "device" || storedValue === "auto"
    ? storedValue
    : "auto";
}

export function writeProjectSpeechMode(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  mode: ProjectSpeechMode,
  projectId?: string | null,
) {
  if (!storage) {
    return;
  }
  const key = getProjectSpeechModeStorageKey(projectId);
  if (mode === "auto") {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, mode);
}

export function selectSpeechCaptureRoute(options: {
  mode: ProjectSpeechMode;
  hostedVoiceSupported: boolean;
  localVoiceSupported: boolean;
  interactionMode: "actions" | "conversation";
}) {
  return selectVoiceTurnCaptureRoute({
    mode: options.mode,
    hostedVoiceSupported: options.hostedVoiceSupported,
    localVoiceSupported: options.localVoiceSupported,
    preferHostedCapture: options.interactionMode === "conversation",
  });
}

export function describeSpeechMode(mode: ProjectSpeechMode) {
  switch (mode) {
    case "provider":
      return "Use the shared speech host for transcription and replies.";
    case "device":
      return "Keep speech on this device.";
    case "auto":
    default:
      return "Use the shared speech host when ready, otherwise this device.";
  }
}

function getProjectScopedStorageKey(baseKey: string, projectId?: string | null): string {
  const normalizedProjectId =
    typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
  return normalizedProjectId ? `${baseKey}:${normalizedProjectId}` : baseKey;
}

function readOptionalStorageValue(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string,
): string | null {
  if (!storage) {
    return null;
  }
  const value = storage.getItem(key)?.trim();
  return value ? value : null;
}

function writeOptionalStorageValue(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  key: string,
  value: string | null | undefined,
) {
  if (!storage) {
    return;
  }
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, normalizedValue);
}

export function getProjectProviderVoiceStorageKey(projectId?: string | null) {
  return getProjectScopedStorageKey(PROJECT_PROVIDER_VOICE_STORAGE_KEY, projectId);
}

export function getProjectDeviceVoiceStorageKey(projectId?: string | null) {
  return getProjectScopedStorageKey(PROJECT_DEVICE_VOICE_STORAGE_KEY, projectId);
}

export function readProjectProviderVoicePreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
) {
  return readOptionalStorageValue(storage, getProjectProviderVoiceStorageKey(projectId));
}

export function writeProjectProviderVoicePreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  voiceId: string | null | undefined,
  projectId?: string | null,
) {
  writeOptionalStorageValue(storage, getProjectProviderVoiceStorageKey(projectId), voiceId);
}

export function readProjectDeviceVoicePreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  projectId?: string | null,
) {
  return readOptionalStorageValue(storage, getProjectDeviceVoiceStorageKey(projectId));
}

export function writeProjectDeviceVoicePreference(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  voiceId: string | null | undefined,
  projectId?: string | null,
) {
  writeOptionalStorageValue(storage, getProjectDeviceVoiceStorageKey(projectId), voiceId);
}
