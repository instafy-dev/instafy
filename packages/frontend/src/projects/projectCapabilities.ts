import type { ControllerProjectSummary } from "../services/runtimeController/projects";

export type EffectiveProjectRole = "viewer" | "builder" | "admin" | "owner";

export interface ProjectCapabilities {
  effectiveRole: EffectiveProjectRole | null;
  canWrite: boolean;
  canShare: boolean;
  canManage: boolean;
}

function normalizeEffectiveRole(value: string | null | undefined): EffectiveProjectRole | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "viewer" ||
    normalized === "builder" ||
    normalized === "admin" ||
    normalized === "owner"
    ? normalized
    : null;
}

export function resolveProjectCapabilities(
  summary: ControllerProjectSummary | null | undefined,
  userId: string | null | undefined,
): ProjectCapabilities | null {
  if (!summary) {
    return null;
  }

  const explicitRole = normalizeEffectiveRole(summary.effectiveRole);
  const ownerFallback = userId && summary.ownerUserId === userId ? "owner" : null;
  const effectiveRole = explicitRole ?? ownerFallback;
  const hasExplicitCapability =
    typeof summary.canWrite === "boolean" ||
    typeof summary.canShare === "boolean" ||
    typeof summary.canManage === "boolean";

  // An older controller does not expose enough information to distinguish an
  // org viewer from a builder. Keep the capability unresolved instead of
  // accidentally showing write controls to a read-only member.
  if (!effectiveRole && !hasExplicitCapability) {
    return null;
  }

  return {
    effectiveRole,
    canWrite:
      summary.canWrite ??
      (effectiveRole === "builder" || effectiveRole === "admin" || effectiveRole === "owner"),
    canShare:
      summary.canShare ?? (effectiveRole === "admin" || effectiveRole === "owner"),
    canManage:
      summary.canManage ?? (effectiveRole === "admin" || effectiveRole === "owner"),
  };
}

export function ownerProjectCapabilities(): ProjectCapabilities {
  return {
    effectiveRole: "owner",
    canWrite: true,
    canShare: true,
    canManage: true,
  };
}

export function canOpenProjectDeviceHandoff(
  projectId: string | null | undefined,
  capabilitiesResolved: boolean,
): boolean {
  // This is a same-account navigation affordance, not an access grant. Once
  // membership has been resolved, viewers and builders without share rights
  // must be able to continue the space on another device too.
  return Boolean(projectId) && capabilitiesResolved;
}
