import { isUUID } from "../utils/uuid";
import type { PendingProjectSwitchSnapshot } from "./pendingProjectSwitch";

const PENDING_PROJECT_SWITCH_GRACE_MS = 5_000;

function normalizeProjectId(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && isUUID(trimmed) ? trimmed : null;
}

export function resolveStudioUrlProjectId(params: {
  activeProjectId?: string | null;
  urlProjectId?: string | null;
  pendingProjectSwitch?: PendingProjectSwitchSnapshot | null;
  now?: number;
}): string | null {
  const activeProjectId = normalizeProjectId(params.activeProjectId);
  const urlProjectId = normalizeProjectId(params.urlProjectId);
  const now = typeof params.now === "number" ? params.now : Date.now();
  const pendingProjectId = normalizeProjectId(params.pendingProjectSwitch?.projectId);
  const pendingAt =
    typeof params.pendingProjectSwitch?.at === "number" ? params.pendingProjectSwitch.at : null;
  const pendingProjectSwitch =
    pendingProjectId && pendingAt !== null && now - pendingAt < PENDING_PROJECT_SWITCH_GRACE_MS
      ? pendingProjectId
      : null;

  if (urlProjectId && activeProjectId && urlProjectId !== activeProjectId) {
    if (pendingProjectSwitch === activeProjectId) {
      return activeProjectId;
    }
    return urlProjectId;
  }

  return activeProjectId ?? urlProjectId ?? null;
}
