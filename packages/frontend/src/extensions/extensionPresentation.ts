import {
  resolveExtensionStatusPresentation,
  type ExtensionDisplayState,
} from "./providerStatusPresentation";

export { resolveExtensionStatusPresentation };
export type { ExtensionDisplayState, ExtensionStatusTone } from "./providerStatusPresentation";

export type ExtensionPresentationSource = "host" | "native_runtime" | "project_integration";

type ResolveExtensionDisplayStateInput = {
  attached: boolean;
  discoverable: boolean;
  hasDiscoveryError: boolean;
  isPending: boolean;
  activeRequestState?: "pending" | "in_progress" | null;
  needsSetup: boolean;
  attachedRemote: boolean;
  remoteStatus?: "ready" | "permission" | "issue" | "offline" | null;
  source: ExtensionPresentationSource;
};

type ResolveExtensionFallbackSummaryInput = {
  scopeLabel?: string | null;
  source: ExtensionPresentationSource;
  state: ExtensionDisplayState;
};

type ResolveExtensionAttachActionLabelInput = {
  isPending: boolean;
  useDeviceLanguage: boolean;
};

type ResolveExtensionDetachActionLabelInput = {
  isPending: boolean;
  useDeviceLanguage: boolean;
};

type ResolveExtensionDetailsActionLabelInput = {
  attached: boolean;
  expanded: boolean;
  hasManageSurface: boolean;
  needsSetup?: boolean;
};

function normalizeScopeLabel(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "this space";
}

export function resolveExtensionDisplayState({
  attached,
  discoverable,
  hasDiscoveryError,
  isPending,
  activeRequestState,
  needsSetup,
  attachedRemote,
  remoteStatus,
  source,
}: ResolveExtensionDisplayStateInput): ExtensionDisplayState {
  if (isPending) {
    return "updating";
  }

  if (activeRequestState === "in_progress" && (attached || attachedRemote)) {
    return "request_in_progress";
  }

  if (activeRequestState === "pending" && (attached || attachedRemote)) {
    return "request_pending";
  }

  if (!discoverable && hasDiscoveryError) {
    return "unavailable";
  }

  if (attachedRemote) {
    if (remoteStatus === "offline") {
      return "attached_remote_offline";
    }
    if (remoteStatus === "permission") {
      return "attached_remote_permission";
    }
    if (remoteStatus === "issue") {
      return "attached_remote_issue";
    }
    if (remoteStatus === "ready") {
      return "attached_remote_ready";
    }
    return "attached_remote";
  }

  if (!attached && source === "project_integration") {
    return "saved";
  }

  if (needsSetup) {
    return "needs_setup";
  }

  if (attached) {
    return "attached";
  }

  return "not_attached";
}

export function resolveExtensionFallbackSummary({
  scopeLabel,
  source,
  state,
}: ResolveExtensionFallbackSummaryInput) {
  const scope = normalizeScopeLabel(scopeLabel);

  switch (state) {
    case "request_pending":
      return "Waiting for the selected device.";
    case "request_in_progress":
      return "Capturing now.";
    case "attached":
      return `Attached for ${scope}.`;
    case "attached_remote_permission":
      return "Grant camera permission on the selected device.";
    case "attached_remote_issue":
      return "The selected device needs attention before it can capture again.";
    case "attached_remote_offline":
      return "Open Instafy on the selected device to use this extension.";
    case "attached_remote_ready":
      return "Ready while Instafy stays open there.";
    case "attached_remote":
      return "Runs on another device while Instafy stays open there.";
    case "needs_setup":
      return "Finish setup before use.";
    case "saved":
      return "Saved.";
    case "unavailable":
      return "Unavailable on this device.";
    case "updating":
      return `Updating access for ${scope}.`;
    case "not_attached":
    default:
      return source === "host" ? "Available locally." : `Not attached to ${scope}.`;
  }
}

export function resolveExtensionAttachActionLabel({
  isPending,
  useDeviceLanguage,
}: ResolveExtensionAttachActionLabelInput) {
  if (useDeviceLanguage) {
    return isPending ? "Using This Device…" : "Use This Device";
  }
  return isPending ? "Attaching…" : "Attach";
}

export function resolveExtensionDetachActionLabel({
  isPending,
  useDeviceLanguage,
}: ResolveExtensionDetachActionLabelInput) {
  if (useDeviceLanguage) {
    return isPending ? "Stopping…" : "Stop Using This Device";
  }
  return isPending ? "Detaching…" : "Detach";
}

export function resolveExtensionDetailsActionLabel({
  attached,
  expanded,
  hasManageSurface,
  needsSetup,
}: ResolveExtensionDetailsActionLabelInput) {
  if (expanded) {
    return "Close";
  }

  if (hasManageSurface) {
    return attached && !needsSetup ? "Manage" : "Setup";
  }

  return "Details";
}
