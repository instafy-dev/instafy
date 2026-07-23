import { Capacitor } from "@capacitor/core";
import type {
  NativeHostAudioPermissionState,
  NativeHostAudioSessionSnapshot,
} from "./nativeAudioSessionBridge";

export type HostAudioPermissionState = "granted" | "prompt" | "denied" | "unsupported" | "unknown";

export type HostAudioDeviceSummary = {
  id: string;
  label: string | null;
  kind: "input" | "output" | "other";
  bluetoothLike: boolean;
};

export type HostAudioDiagnostics = {
  platform: string;
  nativePlatform: boolean;
  nativeSession?: NativeHostAudioSessionSnapshot | null;
  capture: {
    getUserMedia: boolean;
    mediaRecorder: boolean;
    speechRecognition: boolean;
    microphonePermission: HostAudioPermissionState;
  };
  playback: {
    htmlAudio: boolean;
    speechSynthesis: boolean;
    outputDeviceSelection: boolean;
  };
  devices: {
    enumerateSupported: boolean;
    labelsVisible: boolean;
    inputCount: number;
    outputCount: number;
    bluetoothLikeOutputLabels: string[];
    preferredOutputLabel: string | null;
    inputs: HostAudioDeviceSummary[];
    outputs: HostAudioDeviceSummary[];
  };
};

type MediaDeviceLike = {
  deviceId?: string;
  kind?: string;
  label?: string;
};

type NativeAudioPermissionOverride = NativeHostAudioPermissionState | null | undefined;

const BLUETOOTH_AUDIO_LABEL_PATTERN =
  /\b(airpods|beats|bluetooth|headset|headphone|earbuds?|hands-?free|speakerphone|pods)\b/i;

function getWebSpeechRecognitionConstructor(): unknown {
  if (typeof window === "undefined") {
    return null;
  }
  const source = window as Window & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return source.SpeechRecognition ?? source.webkitSpeechRecognition ?? null;
}

function canUseSpeechSynthesis() {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

function canSelectAudioOutput() {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function"
  );
}

export function isBluetoothLikeAudioLabel(label: string | null | undefined) {
  return typeof label === "string" && BLUETOOTH_AUDIO_LABEL_PATTERN.test(label.trim());
}

function normalizeDeviceKind(kind: string | undefined): "input" | "output" | "other" {
  if (kind === "audioinput") {
    return "input";
  }
  if (kind === "audiooutput") {
    return "output";
  }
  return "other";
}

function normalizeAudioDevice(device: MediaDeviceLike): HostAudioDeviceSummary {
  const label = typeof device.label === "string" && device.label.trim().length > 0
    ? device.label.trim()
    : null;
  return {
    id: typeof device.deviceId === "string" ? device.deviceId : "",
    label,
    kind: normalizeDeviceKind(device.kind),
    bluetoothLike: isBluetoothLikeAudioLabel(label),
  };
}

export function selectPreferredAudioOutputLabel(outputs: HostAudioDeviceSummary[]) {
  const bluetoothOutput = outputs.find((device) => device.bluetoothLike && device.label);
  if (bluetoothOutput?.label) {
    return bluetoothOutput.label;
  }
  const labeledOutput = outputs.find((device) => device.label);
  return labeledOutput?.label ?? null;
}

function synthesizeNativeAudioDevices(
  labels: string[],
  kind: "input" | "output",
): HostAudioDeviceSummary[] {
  return labels
    .map((label) => (typeof label === "string" ? label.trim() : ""))
    .filter((label) => label.length > 0)
    .map((label, index) => ({
      id: `native-${kind}-${index}`,
      label,
      kind,
      bluetoothLike: isBluetoothLikeAudioLabel(label),
    }));
}

function applyNativeMicrophonePermission(
  fallback: HostAudioPermissionState,
  override: NativeAudioPermissionOverride,
): HostAudioPermissionState {
  if (!override || override === "unknown") {
    return fallback;
  }
  return override;
}

export function describeHostAudioDiagnostics(diagnostics: HostAudioDiagnostics | null) {
  if (!diagnostics) {
    return "Audio diagnostics unavailable.";
  }
  const parts = [];
  parts.push(
    diagnostics.capture.microphonePermission === "granted"
      ? "Mic permission granted"
      : diagnostics.capture.microphonePermission === "prompt"
        ? "Mic permission pending"
        : diagnostics.capture.microphonePermission === "denied"
          ? "Mic permission denied"
          : "Mic permission unknown",
  );
  parts.push(
    diagnostics.devices.preferredOutputLabel
      ? `Preferred output: ${diagnostics.devices.preferredOutputLabel}`
      : diagnostics.devices.outputCount > 0
        ? `${diagnostics.devices.outputCount} audio outputs visible`
        : "No audio output labels visible yet",
  );
  return parts.join(" · ");
}

export function applyNativeHostAudioSessionSnapshot(
  diagnostics: HostAudioDiagnostics,
  nativeSession: NativeHostAudioSessionSnapshot | null | undefined,
): HostAudioDiagnostics {
  if (!nativeSession) {
    return {
      ...diagnostics,
      nativeSession: null,
    };
  }

  const nativeInputs = synthesizeNativeAudioDevices(nativeSession.inputLabels, "input");
  const nativeOutputs = synthesizeNativeAudioDevices(nativeSession.outputLabels, "output");
  const preferredOutputLabel =
    nativeSession.preferredOutputLabel ??
    selectPreferredAudioOutputLabel(nativeOutputs) ??
    diagnostics.devices.preferredOutputLabel;
  const bluetoothLikeOutputLabels =
    nativeSession.bluetoothLikeOutputLabels.length > 0
      ? [...nativeSession.bluetoothLikeOutputLabels]
      : nativeOutputs.filter((device) => device.bluetoothLike && device.label).map((device) => device.label as string);

  return {
    ...diagnostics,
    nativeSession,
    capture: {
      ...diagnostics.capture,
      microphonePermission: applyNativeMicrophonePermission(
        diagnostics.capture.microphonePermission,
        nativeSession.microphonePermission,
      ),
    },
    devices: {
      ...diagnostics.devices,
      labelsVisible:
        diagnostics.devices.labelsVisible ||
        nativeInputs.some((device) => Boolean(device.label)) ||
        nativeOutputs.some((device) => Boolean(device.label)),
      inputCount: nativeInputs.length > 0 ? nativeInputs.length : diagnostics.devices.inputCount,
      outputCount: nativeOutputs.length > 0 ? nativeOutputs.length : diagnostics.devices.outputCount,
      bluetoothLikeOutputLabels:
        nativeOutputs.length > 0 || nativeSession.bluetoothLikeOutputLabels.length > 0
          ? bluetoothLikeOutputLabels
          : diagnostics.devices.bluetoothLikeOutputLabels,
      preferredOutputLabel,
      inputs: nativeInputs.length > 0 ? nativeInputs : diagnostics.devices.inputs,
      outputs: nativeOutputs.length > 0 ? nativeOutputs : diagnostics.devices.outputs,
    },
  };
}

async function readMicrophonePermission(): Promise<HostAudioPermissionState> {
  if (typeof navigator === "undefined" || !("permissions" in navigator)) {
    return "unsupported";
  }
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted" || status.state === "prompt" || status.state === "denied") {
      return status.state;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function enumerateAudioDevices() {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.enumerateDevices !== "function") {
    return {
      enumerateSupported: false,
      inputs: [] as HostAudioDeviceSummary[],
      outputs: [] as HostAudioDeviceSummary[],
    };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const normalized = devices.map((device) => normalizeAudioDevice(device));
    return {
      enumerateSupported: true,
      inputs: normalized.filter((device) => device.kind === "input"),
      outputs: normalized.filter((device) => device.kind === "output"),
    };
  } catch {
    return {
      enumerateSupported: true,
      inputs: [] as HostAudioDeviceSummary[],
      outputs: [] as HostAudioDeviceSummary[],
    };
  }
}

export async function readHostAudioDiagnostics(): Promise<HostAudioDiagnostics> {
  const deviceSummary = await enumerateAudioDevices();
  const preferredOutputLabel = selectPreferredAudioOutputLabel(deviceSummary.outputs);
  const bluetoothLikeOutputLabels = deviceSummary.outputs
    .filter((device) => device.bluetoothLike && device.label)
    .map((device) => device.label as string);

  return {
    platform: Capacitor.getPlatform(),
    nativePlatform: Capacitor.isNativePlatform(),
    nativeSession: null,
    capture: {
      getUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
      mediaRecorder: typeof MediaRecorder !== "undefined",
      speechRecognition: Boolean(getWebSpeechRecognitionConstructor()),
      microphonePermission: await readMicrophonePermission(),
    },
    playback: {
      htmlAudio: typeof Audio !== "undefined",
      speechSynthesis: canUseSpeechSynthesis(),
      outputDeviceSelection: canSelectAudioOutput(),
    },
    devices: {
      enumerateSupported: deviceSummary.enumerateSupported,
      labelsVisible:
        deviceSummary.inputs.some((device) => Boolean(device.label)) ||
        deviceSummary.outputs.some((device) => Boolean(device.label)),
      inputCount: deviceSummary.inputs.length,
      outputCount: deviceSummary.outputs.length,
      bluetoothLikeOutputLabels,
      preferredOutputLabel,
      inputs: deviceSummary.inputs,
      outputs: deviceSummary.outputs,
    },
  };
}
