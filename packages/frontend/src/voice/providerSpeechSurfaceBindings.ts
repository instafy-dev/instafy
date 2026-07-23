import type {
  DesktopSpeechTunnelBridgeStatus,
  DesktopSpeechTunnelLifecycleSummary,
} from "../desktop/voiceTunnel/client";
import type {
  DesktopVoiceHostBootstrapBridgeResult,
  DesktopVoiceHostBridgeStatus,
  DesktopVoiceHostLifecycleSummary,
} from "../desktop/voiceHost/client";
import type { SurfaceHostActionBinding } from "../screens/studio/components/ProviderHostSurfaceActions";
import type { SurfaceHostBinding } from "../screens/studio/components/ProviderHostSurfaceControls";
import type { SurfaceHostSectionBinding } from "../screens/studio/components/ProviderHostSurfaceCard";
import type { ProjectSpeechMode } from "./speechPreference";
import type { ProjectSpeechPreferences } from "./projectSpeechPreferences";
import {
  describeSpeechServiceConnection,
  type SpeechDependencyStatus,
  type SpeechServiceConnectionSummary,
  type SpeechVoiceOption,
} from "./speechService";
import {
  describeSpeechManagedRuntime,
  describeSpeechManagedRuntimeDetail,
  describeSpeechRouteLabel,
  describeSpeechSynthesisBackend,
  describeSpeechTranscriptionBackend,
} from "./speechProviderDiagnostics";

export type SpeechProviderSurfaceBindingsContext = {
  speechDependencyStatus: SpeechDependencyStatus | null;
  desktopVoiceHostStatus: DesktopVoiceHostBridgeStatus | null;
  desktopVoiceHostLifecycle: DesktopVoiceHostLifecycleSummary | null;
  desktopVoiceHostToggleBusy: boolean;
  onToggleDesktopVoiceHost: ((enabled: boolean) => void) | null;
  desktopVoiceHostRestarting: boolean;
  onRestartDesktopVoiceHost: (() => void) | null;
  desktopVoiceHostBootstrapBusy: boolean;
  desktopVoiceHostRemoveBusy: boolean;
  desktopVoiceHostBootstrapResult: DesktopVoiceHostBootstrapBridgeResult | null;
  onBootstrapDesktopVoiceHost: (() => void) | null;
  onRemoveDesktopVoiceRuntime: (() => void) | null;
  desktopSpeechTunnelStatus: DesktopSpeechTunnelBridgeStatus | null;
  desktopSpeechTunnelLifecycle: DesktopSpeechTunnelLifecycleSummary | null;
  desktopSpeechTunnelBusy: boolean;
  onEnsureDesktopSpeechTunnel: (() => void) | null;
  projectSpeechMode: ProjectSpeechMode;
  speechPreferenceSource: ProjectSpeechPreferences["source"];
  onProjectSpeechModeChange: (value: string) => void;
  providerSpeechVoices: SpeechVoiceOption[];
  providerDefaultVoiceId: string | null;
  selectedProviderVoice: SpeechVoiceOption | null;
  onProviderVoiceChange: (value: string) => void;
  projectProviderVoiceId: string | null;
  browserSpeechVoices: SpeechVoiceOption[];
  selectedDeviceVoice: SpeechVoiceOption | null;
  onDeviceVoiceChange: (value: string) => void;
  projectDeviceVoiceId: string | null;
};

export type SpeechProviderShellBindings = {
  summary: SpeechServiceConnectionSummary;
  hostActionBindings: Record<string, SurfaceHostActionBinding>;
  hostControlBindings: Record<string, SurfaceHostBinding>;
  hostSectionBindings: Record<string, SurfaceHostSectionBinding>;
};

function describePreferenceSource(source: ProjectSpeechPreferences["source"]) {
  switch (source) {
    case "project":
      return "Shared with this space";
    case "local":
      return "Saved on this device";
    default:
      return "Using defaults";
  }
}

function describePreferenceSourceDetail(source: ProjectSpeechPreferences["source"]) {
  switch (source) {
    case "project":
      return "This space uses the same saved voice settings across voice surfaces.";
    case "local":
      return "These settings are only active on this device right now.";
    default:
      return "No voice override is saved for this space yet.";
  }
}

function buildSpeechSettingsSummaryFacts(summary: SpeechServiceConnectionSummary) {
  const facts = [
    {
      label: "Current route",
      value: describeSpeechRouteLabel(summary),
    },
  ];
  if (summary.route === "tunnel" && summary.hostLabel?.trim()) {
    facts.push({
      label: "Provider path",
      value: summary.hostLabel.trim(),
    });
  }
  return facts;
}

export function createSpeechProviderShellBindings(
  context: SpeechProviderSurfaceBindingsContext,
): SpeechProviderShellBindings {
  const summary = describeSpeechServiceConnection(context.speechDependencyStatus);
  const desktopVoiceHostConfigured = context.desktopVoiceHostStatus?.enabled === true;
  const toggleDesktopVoiceHost = context.onToggleDesktopVoiceHost;
  const desktopAutoBootstrapBusy =
    context.desktopVoiceHostStatus?.bootstrap?.state === "checking" ||
    context.desktopVoiceHostStatus?.bootstrap?.state === "installing";
  const showDesktopRuntimeRemovalAction =
    desktopVoiceHostConfigured !== true &&
    context.speechDependencyStatus?.dependencies?.managedRuntime?.available === true &&
    context.onRemoveDesktopVoiceRuntime !== null;

  return {
    summary,
    hostControlBindings: {
      speech_route_mode: {
        value: context.projectSpeechMode,
        onChange: (nextValue) => {
          if (typeof nextValue === "string") {
            return context.onProjectSpeechModeChange(nextValue);
          }
        },
      },
      speech_preference_source: {
        value: describePreferenceSource(context.speechPreferenceSource),
        description: describePreferenceSourceDetail(context.speechPreferenceSource),
        disabled: true,
      },
      speech_provider_voice: {
        hidden:
          context.providerSpeechVoices.length === 0 &&
          !context.providerDefaultVoiceId &&
          !context.projectProviderVoiceId &&
          !context.selectedProviderVoice,
        value: context.projectProviderVoiceId ?? "",
        options: context.providerSpeechVoices.map((voice) => ({
          label: voice.label,
          value: voice.id,
        })),
        placeholder: context.providerDefaultVoiceId
          ? `Automatic (${context.providerDefaultVoiceId})`
          : "Automatic provider voice",
        description: context.selectedProviderVoice
          ? `Provider reply voice: ${context.selectedProviderVoice.label}.`
          : context.providerSpeechVoices.length > 0
            ? "Uses the provider default voice unless you pick one here."
            : "No provider voice list is exposed yet.",
        hideOptionBadges: true,
        onChange: (nextValue) => {
          if (typeof nextValue === "string") {
            return context.onProviderVoiceChange(nextValue);
          }
        },
      },
      speech_device_voice: {
        value: context.projectDeviceVoiceId ?? "",
        options: context.browserSpeechVoices.map((voice) => ({
          label: voice.label,
          value: voice.id,
        })),
        placeholder: "Automatic device voice",
        description: context.selectedDeviceVoice
          ? `Device reply voice: ${context.selectedDeviceVoice.label}.`
          : context.browserSpeechVoices.length > 0
            ? "Uses this device's default speech voice unless you pick one here."
            : "This client does not expose browser speech voices right now.",
        hideOptionBadges: true,
        onChange: (nextValue) => {
          if (typeof nextValue === "string") {
            return context.onDeviceVoiceChange(nextValue);
          }
        },
      },
    },
    hostActionBindings: {
      desktop_voice_host_toggle: {
        hidden: toggleDesktopVoiceHost === null,
        label: desktopVoiceHostConfigured ? "Turn off" : "Enable on this Mac",
        busyLabel: desktopVoiceHostConfigured ? "Turning off…" : "Enabling…",
        variant: desktopVoiceHostConfigured ? "ghost" : "primary",
        disabled:
          context.desktopVoiceHostToggleBusy ||
          context.desktopVoiceHostRemoveBusy ||
          context.desktopVoiceHostRestarting ||
          context.desktopVoiceHostBootstrapBusy ||
          desktopAutoBootstrapBusy,
        onPress:
          toggleDesktopVoiceHost === null
            ? undefined
            : () => toggleDesktopVoiceHost(!desktopVoiceHostConfigured),
      },
      desktop_voice_host_repair: {
        hidden: !desktopVoiceHostConfigured || context.onBootstrapDesktopVoiceHost === null,
        busyLabel: "Repairing…",
        disabled:
          context.desktopVoiceHostBootstrapBusy ||
          context.desktopVoiceHostRemoveBusy ||
          desktopAutoBootstrapBusy,
        onPress: context.onBootstrapDesktopVoiceHost ?? undefined,
      },
      desktop_voice_host_restart: {
        hidden: !desktopVoiceHostConfigured || context.onRestartDesktopVoiceHost === null,
        label: context.desktopVoiceHostLifecycle?.actionLabel ?? "Restart Desktop host",
        busyLabel: "Restarting…",
        disabled:
          context.desktopVoiceHostRestarting ||
          context.desktopVoiceHostToggleBusy ||
          context.desktopVoiceHostBootstrapBusy ||
          context.desktopVoiceHostRemoveBusy ||
          desktopAutoBootstrapBusy,
        onPress: context.onRestartDesktopVoiceHost ?? undefined,
      },
      desktop_voice_runtime_remove: {
        hidden: !showDesktopRuntimeRemovalAction,
        busyLabel: "Removing…",
        disabled: context.desktopVoiceHostRemoveBusy || context.desktopVoiceHostToggleBusy,
        onPress: context.onRemoveDesktopVoiceRuntime ?? undefined,
      },
      desktop_speech_tunnel_refresh: {
        hidden: context.onEnsureDesktopSpeechTunnel === null,
        label: context.desktopSpeechTunnelLifecycle?.actionLabel ?? "Refresh Desktop tunnel",
        busyLabel: "Starting…",
        disabled: context.desktopSpeechTunnelBusy,
        onPress: context.onEnsureDesktopSpeechTunnel ?? undefined,
      },
    },
    hostSectionBindings: {
      speech_settings_summary: {
        description: summary.detail,
        facts: buildSpeechSettingsSummaryFacts(summary),
        items: [],
      },
      speech_connection_diagnostics: {
        description: summary.detail,
        facts: [
          {
            label: "Current route",
            value: describeSpeechRouteLabel(summary),
          },
          ...(summary.hostLabel?.trim()
            ? [
                {
                  label: "Provider path",
                  value: summary.hostLabel.trim(),
                },
              ]
            : []),
        ],
        items: [
          summary.reachable
            ? "Device speech stays available if the hosted route drops."
            : "Device speech stays available.",
        ],
      },
      speech_backend_readiness: {
        facts: [
          {
            label: "Transcription",
            value: describeSpeechTranscriptionBackend(context.speechDependencyStatus),
          },
          {
            label: "Reply playback",
            value: describeSpeechSynthesisBackend(context.speechDependencyStatus),
          },
          ...(describeSpeechManagedRuntime(context.speechDependencyStatus)
            ? [
                {
                  label: "Managed runtime",
                  value: describeSpeechManagedRuntime(context.speechDependencyStatus) ?? "",
                },
              ]
            : []),
        ],
        items: [
          ...(describeSpeechManagedRuntimeDetail(context.speechDependencyStatus)
            ? [describeSpeechManagedRuntimeDetail(context.speechDependencyStatus) ?? ""]
            : []),
          ...((context.speechDependencyStatus?.nextSteps ?? [])
            .filter((step) => step.trim().length > 0)
            .slice(0, 2)),
        ],
      },
    },
  };
}
