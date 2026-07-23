import type { HostAudioPermissionState } from "./audioSessionDiagnostics";
import { ensureNativeHostMicrophonePermission } from "./nativeAudioSessionBridge";

function getErrorName(error: unknown) {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return null;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function requestBrowserMicrophonePermission(): Promise<HostAudioPermissionState> {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return "unsupported";
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (error) {
    const errorName = getErrorName(error)?.toLowerCase() ?? "";
    const message = getErrorMessage(error).toLowerCase();
    if (
      errorName === "notallowederror" ||
      errorName === "permissiondeniederror" ||
      message.includes("permission") ||
      message.includes("denied") ||
      message.includes("not allowed")
    ) {
      return "denied";
    }
    return "unknown";
  }
}

export async function requestHostMicrophonePermission(): Promise<HostAudioPermissionState> {
  const nativePermission = await ensureNativeHostMicrophonePermission();
  if (nativePermission === "granted" || nativePermission === "denied") {
    return nativePermission;
  }
  return await requestBrowserMicrophonePermission();
}

export function shouldShowHostMicrophonePermissionNotice(permission: HostAudioPermissionState | null | undefined) {
  return permission === "prompt" || permission === "denied";
}

export function describeHostMicrophonePermissionNotice(permission: HostAudioPermissionState | null | undefined) {
  if (permission === "denied") {
    return {
      title: "Microphone access is blocked",
      description:
        "Voice capture needs both macOS and browser-site microphone access. If you just approved macOS access, request again here; if it stays blocked, allow microphone access for this site in the browser.",
      actionLabel: "Request again",
    };
  }
  return {
    title: "Microphone access is waiting",
    description:
      "Approve the system microphone prompt for this device, then try hold-to-talk again.",
    actionLabel: "Allow microphone",
  };
}
