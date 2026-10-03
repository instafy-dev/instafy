import type { ControllerProjectSummary } from "../services/runtimeController/projects";

export type EffectiveProjectRole = "viewer" | "builder" | "admin" | "owner";

export type ChatAttachmentsMode = "storage" | "none";

export interface ProjectCapabilities {
  effectiveRole: EffectiveProjectRole | null;
  canWrite: boolean;
  canShare: boolean;
  canManage: boolean;
  /** Null until a single-space summary has said; only `none` turns uploads off. */
  chatAttachments: ChatAttachmentsMode | null;
}

/**
 * What the composer is told about chat attachments in a space. Attachments go
 * to Supabase Storage with the person's own session, so an app without a
 * Supabase configuration has nowhere to put them whatever the server says.
 */
export function resolveChatAttachmentsMode(
  hasSupabaseConfig: boolean,
  capabilities: Pick<ProjectCapabilities, "chatAttachments"> | null | undefined,
): ChatAttachmentsMode | null {
  return hasSupabaseConfig ? capabilities?.chatAttachments ?? null : "none";
}

function normalizeChatAttachmentsMode(value: unknown): ChatAttachmentsMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "storage" || normalized === "none" ? normalized : null;
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
    chatAttachments: normalizeChatAttachmentsMode(summary.attachments),
  };
}

export function ownerProjectCapabilities(): ProjectCapabilities {
  return {
    effectiveRole: "owner",
    canWrite: true,
    canShare: true,
    canManage: true,
    chatAttachments: null,
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
