import { useMemo } from "react";
import { Text } from "../../../components/Text";
import type { HostAudioDiagnostics } from "../../../audio/audioSessionDiagnostics";
import { type HostAudioPermissionState } from "../../../audio/audioSessionDiagnostics";
import {
  deriveHostHandsFreeVoiceAvailability,
  type HostAudioSessionState,
} from "../../../audio/hostAudioSessionState";
import type { ProviderSettingsSurfaceEntry } from "../../../providers/providerSettingsSurfaces";
import type { ProjectSpeechPreferences } from "../../../voice/projectSpeechPreferences";
import {
  describeSpeechServiceConnection,
  type SpeechDependencyStatus,
} from "../../../voice/speechService";
import { AudioHostSettingsCard } from "./AudioHostSettingsCard";
import { ProviderShellSurface } from "./ProviderShellSurface";
import { SettingsSurface } from "./SettingsSurface";

type ProjectAiOverridesSettingsProps = {
  selectedItemId: string | null;
  speechDependencyStatus: SpeechDependencyStatus | null;
  speechPreferenceSource: ProjectSpeechPreferences["source"];
  providerSettingsSurfaceEntries: ProviderSettingsSurfaceEntry[];
  hostAudioDiagnostics: HostAudioDiagnostics | null;
  hostAudioSessionState: HostAudioSessionState | null;
  hostAudioDiagnosticsLoading?: boolean;
  hostAudioDiagnosticsError?: string | null;
  microphonePermissionRequesting?: boolean;
  microphonePermissionError?: string | null;
  onRequestMicrophonePermission?: (() => void) | null;
};

export type ProjectAiOverrideItem = {
  id: string;
  label: string;
  subtitle: string;
  kind: "provider" | "audio";
  familyId?: string;
  badgeLabel?: string;
  badgeTone?: "neutral" | "success" | "warning" | "danger" | "info";
};

type ProviderSettingsGroup = {
  familyId: string;
  title: string;
  subtitle: string;
  entries: ProviderSettingsSurfaceEntry[];
  badgeLabel?: string;
  badgeTone?: "neutral" | "success" | "warning" | "danger" | "info";
};

function mapSpeechBadgeTone(
  tone: ReturnType<typeof describeSpeechServiceConnection>["badgeTone"],
): ProviderSettingsGroup["badgeTone"] {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    default:
      return "neutral";
  }
}

function mapAudioBadgeTone(
  state: ReturnType<typeof deriveHostHandsFreeVoiceAvailability>["state"],
): ProviderSettingsGroup["badgeTone"] {
  switch (state) {
    case "foreground_only":
      return "success";
    case "unavailable":
    case "background_paused":
      return "warning";
    default:
      return "neutral";
  }
}

function describeSpeechListSubtitle(source: ProjectSpeechPreferences["source"]) {
  switch (source) {
    case "project":
      return "This space is using its own speech override.";
    case "local":
      return "This client is using a local default when no space override is saved.";
    default:
      return "This space is currently using shared defaults.";
  }
}

function describeHostAudioListSubtitle(options: {
  loading: boolean;
  error: string | null;
  availability: ReturnType<typeof deriveHostHandsFreeVoiceAvailability>;
  microphonePermission: HostAudioPermissionState;
}) {
  if (options.error) {
    return options.error;
  }
  if (options.loading) {
    return "Checking device audio readiness.";
  }
  switch (options.availability.state) {
    case "foreground_only":
      return "Mic and playback are ready while Instafy stays open.";
    case "background_paused":
      return "Voice pauses when Instafy leaves the foreground.";
    case "unavailable":
      return options.microphonePermission === "denied"
        ? "Grant microphone access to use voice on this device."
        : "Voice capture or playback still needs attention.";
    default:
      return "Checking device audio readiness.";
  }
}

function buildProviderSettingsGroups(options: {
  providerSettingsSurfaceEntries: ProviderSettingsSurfaceEntry[];
  speechDependencyStatus: SpeechDependencyStatus | null;
  speechPreferenceSource: ProjectSpeechPreferences["source"];
}) {
  const groups = new Map<string, ProviderSettingsGroup>();
  const speechSummary = describeSpeechServiceConnection(options.speechDependencyStatus);

  for (const surfaceEntry of options.providerSettingsSurfaceEntries) {
    const familyId = surfaceEntry.familyId;
    const existing = groups.get(familyId);
    if (existing) {
      existing.entries.push(surfaceEntry);
      continue;
    }

    const providerTitle = surfaceEntry.entry.provider.title?.trim() || "Provider";
    const subtitle =
      familyId === "speech"
        ? describeSpeechListSubtitle(options.speechPreferenceSource)
        : surfaceEntry.entry.surface.description?.trim() ||
          surfaceEntry.entry.provider.description?.trim() ||
          `${providerTitle} settings for this space.`;

    groups.set(familyId, {
      familyId,
      title: familyId === "speech" ? "Speech provider" : providerTitle,
      subtitle,
      entries: [surfaceEntry],
      badgeLabel: familyId === "speech" ? speechSummary.badgeLabel : undefined,
      badgeTone: familyId === "speech" ? mapSpeechBadgeTone(speechSummary.badgeTone) : undefined,
    });
  }

  return Array.from(groups.values());
}

export function listProjectAiOverrideItems(options: {
  providerSettingsSurfaceEntries: ProviderSettingsSurfaceEntry[];
  speechDependencyStatus: SpeechDependencyStatus | null;
  speechPreferenceSource: ProjectSpeechPreferences["source"];
  hostAudioDiagnostics: HostAudioDiagnostics | null;
  hostAudioSessionState: HostAudioSessionState | null;
  hostAudioDiagnosticsLoading?: boolean;
  hostAudioDiagnosticsError?: string | null;
}): ProjectAiOverrideItem[] {
  const providerGroups = buildProviderSettingsGroups({
    providerSettingsSurfaceEntries: options.providerSettingsSurfaceEntries,
    speechDependencyStatus: options.speechDependencyStatus,
    speechPreferenceSource: options.speechPreferenceSource,
  });
  const hostAudioAvailability = deriveHostHandsFreeVoiceAvailability({
    diagnostics: options.hostAudioDiagnostics,
    sessionState: options.hostAudioSessionState,
  });

  return [
    ...providerGroups.map((group) => ({
      id: `provider:${group.familyId}`,
      label: group.title,
      subtitle: group.subtitle,
      kind: "provider" as const,
      familyId: group.familyId,
      badgeLabel: group.badgeLabel,
      badgeTone: group.badgeTone,
    })),
    {
      id: "audio",
      label: "Host audio",
      subtitle: describeHostAudioListSubtitle({
        loading: options.hostAudioDiagnosticsLoading ?? false,
        error: options.hostAudioDiagnosticsError ?? null,
        availability: hostAudioAvailability,
        microphonePermission: options.hostAudioDiagnostics?.capture.microphonePermission ?? "unknown",
      }),
      kind: "audio" as const,
      badgeLabel: hostAudioAvailability.label,
      badgeTone: mapAudioBadgeTone(hostAudioAvailability.state),
    },
  ];
}

function selectProviderDetailEntries(entries: ProviderSettingsSurfaceEntry[]) {
  const settingsEntries = entries.filter((entry) => entry.entry.surface.surface === "settings_card");
  if (settingsEntries.length > 0) {
    return settingsEntries;
  }
  return entries;
}

export function ProjectAiOverridesSettings({
  selectedItemId,
  speechDependencyStatus,
  speechPreferenceSource,
  providerSettingsSurfaceEntries,
  hostAudioDiagnostics,
  hostAudioSessionState,
  hostAudioDiagnosticsLoading = false,
  hostAudioDiagnosticsError = null,
  microphonePermissionRequesting = false,
  microphonePermissionError = null,
  onRequestMicrophonePermission = null,
}: ProjectAiOverridesSettingsProps) {
  const providerGroups = useMemo(() => {
    const groups = buildProviderSettingsGroups({
      providerSettingsSurfaceEntries,
      speechDependencyStatus,
      speechPreferenceSource,
    });
    return new Map(groups.map((group) => [group.familyId, group]));
  }, [speechPreferenceSource, providerSettingsSurfaceEntries, speechDependencyStatus]);

  const selectedProviderFamilyId =
    typeof selectedItemId === "string" && selectedItemId.startsWith("provider:")
      ? selectedItemId.slice("provider:".length)
      : null;
  const activeProviderGroup = selectedProviderFamilyId
    ? providerGroups.get(selectedProviderFamilyId) ?? null
    : null;
  const activeProviderDetailEntries = useMemo(
    () => (activeProviderGroup ? selectProviderDetailEntries(activeProviderGroup.entries) : []),
    [activeProviderGroup],
  );

  if (selectedItemId === "audio") {
    return (
      <SettingsSurface data-testid="project-ai-overrides-audio-detail">
        <AudioHostSettingsCard
          diagnostics={hostAudioDiagnostics}
          sessionState={hostAudioSessionState}
          loading={hostAudioDiagnosticsLoading}
          error={hostAudioDiagnosticsError}
          microphonePermissionRequesting={microphonePermissionRequesting}
          microphonePermissionError={microphonePermissionError}
          onRequestMicrophonePermission={onRequestMicrophonePermission}
          presentation="embedded"
        />
      </SettingsSurface>
    );
  }

  if (activeProviderGroup) {
    return (
      <SettingsSurface data-testid={`project-ai-overrides-provider-detail-${activeProviderGroup.familyId}`}>
        <div className="space-y-4">
          {activeProviderDetailEntries.map((entry) => (
            <ProviderShellSurface
              key={entry.key}
              entry={entry.entry}
              hostActionBindings={entry.hostActionBindings}
              hostControlBindings={entry.hostControlBindings}
              hostSectionBindings={entry.hostSectionBindings}
              presentation="embedded"
            />
          ))}
        </div>
      </SettingsSurface>
    );
  }

  return (
    <SettingsSurface data-testid="project-ai-overrides-empty">
      <Text variant="caption" tone="muted">
        Select a voice or audio section from the category list.
      </Text>
    </SettingsSurface>
  );
}
