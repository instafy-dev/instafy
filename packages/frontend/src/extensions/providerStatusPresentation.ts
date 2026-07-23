export type ExtensionStatusTone = "ready" | "attention" | "error" | "idle" | "loading";

export type ExtensionDisplayState =
  | "request_pending"
  | "request_in_progress"
  | "attached"
  | "attached_remote_permission"
  | "attached_remote_issue"
  | "attached_remote_offline"
  | "attached_remote_ready"
  | "attached_remote"
  | "needs_setup"
  | "not_attached"
  | "saved"
  | "unavailable"
  | "updating";

const PROVIDER_STATUS_PRESENTATION: Record<
  ExtensionDisplayState,
  {
    label: string;
    tone: ExtensionStatusTone;
  }
> = {
  request_pending: {
    label: "Waiting",
    tone: "loading",
  },
  request_in_progress: {
    label: "Capturing",
    tone: "loading",
  },
  attached: {
    label: "Attached",
    tone: "ready",
  },
  attached_remote_permission: {
    label: "Needs permission",
    tone: "attention",
  },
  attached_remote_issue: {
    label: "Needs attention",
    tone: "attention",
  },
  attached_remote_offline: {
    label: "Offline",
    tone: "attention",
  },
  attached_remote_ready: {
    label: "Ready",
    tone: "ready",
  },
  attached_remote: {
    label: "Other device",
    tone: "attention",
  },
  needs_setup: {
    label: "Needs setup",
    tone: "attention",
  },
  not_attached: {
    label: "Not attached",
    tone: "idle",
  },
  saved: {
    label: "Saved",
    tone: "idle",
  },
  unavailable: {
    label: "Unavailable",
    tone: "error",
  },
  updating: {
    label: "Updating",
    tone: "loading",
  },
};

export function resolveExtensionStatusPresentation(state: ExtensionDisplayState) {
  return PROVIDER_STATUS_PRESENTATION[state];
}
