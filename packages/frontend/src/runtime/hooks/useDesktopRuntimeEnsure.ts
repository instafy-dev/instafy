import { useCallback, useMemo, useState, type Dispatch } from "react";
import { controllerClient } from "../../sdk/instafy";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import type { RuntimeAction } from "../runtimeStore";
import type { ShowStatusFn } from "./types";

interface UseDesktopRuntimeEnsureOptions {
  enabled: boolean;
  projectId: string | null;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  dispatch: Dispatch<RuntimeAction>;
  refreshRuntimeStatuses: () => Promise<void>;
  showStatus: ShowStatusFn;
  onShowSelfHostHelp?: () => void;
}

export function useDesktopRuntimeEnsure({
  enabled,
  projectId,
  runtimeStatuses,
  dispatch,
  refreshRuntimeStatuses,
  showStatus,
  onShowSelfHostHelp,
}: UseDesktopRuntimeEnsureOptions) {
  const [desktopRuntimeEnsuring, setDesktopRuntimeEnsuring] = useState(false);
  // The request is about a machine that has already registered itself. Without
  // one there is nothing for the controller to reconnect: a self-hosted request
  // naming no runtime is refused outright ("self-hosted runtimes must first
  // register from their owner device"), so firing it would only produce an
  // error toast blaming the agent for being offline.
  const localRuntimeId = useMemo(
    () => runtimeStatuses.find((entry) => entry.isLocal)?.runtimeId ?? null,
    [runtimeStatuses],
  );

  const ensureDesktopRuntime = useCallback(async () => {
    // The machine is the viewer's own: the controller lists a self-hosted
    // machine (Instafy Desktop's, or one started with the CLI) only to the
    // person who connected it, so these say "your machine", as Desktop's
    // row does.
    if (!enabled || !projectId) {
      showStatus(
        "Can't reconnect your machine right now.",
        "warning",
        4000,
      );
      return false;
    }
    if (desktopRuntimeEnsuring) {
      return true;
    }
    if (!localRuntimeId) {
      // Only the viewer's own are listed, so a teammate's machine in this
      // space may still be connected: this says none of theirs is.
      showStatus(
        "You haven't connected a machine of your own to this space yet.",
        "warning",
        5000,
        onShowSelfHostHelp
          ? { actionLabel: "How to connect one", onAction: onShowSelfHostHelp }
          : undefined,
      );
      return false;
    }
    setDesktopRuntimeEnsuring(true);
    try {
      // Keep the runtime record's TTL at a sane default. In local debug controller builds,
      // omitting this gets coerced down to ~30s and can trigger quick churn (tunnel revoked).
      const result = await controllerClient.runtimes.requestDesktop({
        projectId,
        runtimeId: localRuntimeId,
        idleTtlSeconds: controllerClient.core.runtimeIdleTtlSecondsDefault,
      });
      if (!result) {
        // No result is a missing session or an answer without a machine, not
        // the machine's own state, so this says no more than that.
        showStatus("Couldn't reconnect your machine.", "error", 5000);
        return false;
      }
      if (result.tunnel?.runtimeId) {
        dispatch({ type: "upsertTunnelGrant", grant: result.tunnel });
      }
      await refreshRuntimeStatuses();
      const tunnelStatus = result.tunnel?.status?.toLowerCase() ?? "requested";
      if (tunnelStatus === "active") {
        showStatus("Your machine is online.", "success", 3200);
      } else if (tunnelStatus === "refreshing") {
        showStatus("Refreshing your machine's tunnel…", "info", 3200);
      } else {
        showStatus(
          "Waiting for your machine to reconnect…",
          "info",
          4000,
        );
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Couldn't reconnect your machine: ${message}`, "error", 5000);
      return false;
    } finally {
      setDesktopRuntimeEnsuring(false);
    }
  }, [
    enabled,
    projectId,
    localRuntimeId,
    desktopRuntimeEnsuring,
    dispatch,
    onShowSelfHostHelp,
    refreshRuntimeStatuses,
    showStatus,
  ]);

  return { desktopRuntimeEnsuring, ensureDesktopRuntime } as const;
}
