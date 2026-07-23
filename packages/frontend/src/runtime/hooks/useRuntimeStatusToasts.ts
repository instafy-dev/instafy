import { useEffect, useMemo, useRef } from "react";
import { logAppInfo, logAppWarn } from "../../debug/appLogs";
import type {
  ControllerOriginPresence,
  ControllerRuntimeStatusEntry,
  ControllerTunnelGrant,
  LocalWorkspacePresence,
  LocalWorkspaceStatus,
} from "../../sdk/instafy";
import type { ShowStatusFn } from "./types";
import {
  extractTunnelEntitlementDetails,
  formatTunnelEntitlementDetail,
} from "../runtimeLabels";

interface Options {
  enabled: boolean;
  workspace: LocalWorkspacePresence | null;
  runtimeEntry: ControllerRuntimeStatusEntry | null;
  selectedLocalRuntimeId?: string | null;
  tunnel: ControllerTunnelGrant | null;
  showStatus: ShowStatusFn;
}

export const LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS = 2500;

export function formatLocalRuntimeOfflineMessage(runtimeName: string): string {
  return `${runtimeName} appears offline. Reconnect it or select another runtime if work stalls.`;
}

function clearTimerRef(ref: { current: ReturnType<typeof setTimeout> | null }) {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

export function shouldTrackLocalWorkspaceStatus(
  workspace: LocalWorkspacePresence | null,
  runtimeEntry: ControllerRuntimeStatusEntry | null,
  selectedLocalRuntimeId?: string | null,
): boolean {
  if (!workspace || !runtimeEntry || !runtimeEntry.isLocal) {
    return false;
  }

  const workspaceRuntimeId =
    typeof workspace.runtimeId === "string" ? workspace.runtimeId.trim() : "";
  if (workspaceRuntimeId && workspaceRuntimeId !== runtimeEntry.runtimeId) {
    return false;
  }

  const selectedRuntimeId =
    typeof selectedLocalRuntimeId === "string"
      ? selectedLocalRuntimeId.trim()
      : "";
  if (selectedRuntimeId.length > 0) {
    return selectedRuntimeId === runtimeEntry.runtimeId;
  }

  return workspaceRuntimeId.length > 0;
}

export function useRuntimeStatusToasts({
  enabled,
  workspace,
  runtimeEntry,
  selectedLocalRuntimeId,
  tunnel,
  showStatus,
}: Options) {
  const lastWorkspaceStatusRef = useRef<LocalWorkspaceStatus | null>(null);
  const lastPresenceStatusRef = useRef<ControllerOriginPresence["status"] | null>(
    null,
  );
  const lastOriginStatusRef = useRef<string | null>(null);
  const lastTunnelStatusRef = useRef<string | null>(null);
  const lastTunnelEntitlementStatusRef = useRef<string | null>(null);
  const workspaceOfflineToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const originOfflineToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const workspaceOfflineToastShownRef = useRef(false);
  const originOfflineToastShownRef = useRef(false);

  const runtimeName = useMemo(() => {
    return (
      (runtimeEntry?.displayName ?? runtimeEntry?.runtimeId)?.toString() ??
      "Desktop runtime"
    );
  }, [runtimeEntry?.displayName, runtimeEntry?.runtimeId]);
  const trackLocalWorkspaceStatus = useMemo(
    () =>
      shouldTrackLocalWorkspaceStatus(
        workspace,
        runtimeEntry,
        selectedLocalRuntimeId,
      ),
    [runtimeEntry, selectedLocalRuntimeId, workspace],
  );

  useEffect(() => {
    return () => {
      clearTimerRef(workspaceOfflineToastTimerRef);
      clearTimerRef(originOfflineToastTimerRef);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearTimerRef(workspaceOfflineToastTimerRef);
      workspaceOfflineToastShownRef.current = false;
      lastWorkspaceStatusRef.current = null;
      lastPresenceStatusRef.current = null;
      lastOriginStatusRef.current = null;
      lastTunnelStatusRef.current = null;
      lastTunnelEntitlementStatusRef.current = null;
      return;
    }

    if (!trackLocalWorkspaceStatus) {
      clearTimerRef(workspaceOfflineToastTimerRef);
      workspaceOfflineToastShownRef.current = false;
      // Keep refs aligned with incoming values so we do not emit stale transition
      // toasts if a local runtime entry appears later in the session.
      lastWorkspaceStatusRef.current = workspace?.status ?? null;
      lastPresenceStatusRef.current = workspace?.presenceStatus ?? null;
      return;
    }

    const currentStatus = workspace?.status ?? null;
    const previousStatus = lastWorkspaceStatusRef.current;
    if (currentStatus !== previousStatus && previousStatus !== null) {
      if (currentStatus === "offline" || currentStatus === "expired") {
        clearTimerRef(workspaceOfflineToastTimerRef);
        workspaceOfflineToastShownRef.current = false;
        lastWorkspaceStatusRef.current = currentStatus;
        workspaceOfflineToastTimerRef.current = setTimeout(
          () => {
            if (lastWorkspaceStatusRef.current === currentStatus) {
              showStatus(
                formatLocalRuntimeOfflineMessage(runtimeName),
                "warning",
                6000,
              );
              workspaceOfflineToastShownRef.current = true;
            }
            workspaceOfflineToastTimerRef.current = null;
          },
          LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS,
        );
        return;
      } else if (
        previousStatus &&
        ["offline", "expired"].includes(previousStatus) &&
        currentStatus === "online"
      ) {
        clearTimerRef(workspaceOfflineToastTimerRef);
        if (workspaceOfflineToastShownRef.current) {
          showStatus(`${runtimeName} is back online.`, "success", 4000);
        }
        workspaceOfflineToastShownRef.current = false;
      } else {
        clearTimerRef(workspaceOfflineToastTimerRef);
        workspaceOfflineToastShownRef.current = false;
      }
    }
    lastWorkspaceStatusRef.current = currentStatus;

    const currentPresence = workspace?.presenceStatus ?? null;
    const previousPresence = lastPresenceStatusRef.current;
    if (currentPresence !== previousPresence && previousPresence !== null) {
      if (
        currentPresence === "degraded" &&
        currentStatus !== "offline" &&
        currentStatus !== "expired"
      ) {
        showStatus(
          `${runtimeName} is degraded. Performance may be limited.`,
          "warning",
          6000,
        );
      }
    }
    lastPresenceStatusRef.current = currentPresence;
  }, [
    enabled,
    runtimeEntry,
    runtimeName,
    selectedLocalRuntimeId,
    showStatus,
    trackLocalWorkspaceStatus,
    workspace,
    workspace?.presenceStatus,
    workspace?.status,
  ]);

  useEffect(() => {
    if (!enabled) {
      clearTimerRef(originOfflineToastTimerRef);
      originOfflineToastShownRef.current = false;
      lastOriginStatusRef.current = null;
      return;
    }

    const originStatusRaw = runtimeEntry?.origin?.status ?? null;
    const originStatus = originStatusRaw
      ? originStatusRaw.toLowerCase()
      : null;
    if (!trackLocalWorkspaceStatus) {
      clearTimerRef(originOfflineToastTimerRef);
      originOfflineToastShownRef.current = false;
      // Keep refs aligned to avoid stale transition toasts when the local
      // runtime becomes the active selection later.
      lastOriginStatusRef.current = originStatus;
      return;
    }

    const previous = lastOriginStatusRef.current;

    if (originStatus !== previous && previous !== null) {
      if (originStatus === "offline") {
        clearTimerRef(originOfflineToastTimerRef);
        originOfflineToastShownRef.current = false;
        lastOriginStatusRef.current = originStatus;
        originOfflineToastTimerRef.current = setTimeout(
          () => {
            if (lastOriginStatusRef.current === originStatus) {
              showStatus(
                formatLocalRuntimeOfflineMessage(runtimeName),
                "warning",
                6000,
              );
              originOfflineToastShownRef.current = true;
            }
            originOfflineToastTimerRef.current = null;
          },
          LOCAL_RUNTIME_OFFLINE_TOAST_DEBOUNCE_MS,
        );
        return;
      } else if (previous === "offline" && originStatus === "online") {
        clearTimerRef(originOfflineToastTimerRef);
        if (originOfflineToastShownRef.current) {
          showStatus(`${runtimeName} is back online.`, "success", 4000);
        }
        originOfflineToastShownRef.current = false;
      } else if (originStatus === "degraded" && previous !== "degraded") {
        clearTimerRef(originOfflineToastTimerRef);
        originOfflineToastShownRef.current = false;
        showStatus(
          `${runtimeName} is degraded. Performance may be limited.`,
          "warning",
          6000,
        );
      } else {
        clearTimerRef(originOfflineToastTimerRef);
        originOfflineToastShownRef.current = false;
      }
    }

    lastOriginStatusRef.current = originStatus;
  }, [
    enabled,
    runtimeEntry?.origin?.status,
    runtimeName,
    showStatus,
    trackLocalWorkspaceStatus,
  ]);

  useEffect(() => {
    if (!enabled) {
      lastTunnelStatusRef.current = null;
      lastTunnelEntitlementStatusRef.current = null;
      return;
    }

    const normalized = tunnel?.status ? tunnel.status.toLowerCase() : null;
    lastTunnelStatusRef.current = normalized;

    const entitlement = extractTunnelEntitlementDetails(tunnel);
    const entitlementStatus = entitlement?.status?.toLowerCase() ?? null;
    const previousEntitlement = lastTunnelEntitlementStatusRef.current;
    const entitlementDetail = formatTunnelEntitlementDetail(entitlement);

    if (entitlementStatus !== previousEntitlement) {
      if (entitlementStatus === "denied" || entitlementStatus === "blocked") {
        logAppWarn(
          entitlementDetail ?? `${runtimeName} tunnel was blocked. Check credits or policy.`,
        );
      } else if (entitlementStatus === "pending") {
        logAppInfo(
          entitlementDetail ?? `${runtimeName} tunnel is pending approval.`,
        );
      } else if (
        (!entitlementStatus || entitlementStatus === "allowed") &&
        previousEntitlement &&
        (previousEntitlement === "denied" ||
          previousEntitlement === "blocked" ||
          previousEntitlement === "pending")
      ) {
        logAppInfo(`${runtimeName} tunnel access restored.`);
      }
    }

    lastTunnelEntitlementStatusRef.current = entitlementStatus;
  }, [enabled, runtimeName, showStatus, tunnel, tunnel?.metadata, tunnel?.status]);
}
