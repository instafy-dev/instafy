import type {
  ControllerRuntimeStatusEntry,
  ControllerTunnelGrant,
  LocalWorkspacePresence
} from "../sdk/instafy";
import { describeTimeUntil } from "../utils/time";
import { runtimeEntryIsBooting } from "./utils/runtimeEntry";

export type RuntimeStatusBadgeTone = "neutral" | "warning" | "danger";
export type RuntimeStatusState = "online" | "idle" | "offline" | "booting";

export interface RuntimeStatusBadge {
  text: string;
  tone: RuntimeStatusBadgeTone;
}

export type RuntimeLabelInfo = {
  label: string;
  detail: string | null;
  isMyDevice: boolean;
  statusBadge: RuntimeStatusBadge | null;
  statusState: RuntimeStatusState;
  providerLabel: string | null;
  providerRaw: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

function formatProviderName(raw: string | null | undefined): string | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "instafy-cloud" || normalized === "instafy_cloud") {
    return "Instafy Cloud";
  }
  if (normalized === "self-hosted" || normalized === "self_hosted") {
    return "Team runtime";
  }
  return raw.trim();
}

export interface TunnelEntitlementDetails {
  status: string | null;
  reason: string | null;
  shortfall: number | null;
}

export function extractTunnelEntitlementDetails(
  grant: ControllerTunnelGrant | null | undefined
): TunnelEntitlementDetails | null {
  if (!grant?.metadata) {
    return null;
  }
  const record = readRecord(grant.metadata);
  if (!record) {
    return null;
  }
  const entitlement = readRecord(record["entitlement"]);
  if (!entitlement) {
    return null;
  }
  return {
    status: readString(entitlement["status"]),
    reason: readString(entitlement["reason"]),
    shortfall: readNumber(entitlement["shortfall"])
  };
}

export function formatTunnelEntitlementDetail(
  details: TunnelEntitlementDetails | null
): string | null {
  if (!details) {
    return null;
  }
  const normalizedStatus = details.status?.toLowerCase();
  if (!normalizedStatus || normalizedStatus === "allowed") {
    return null;
  }
  const parts: string[] = [];
  if (normalizedStatus === "denied" || normalizedStatus === "blocked") {
    parts.push("Tunnel blocked");
  } else if (normalizedStatus === "pending") {
    parts.push("Tunnel pending approval");
  }
  if (details.reason) {
    parts.push(details.reason);
  }
  if (details.shortfall && details.shortfall > 0) {
    parts.push(`Requires ${details.shortfall} credit${details.shortfall === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" — ");
}

export function resolveTunnelStatusBadge(
  grant: ControllerTunnelGrant | null | undefined
): RuntimeStatusBadge | null {
  if (!grant) {
    return null;
  }
  const normalized = (grant.status ?? "").toLowerCase();
  if (normalized === "refreshing") {
    return { text: "Tunnel refreshing", tone: "warning" };
  }
  if (normalized === "revoked") {
    return { text: "Tunnel revoked", tone: "warning" };
  }
  if (normalized === "failed") {
    return { text: "Tunnel failed", tone: "danger" };
  }
  if (normalized === "expired") {
    return { text: "Tunnel expired", tone: "warning" };
  }

  const entitlement = extractTunnelEntitlementDetails(grant);
  const entitlementStatus = entitlement?.status?.toLowerCase();
  if (entitlementStatus === "denied" || entitlementStatus === "blocked") {
    return { text: "Tunnel blocked", tone: "danger" };
  }
  if (entitlementStatus === "pending") {
    return { text: "Tunnel pending", tone: "warning" };
  }

  return null;
}

export function getRuntimeLabel(
  entry: ControllerRuntimeStatusEntry,
  localWorkspace: LocalWorkspacePresence | null,
  tunnel?: ControllerTunnelGrant | null
): RuntimeLabelInfo {
  const baseTypeName = "Instafy Runtime";
  const runtimeDisplayNameCandidate =
    typeof entry.displayName === "string" && entry.displayName.trim().length > 0
      ? entry.displayName.trim()
      : null;
  const isMyDevice = Boolean(
    entry.isLocal && localWorkspace?.runtimeId && localWorkspace.runtimeId === entry.runtimeId
  );
  const providerLabel = formatProviderName(entry.provider);
  const providerRaw = entry.provider ?? null;
  const runtimeDisplayName = normalizeRuntimeDisplayName(
    runtimeDisplayNameCandidate,
    providerLabel
  );

  const originStatusRaw = entry.origin?.status ?? null;
  const originStatus = originStatusRaw ? originStatusRaw.toLowerCase() : null;
  const originEndpoint = entry.origin?.endpoint ?? entry.endpointUrl ?? null;
  const hostname = extractHostname(originEndpoint ?? entry.endpointUrl);
  const detailParts: string[] = [];
  let statusBadge: RuntimeStatusBadge | null = null;
  const normalizedHealth = (entry.health ?? "").toLowerCase();
  const normalizedStatus = (entry.status ?? "").toLowerCase();

  const isBooting = runtimeEntryIsBooting(entry);
  const isOffline = originStatus === "offline" || normalizedHealth === "offline";
  const shouldDisplayOfflineState = !isBooting && isOffline;
  const isIdle = originStatus === "idle" || normalizedHealth === "idle";
  const isOnline =
    originStatus === "online" ||
    normalizedHealth === "online" ||
    ["ready", "running", "online"].includes(normalizedStatus);
  const isDegraded = originStatus === "degraded";

  let statusState: RuntimeStatusState = "offline";
  if (isBooting) {
    statusState = "booting";
  } else if (isOffline) {
    statusState = "offline";
  } else if (isIdle) {
    statusState = "idle";
  } else if (isOnline || isDegraded) {
    statusState = "online";
  }

  let label: string;

  if (isMyDevice) {
    label = runtimeDisplayName ?? "My Device";
    if (localWorkspace?.hostname && localWorkspace.hostname !== label) {
      detailParts.push(localWorkspace.hostname);
    }
    if (localWorkspace?.region) {
      detailParts.push(localWorkspace.region);
    }
    if (localWorkspace?.status === "offline" && !detailParts.includes("Offline")) {
      detailParts.push("Offline");
    } else if (localWorkspace?.status === "expired") {
      if (!detailParts.includes("Expired")) {
        detailParts.push("Expired");
      }
      statusBadge = { text: "Expired", tone: "warning" };
    } else if (localWorkspace?.presenceStatus === "degraded") {
      statusBadge = { text: "Degraded", tone: "warning" };
    }
  } else if (runtimeDisplayName) {
    label = runtimeDisplayName;
  } else if (entry.isLocal) {
    label = hostname ? `Team runtime (${hostname})` : providerLabel ?? "Team runtime";
    if (hostname) {
      detailParts.push(hostname);
    }
  } else {
    label = providerLabel ? `${providerLabel} runtime` : baseTypeName;
    if (originEndpoint) {
      detailParts.push(originEndpoint);
    } else if (entry.endpointUrl) {
      detailParts.push(entry.endpointUrl);
    }
  }

  if (providerLabel && !isMyDevice) {
    const labelLower = label.toLowerCase();
    const providerLower = providerLabel.toLowerCase();
    if (!labelLower.includes(providerLower)) {
      detailParts.unshift(providerLabel);
    }
  }

  if (isDegraded) {
    statusBadge = { text: "Degraded", tone: "warning" };
  } else if (shouldDisplayOfflineState && !detailParts.includes("Offline")) {
    detailParts.push("Offline");
  }

  if (tunnel) {
    const tunnelHost = tunnel.hostname ?? extractHostname(tunnel.url);
    const normalizedTunnelStatus = (tunnel.status ?? "").toLowerCase();
    if (tunnelHost) {
      const tunnelLabel =
        normalizedTunnelStatus && normalizedTunnelStatus !== "active"
          ? `Tunnel ${tunnelHost} (${normalizedTunnelStatus})`
          : `Tunnel ${tunnelHost}`;
      detailParts.push(tunnelLabel);
    } else if (tunnel.url) {
      detailParts.push(`Tunnel ${tunnel.url}`);
    }
    const tunnelBadge = resolveTunnelStatusBadge(tunnel);
    if (tunnelBadge) {
      statusBadge = tunnelBadge;
      const badgeText = tunnelBadge.text.toLowerCase();
      if (tunnelBadge.tone === "danger" || badgeText.includes("blocked")) {
        statusState = "offline";
      } else if (
        badgeText.includes("refreshing") ||
        badgeText.includes("revoked") ||
        badgeText.includes("expired") ||
        badgeText.includes("pending")
      ) {
        if (statusState === "online") {
          statusState = "idle";
        }
      }
    }
    const entitlementDetail = formatTunnelEntitlementDetail(
      extractTunnelEntitlementDetails(tunnel)
    );
    if (entitlementDetail) {
      detailParts.push(entitlementDetail);
    }
  }

  if (statusBadge && statusBadge.text === "Offline") {
    statusBadge = null;
    statusState = "offline";
  }
  if (statusState === "online" && statusBadge?.tone === "danger") {
    statusState = "offline";
  }

  const tokenDescription = describeTimeUntil(entry.agentTokenExpiresAt ?? null);
  if (tokenDescription) {
    const tokenDetail = tokenDescription.isPast
      ? `Token expired ${tokenDescription.text} ago`
      : `Token expires in ${tokenDescription.text}`;
    detailParts.push(tokenDetail);
    if (tokenDescription.isPast) {
      statusBadge = { text: "Token expired", tone: "danger" };
      statusState = "offline";
    } else if (
      tokenDescription.milliseconds <= 10 * 60 * 1000 &&
      (!statusBadge || statusBadge.tone === "neutral")
    ) {
      statusBadge = { text: "Token expiring", tone: "warning" };
    }
  }

  return {
    label,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
    isMyDevice,
    statusBadge,
    statusState,
    providerLabel: providerLabel ?? providerRaw,
    providerRaw,
  };
}

function extractHostname(endpointUrl: string | null | undefined): string | null {
  if (!endpointUrl) {
    return null;
  }
  try {
    const url = new URL(endpointUrl);
    return url.hostname;
  } catch (_error) {
    return null;
  }
}

export function runtimeAutoOptionLabel(): string {
  return "Auto (best available)";
}

function normalizeRuntimeDisplayName(
  displayName: string | null,
  providerLabel: string | null
): string | null {
  if (!displayName) {
    return null;
  }
  const normalized = displayName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const providerNormalized = providerLabel ? providerLabel.trim().toLowerCase() : "";
  if (
    normalized === "hosted runtime" ||
    normalized === "instafy cloud" ||
    normalized === "instafy cloud runtime" ||
    (providerNormalized && normalized === providerNormalized) ||
    (providerNormalized && normalized === `${providerNormalized} runtime`)
  ) {
    return null;
  }
  return displayName.trim();
}
