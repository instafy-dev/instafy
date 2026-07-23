import { useCallback, useState, type Dispatch } from "react";
import { controllerClient } from "../../sdk/instafy";
import type { RuntimeAction } from "../runtimeStore";
import type { ShowStatusFn } from "./types";

interface UseDesktopRuntimeEnsureOptions {
  enabled: boolean;
  projectId: string | null;
  dispatch: Dispatch<RuntimeAction>;
  refreshRuntimeStatuses: () => Promise<void>;
  showStatus: ShowStatusFn;
}

export function useDesktopRuntimeEnsure({
  enabled,
  projectId,
  dispatch,
  refreshRuntimeStatuses,
  showStatus,
}: UseDesktopRuntimeEnsureOptions) {
  const [desktopRuntimeEnsuring, setDesktopRuntimeEnsuring] = useState(false);

  const ensureDesktopRuntime = useCallback(async () => {
    if (!enabled || !projectId) {
      showStatus(
        "Desktop runtime requests are unavailable right now.",
        "warning",
        4000,
      );
      return false;
    }
    if (desktopRuntimeEnsuring) {
      return true;
    }
    setDesktopRuntimeEnsuring(true);
    try {
      // Keep the runtime record's TTL at a sane default. In local debug controller builds,
      // omitting this gets coerced down to ~30s and can trigger quick churn (tunnel revoked).
      const result = await controllerClient.runtimes.requestDesktop({
        projectId,
        idleTtlSeconds: controllerClient.core.runtimeIdleTtlSecondsDefault,
      });
      if (!result) {
        showStatus(
          "Unable to reach your desktop runtime. Make sure the Instafy desktop agent is running.",
          "error",
          5000,
        );
        return false;
      }
      if (result.tunnel?.runtimeId) {
        dispatch({ type: "upsertTunnelGrant", grant: result.tunnel });
      }
      await refreshRuntimeStatuses();
      const tunnelStatus = result.tunnel?.status?.toLowerCase() ?? "requested";
      if (tunnelStatus === "active") {
        showStatus("Desktop runtime is online.", "success", 3200);
      } else if (tunnelStatus === "refreshing") {
        showStatus("Refreshing desktop tunnel credentials…", "info", 3200);
      } else {
        showStatus(
          "Desktop runtime requested. Waiting for your agent to connect…",
          "info",
          4000,
        );
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Failed to connect desktop runtime: ${message}`, "error", 5000);
      return false;
    } finally {
      setDesktopRuntimeEnsuring(false);
    }
  }, [
    enabled,
    projectId,
    desktopRuntimeEnsuring,
    dispatch,
    refreshRuntimeStatuses,
    showStatus,
  ]);

  return { desktopRuntimeEnsuring, ensureDesktopRuntime } as const;
}
