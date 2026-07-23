import type { DesktopVoiceHostBridgeStatus } from "./voiceHost/client";
import type { DesktopSpeechTunnelBridgeStatus } from "./voiceTunnel/client";

export type DesktopVoiceStatusSummary = {
  label: string;
  tone: "success" | "warning" | "neutral";
  detail: string;
};

function normalizeOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function describeDesktopVoiceStatusSummary(input: {
  activeProjectId?: string | null;
  hostStatus?: DesktopVoiceHostBridgeStatus | null;
  tunnelStatus?: DesktopSpeechTunnelBridgeStatus | null;
  loading?: boolean;
}): DesktopVoiceStatusSummary | null {
  const activeProjectId = normalizeOptionalString(input.activeProjectId);
  if (!activeProjectId) {
    return null;
  }
  if (input.loading) {
    return {
      label: "Checking voice",
      tone: "neutral",
      detail: "Instafy Desktop is checking the local voice host and speech tunnel for this space.",
    };
  }

  if (input.hostStatus && input.hostStatus.enabled === false) {
    return null;
  }

  const hostReachable =
    input.hostStatus?.enabled === true &&
    input.hostStatus.speechService?.reachable === true &&
    input.hostStatus.providerHost?.reachable === true;
  const bootstrapState = input.hostStatus?.bootstrap?.state ?? "idle";
  const hostFailed =
    input.hostStatus?.speechService?.state === "error" ||
    input.hostStatus?.providerHost?.state === "error";
  const tunnelProjectId = normalizeOptionalString(input.tunnelStatus?.projectId);
  const tunnelActiveForProject =
    input.tunnelStatus?.state === "active" &&
    tunnelProjectId === activeProjectId &&
    normalizeOptionalString(input.tunnelStatus?.publicUrl);

  if (hostReachable && tunnelActiveForProject) {
    return {
      label: "Desktop voice ready",
      tone: "success",
      detail: "Instafy Desktop is running the local voice host and this space already has an active Desktop speech tunnel.",
    };
  }

  if (hostReachable && input.tunnelStatus?.state === "starting") {
    return {
      label: "Desktop voice syncing",
      tone: "neutral",
      detail: "Instafy Desktop is bringing the speech tunnel online for this space.",
    };
  }

  if (bootstrapState === "checking" || bootstrapState === "installing") {
    return {
      label: "Desktop voice installing",
      tone: "neutral",
      detail:
        normalizeOptionalString(input.hostStatus?.bootstrap?.detail) ??
        "Instafy Desktop is preparing the managed speech runtime for this machine.",
    };
  }

  if (hostReachable && tunnelProjectId && tunnelProjectId !== activeProjectId) {
    return {
      label: "Desktop voice switching",
      tone: "neutral",
      detail: "Instafy Desktop already has a speech tunnel open for another space and will move it here when needed.",
    };
  }

  if (hostFailed || input.hostStatus?.enabled === true) {
    return {
      label: "Desktop voice needs repair",
      tone: "warning",
      detail:
        normalizeOptionalString(input.hostStatus?.bootstrap?.state === "error" ? input.hostStatus?.bootstrap?.detail : null) ??
        normalizeOptionalString(input.hostStatus?.providerHost?.lastError) ??
        normalizeOptionalString(input.hostStatus?.speechService?.lastError) ??
        "Instafy Desktop has not finished bringing the local voice host online for this machine.",
    };
  }

  return null;
}
