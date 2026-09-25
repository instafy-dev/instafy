import type { RunRecord } from "../../../types";
import type { SharedBrowserCollaborationClientState } from "./sharedBrowserCollaboration";

export type SharedBrowserControlOwner =
  | { kind: "human" }
  | { kind: "agent"; displayName: string };

type SharedBrowserControlRun = Pick<RunRecord, "metadata" | "status">;

export const HUMAN_SHARED_BROWSER_CONTROL_OWNER: SharedBrowserControlOwner = {
  kind: "human",
};

/** Presentation only: never use this to decide input authority. */
export function remoteSharedBrowserController(
  client: SharedBrowserCollaborationClientState,
  agentOwner: Extract<SharedBrowserControlOwner, { kind: "agent" }> | null,
): { kind: "human" | "agent"; displayName: string } | null {
  if (agentOwner) return agentOwner;
  const owner = client.state?.controlOwner;
  if (client.connectionStatus !== "connected" || !client.participantId ||
      owner?.kind !== "human" || owner.participantId === client.participantId) return null;
  return { kind: "human", displayName: client.state?.participants.find(
    participant => participant.id === owner.participantId,
  )?.displayName || "Another participant" };
}

function normalizedMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function agentDisplayName(metadata: Record<string, unknown>): string {
  const agent = metadata.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return "Assistant";
  }
  const record = agent as Record<string, unknown>;
  for (const key of ["displayName", "display_name", "handle"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "Assistant";
}

export function resolveSharedBrowserControlOwner(params: {
  activeRuns: readonly SharedBrowserControlRun[];
  browserPageId: string | null;
  browserRuntimeId: string | null;
}): SharedBrowserControlOwner {
  const browserRuntimeId = params.browserRuntimeId?.trim().toLowerCase() ?? "";
  const browserPageId = params.browserPageId?.trim() ?? "";
  if (!browserRuntimeId || !browserPageId) {
    return HUMAN_SHARED_BROWSER_CONTROL_OWNER;
  }

  const runMatchesTarget = (run: SharedBrowserControlRun) => {
    const metadata = run.metadata;
    if (!metadata) {
      return false;
    }
    return (
      normalizedMetadataString(metadata, "browserTransport") === "shared" &&
      normalizedMetadataString(metadata, "browserRuntimeId").toLowerCase() ===
        browserRuntimeId &&
      normalizedMetadataString(metadata, "browserPageId") === browserPageId
    );
  };
  const activeRun =
    params.activeRuns.find(
      (run) => run.status === "in_progress" && runMatchesTarget(run),
    ) ??
    params.activeRuns.find(
      (run) => run.status === "queued" && runMatchesTarget(run),
    );
  if (!activeRun?.metadata) {
    return HUMAN_SHARED_BROWSER_CONTROL_OWNER;
  }

  return {
    kind: "agent",
    displayName: agentDisplayName(activeRun.metadata),
  };
}

export function sharedBrowserHumanInputEnabled(params: {
  controlOwner: SharedBrowserControlOwner;
  transportActive: boolean;
}): boolean {
  return params.transportActive && params.controlOwner.kind === "human";
}

export function applySharedBrowserRfbHumanInput(
  rfb: { viewOnly?: boolean } | null,
  enabled: boolean,
): void {
  if (rfb) {
    rfb.viewOnly = !enabled;
  }
}
