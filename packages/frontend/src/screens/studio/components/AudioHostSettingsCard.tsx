import { Card } from "../../../components/Card";
import { FactGrid, type FactGridItem } from "../../../components/FactGrid";
import { Text } from "../../../components/Text";
import type { HostAudioDiagnostics } from "../../../audio/audioSessionDiagnostics";
import {
  deriveHostHandsFreeVoiceAvailability,
  type HostAudioSessionState,
} from "../../../audio/hostAudioSessionState";
import { HostMicrophonePermissionNotice } from "../../../audio/HostMicrophonePermissionNotice";

type AudioHostSettingsCardProps = {
  diagnostics: HostAudioDiagnostics | null;
  sessionState?: HostAudioSessionState | null;
  loading?: boolean;
  error?: string | null;
  microphonePermissionRequesting?: boolean;
  microphonePermissionError?: string | null;
  onRequestMicrophonePermission?: (() => void) | null;
  presentation?: "default" | "embedded";
};

function describeSessionPhase(value: HostAudioSessionState | null) {
  if (!value) {
    return "Unknown";
  }
  switch (value.phase) {
    case "interrupted":
      return "Interrupted";
    case "activating":
      return "Activating";
    case "recording":
      return "Recording";
    case "transcribing":
      return "Transcribing";
    case "background":
      return "Backgrounded";
    default:
      return "Idle";
  }
}

function describeRouteKind(value: HostAudioSessionState | null) {
  if (!value) {
    return "Unknown";
  }
  switch (value.routeKind) {
    case "bluetooth":
      return "Bluetooth headset";
    case "speaker":
      return "Phone speaker";
    case "receiver":
      return "Phone earpiece";
    case "wired_or_builtin":
      return "Built-in or wired";
    default:
      return "Unknown";
  }
}

function describeCapturePath(value: HostAudioDiagnostics | null) {
  if (!value) {
    return "Unknown";
  }
  if (value.nativeSession) {
    return "Native audio session active";
  }
  if (value.capture.getUserMedia) {
    return value.capture.mediaRecorder ? "Mic + recorder ready" : "Mic ready, recorder missing";
  }
  return "Capture unavailable";
}

function describePlaybackPath(value: HostAudioDiagnostics | null) {
  if (!value) {
    return "Unknown";
  }
  if (value.nativeSession) {
    return value.playback.speechSynthesis ? "Native playback ready" : "Native diagnostics only";
  }
  if (value.playback.speechSynthesis) {
    return "Speech playback ready";
  }
  if (value.playback.htmlAudio) {
    return "Audio playback ready";
  }
  return "Playback unavailable";
}

function describeHandsFreeDetail(value: ReturnType<typeof deriveHostHandsFreeVoiceAvailability>) {
  switch (value.state) {
    case "checking":
      return "Checking voice readiness on this device.";
    case "foreground_only":
      return "Voice works while Instafy stays open and awake.";
    case "background_paused":
      return "Bring Instafy back to the foreground to resume.";
    default:
      return value.detail;
  }
}

function describeSummaryLine(options: {
  diagnostics: HostAudioDiagnostics | null;
  sessionState: HostAudioSessionState | null;
  error?: string | null;
}): string | null {
  const { diagnostics, sessionState, error } = options;
  if (error) {
    return error;
  }
  if (sessionState?.warnings.length) {
    return sessionState.warnings[0] ?? "Audio status needs attention.";
  }
  if (diagnostics) {
    if (diagnostics.capture.microphonePermission === "prompt" || diagnostics.capture.microphonePermission === "denied") {
      return null;
    }
    if (diagnostics.devices.bluetoothLikeOutputLabels.length > 0) {
      return `Headset route detected: ${diagnostics.devices.bluetoothLikeOutputLabels.join(", ")}.`;
    }
    if (diagnostics.devices.labelsVisible) {
      return "No headset route detected right now.";
    }
    return "Audio device labels may stay hidden until media permission is granted.";
  }
  return "Audio diagnostics are still loading.";
}

function describeMicPermission(value: HostAudioDiagnostics | null) {
  const permission = value?.capture.microphonePermission ?? "unknown";
  switch (permission) {
    case "granted":
      return "Granted";
    case "prompt":
      return "Prompt";
    case "denied":
      return "Denied";
    case "unsupported":
      return "Unsupported";
    default:
      return "Unknown";
  }
}

function describePreferredOutput(value: HostAudioDiagnostics | null) {
  if (!value) {
    return "Unknown";
  }
  if (value.devices.preferredOutputLabel) {
    return value.devices.preferredOutputLabel;
  }
  if (value.devices.outputCount > 0) {
    return `${value.devices.outputCount} output${value.devices.outputCount === 1 ? "" : "s"}`;
  }
  return "No labeled outputs";
}

function shouldShowTransportDetails(options: {
  diagnostics: HostAudioDiagnostics | null;
  sessionState: HostAudioSessionState | null;
}) {
  const microphonePermission = options.diagnostics?.capture.microphonePermission ?? "unknown";
  return (
    microphonePermission === "granted" ||
    options.diagnostics?.nativeSession != null ||
    (options.sessionState !== null && options.sessionState.phase !== "idle")
  );
}

function buildAudioSummaryFacts(options: {
  diagnostics: HostAudioDiagnostics | null;
  sessionState: HostAudioSessionState | null;
  loading: boolean;
  handsFreeLabel: string;
}): FactGridItem[] {
  const primaryFacts: FactGridItem[] = [
    {
      label: "Microphone",
      value: options.loading ? "Checking…" : describeMicPermission(options.diagnostics),
      valueTestId: "settings-audio-mic-permission",
    },
    {
      label: "Output",
      value: options.loading ? "Checking…" : describePreferredOutput(options.diagnostics),
      valueTestId: "settings-audio-output-route",
    },
    {
      label: "Audio session",
      value: options.loading ? "Checking…" : describeSessionPhase(options.sessionState),
      valueTestId: "settings-audio-session-phase",
    },
    {
      label: "Voice status",
      value: options.handsFreeLabel,
      valueTestId: "settings-audio-hands-free-status",
    },
  ];

  if (!shouldShowTransportDetails(options)) {
    return primaryFacts;
  }

  return [
    ...primaryFacts,
    {
      label: "Route",
      value: options.loading ? "Checking…" : describeRouteKind(options.sessionState),
      valueTestId: "settings-audio-route-kind",
    },
    {
      label: "Capture",
      value: describeCapturePath(options.diagnostics),
      valueTestId: "settings-audio-capture",
    },
    {
      label: "Playback",
      value: describePlaybackPath(options.diagnostics),
      valueTestId: "settings-audio-playback",
    },
  ];
}

export function AudioHostSettingsCard({
  diagnostics,
  sessionState = null,
  loading = false,
  error = null,
  microphonePermissionRequesting = false,
  microphonePermissionError = null,
  onRequestMicrophonePermission = null,
  presentation = "default",
}: AudioHostSettingsCardProps) {
  const microphonePermission = diagnostics?.capture.microphonePermission ?? null;
  const handsFreeAvailability = deriveHostHandsFreeVoiceAvailability({
    diagnostics,
    sessionState,
  });
  const summaryLine = describeSummaryLine({ diagnostics, sessionState, error });
  const summaryFacts = buildAudioSummaryFacts({
    diagnostics,
    sessionState,
    loading,
    handsFreeLabel: handsFreeAvailability.label,
  });
  const content = (
    <div className="flex flex-col gap-3">
      {presentation === "default" ? (
        <div className="space-y-1">
          <Text variant="bodyStrong" tone="secondary">
            Host audio
          </Text>
          <Text variant="caption" tone="muted">
            Shared microphone, playback, and route readiness for this device.
          </Text>
        </div>
      ) : null}

      <FactGrid items={summaryFacts} valueVariant="bodyStrong" />

      <div className="space-y-1">
        <Text variant="caption" tone="muted" data-testid="settings-audio-hands-free-detail">
          {describeHandsFreeDetail(handsFreeAvailability)}
        </Text>
      </div>

      {summaryLine ? (
        <Text variant="caption" tone="muted">
          {summaryLine}
        </Text>
      ) : null}

      <HostMicrophonePermissionNotice
        permission={microphonePermission}
        requesting={microphonePermissionRequesting}
        error={microphonePermissionError}
        onRequest={onRequestMicrophonePermission}
        testIdPrefix="settings-audio-mic"
      />
    </div>
  );

  if (presentation === "embedded") {
    return content;
  }

  return (
    <Card tone="default" radius="2xl" shadow="none" padding="sm" className="py-3">
      {content}
    </Card>
  );
}
