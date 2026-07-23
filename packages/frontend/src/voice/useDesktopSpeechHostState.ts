import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { StatusContextValue } from "../status/StatusProvider";
import { controllerBaseUrl, resolveControllerAccessToken } from "../services/runtimeController/core";
import {
  readProjectSpeechRoute,
  writeProjectSpeechRoute,
} from "./projectSpeechRoute";
import type { SpeechDependencyStatus } from "./speechService";
import {
  bootstrapDesktopVoiceHost,
  describeDesktopVoiceHostLifecycle,
  desktopVoiceHostBridgeAvailable,
  readDesktopVoiceHostStatus,
  restartDesktopVoiceHost,
  setDesktopVoiceHostEnabled,
  type DesktopVoiceHostBootstrapBridgeResult,
  type DesktopVoiceHostBridgeStatus,
  type DesktopVoiceHostLifecycleSummary,
} from "../desktop/voiceHost/client";
import {
  describeDesktopSpeechTunnelLifecycle,
  desktopSpeechTunnelBridgeAvailable,
  readDesktopSpeechTunnelStatus,
  startDesktopSpeechTunnel,
  stopDesktopSpeechTunnel,
  type DesktopSpeechTunnelBridgeStatus,
  type DesktopSpeechTunnelLifecycleSummary,
} from "../desktop/voiceTunnel/client";

type UseDesktopSpeechHostStateOptions = {
  projectId: string | null | undefined;
  desktopVoiceHostBridgeEnabled: boolean;
  desktopSpeechTunnelEnabled: boolean;
  runtimeControllerEnabled: boolean;
  setSpeechDependencyStatus: Dispatch<SetStateAction<SpeechDependencyStatus | null>>;
  showStatus: StatusContextValue["showStatus"];
};

export type DesktopSpeechHostState = {
  desktopVoiceHostStatus: DesktopVoiceHostBridgeStatus | null;
  desktopVoiceHostLifecycle: DesktopVoiceHostLifecycleSummary | null;
  desktopVoiceHostToggleBusy: boolean;
  desktopVoiceHostRestarting: boolean;
  desktopVoiceHostBootstrapBusy: boolean;
  desktopVoiceHostRemoveBusy: boolean;
  desktopVoiceHostBootstrapResult: DesktopVoiceHostBootstrapBridgeResult | null;
  desktopSpeechTunnelStatus: DesktopSpeechTunnelBridgeStatus | null;
  desktopSpeechTunnelLifecycle: DesktopSpeechTunnelLifecycleSummary | null;
  desktopSpeechTunnelBusy: boolean;
  handleSetDesktopVoiceHostEnabled: (enabled: boolean) => Promise<void>;
  handleRestartDesktopVoiceHost: () => Promise<void>;
  handleBootstrapDesktopVoiceHost: () => Promise<void>;
  handleRemoveDesktopVoiceRuntime: () => Promise<void>;
  handleStartDesktopSpeechTunnel: () => Promise<void>;
};

export function useDesktopSpeechHostState(
  options: UseDesktopSpeechHostStateOptions,
): DesktopSpeechHostState {
  const [desktopVoiceHostStatus, setDesktopVoiceHostStatus] =
    useState<DesktopVoiceHostBridgeStatus | null>(null);
  const [desktopVoiceHostLoading, setDesktopVoiceHostLoading] = useState(false);
  const [desktopVoiceHostToggleBusy, setDesktopVoiceHostToggleBusy] = useState(false);
  const [desktopVoiceHostRestarting, setDesktopVoiceHostRestarting] = useState(false);
  const [desktopVoiceHostBootstrapBusy, setDesktopVoiceHostBootstrapBusy] = useState(false);
  const [desktopVoiceHostRemoveBusy, setDesktopVoiceHostRemoveBusy] = useState(false);
  const [desktopVoiceHostBootstrapResult, setDesktopVoiceHostBootstrapResult] =
    useState<DesktopVoiceHostBootstrapBridgeResult | null>(null);
  const [desktopSpeechTunnelStatus, setDesktopSpeechTunnelStatus] =
    useState<DesktopSpeechTunnelBridgeStatus | null>(null);
  const [desktopSpeechTunnelLoading, setDesktopSpeechTunnelLoading] = useState(false);
  const [desktopSpeechTunnelBusy, setDesktopSpeechTunnelBusy] = useState(false);

  const handleSetDesktopVoiceHostEnabled = useCallback(
    async (enabled: boolean) => {
      if (!desktopVoiceHostBridgeAvailable()) {
        return;
      }
      const projectId = options.projectId?.trim() ?? "";
      setDesktopVoiceHostToggleBusy(true);
      try {
        const next = await setDesktopVoiceHostEnabled(enabled);
        setDesktopVoiceHostStatus(next);
        setDesktopVoiceHostBootstrapResult(null);
        if (!enabled) {
          options.setSpeechDependencyStatus((current) =>
            current
              ? {
                  ...current,
                  localService: {
                    ...(current.localService ?? {}),
                    health: {
                      ...(current.localService?.health ?? {}),
                      reachable: false,
                      detail: "Desktop voice hosting is turned off on this Mac.",
                    },
                  },
                }
              : current,
          );
        }

        if (!enabled) {
          if (desktopSpeechTunnelBridgeAvailable()) {
            const nextTunnelStatus = await stopDesktopSpeechTunnel();
            setDesktopSpeechTunnelStatus(nextTunnelStatus);
          } else {
            setDesktopSpeechTunnelStatus(null);
          }

          if (projectId && options.runtimeControllerEnabled) {
            const accessToken = await resolveControllerAccessToken(null);
            if (accessToken) {
              const currentRoute = await readProjectSpeechRoute(projectId, accessToken);
              if (currentRoute?.hostMode === "desktop" && currentRoute.connectionType === "tunnel") {
                await writeProjectSpeechRoute(projectId, null, accessToken);
              }
            }
          }

          options.showStatus("Desktop voice host turned off for this Mac.", "info", 3200);
          return;
        }

        options.showStatus(
          "Desktop voice host enabled for this Mac. Instafy Desktop will prepare the speech runtime if needed.",
          "success",
          3600,
        );
      } catch (error) {
        options.showStatus(
          error instanceof Error
            ? error.message
            : "Unable to update the Desktop voice host setting.",
          "error",
          4200,
        );
      } finally {
        setDesktopVoiceHostToggleBusy(false);
      }
    },
    [options],
  );

  const handleRestartDesktopVoiceHost = useCallback(async () => {
    if (!desktopVoiceHostBridgeAvailable()) {
      return;
    }
    setDesktopVoiceHostRestarting(true);
    try {
      const next = await restartDesktopVoiceHost();
      setDesktopVoiceHostStatus(next);
      options.showStatus("Desktop voice host restart requested.", "success", 2600);
    } catch (error) {
      options.showStatus(
        error instanceof Error ? error.message : "Failed to restart the Desktop voice host.",
        "error",
        3600,
      );
    } finally {
      setDesktopVoiceHostRestarting(false);
    }
  }, [options]);

  const handleBootstrapDesktopVoiceHost = useCallback(async () => {
    if (!desktopVoiceHostBridgeAvailable()) {
      return;
    }
    setDesktopVoiceHostBootstrapBusy(true);
    try {
      const result = await bootstrapDesktopVoiceHost({
        action: "install_transcription",
        dryRun: false,
      });
      setDesktopVoiceHostBootstrapResult(result);
      if (result?.hostStatus) {
        setDesktopVoiceHostStatus(result.hostStatus);
      }
      if (result?.status) {
        options.setSpeechDependencyStatus(result.status);
      }
      if (!result?.ok) {
        options.showStatus(result?.error ?? "Desktop speech host repair failed.", "error", 4200);
        return;
      }
      options.showStatus("Desktop speech host repair finished.", "success", 3200);
    } catch (error) {
      options.showStatus(
        error instanceof Error ? error.message : "Desktop speech host repair failed.",
        "error",
        4200,
      );
    } finally {
      setDesktopVoiceHostBootstrapBusy(false);
    }
  }, [options]);

  const handleRemoveDesktopVoiceRuntime = useCallback(async () => {
    if (!desktopVoiceHostBridgeAvailable()) {
      return;
    }
    setDesktopVoiceHostRemoveBusy(true);
    try {
      const result = await bootstrapDesktopVoiceHost({
        action: "remove_transcription",
        dryRun: false,
      });
      setDesktopVoiceHostBootstrapResult(result);
      if (result?.hostStatus) {
        setDesktopVoiceHostStatus(result.hostStatus);
      }
      if (result?.status) {
        options.setSpeechDependencyStatus(result.status);
      }
      if (!result?.ok) {
        options.showStatus(result?.error ?? "Desktop speech runtime removal failed.", "error", 4200);
        return;
      }
      options.showStatus(
        "Removed the downloaded Desktop speech runtime from this Mac.",
        "success",
        3200,
      );
    } catch (error) {
      options.showStatus(
        error instanceof Error ? error.message : "Desktop speech runtime removal failed.",
        "error",
        4200,
      );
    } finally {
      setDesktopVoiceHostRemoveBusy(false);
    }
  }, [options]);

  const handleStartDesktopSpeechTunnel = useCallback(async () => {
    const projectId = options.projectId?.trim() ?? "";
    if (!projectId) {
      options.showStatus(
        "Select a space before exposing Desktop voice to other devices.",
        "warning",
        3200,
      );
      return;
    }
    if (!desktopSpeechTunnelBridgeAvailable()) {
      return;
    }
    const controllerUrl = controllerBaseUrl.trim();
    if (!controllerUrl) {
      options.showStatus(
        "Controller URL is missing, so Desktop cannot expose the speech tunnel.",
        "error",
        3600,
      );
      return;
    }
    setDesktopSpeechTunnelBusy(true);
    try {
      const accessToken = await resolveControllerAccessToken(null);
      if (!accessToken) {
        options.showStatus(
          "Login required before Desktop can expose the speech tunnel.",
          "error",
          3600,
        );
        return;
      }
      const next = await startDesktopSpeechTunnel({
        projectId,
        controllerUrl,
        controllerAccessToken: accessToken,
        forceRestart: true,
      });
      setDesktopSpeechTunnelStatus(next);
      if (!next || next.state !== "active" || !next.publicUrl) {
        options.showStatus(
          next?.lastError ?? "Desktop could not expose the speech tunnel for this space.",
          "error",
          4200,
        );
        return;
      }
      const routeResult = await writeProjectSpeechRoute(
        projectId,
        {
          baseUrl: next.publicUrl,
          connectionType: "tunnel",
          hostMode: "desktop",
        },
        accessToken,
      );
      if (!routeResult.success) {
        options.showStatus(
          routeResult.error ??
            "Desktop tunnel is running, but the project route could not be saved.",
          "error",
          4200,
        );
        return;
      }
      options.setSpeechDependencyStatus((current) =>
        current
          ? {
              ...current,
              localService: {
                ...(current.localService ?? {}),
                health: {
                  ...(current.localService?.health ?? {}),
                  configured: true,
                  reachable: true,
                  url: next.publicUrl,
                  detail: "Speech provider is reachable through the Desktop-managed tunnel.",
                },
              },
            }
          : current,
      );
      options.showStatus("Desktop speech tunnel is active for this space.", "success", 3200);
    } catch (error) {
      options.showStatus(
        error instanceof Error ? error.message : "Failed to start the Desktop speech tunnel.",
        "error",
        4200,
      );
    } finally {
      setDesktopSpeechTunnelBusy(false);
    }
  }, [options]);

  useEffect(() => {
    if (!options.desktopVoiceHostBridgeEnabled) {
      setDesktopVoiceHostStatus(null);
      setDesktopVoiceHostLoading(false);
      setDesktopVoiceHostBootstrapResult(null);
      return;
    }

    let cancelled = false;
    const refreshStatus = async (initial: boolean) => {
      if (initial) {
        setDesktopVoiceHostLoading(true);
      }
      try {
        const next = await readDesktopVoiceHostStatus();
        if (!cancelled) {
          setDesktopVoiceHostStatus(next);
        }
      } finally {
        if (initial && !cancelled) {
          setDesktopVoiceHostLoading(false);
        }
      }
    };

    void refreshStatus(true);
    const intervalId = window.setInterval(() => {
      void refreshStatus(false);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [options.desktopVoiceHostBridgeEnabled]);

  useEffect(() => {
    if (!options.desktopSpeechTunnelEnabled) {
      setDesktopSpeechTunnelStatus(null);
      setDesktopSpeechTunnelLoading(false);
      return;
    }

    let cancelled = false;
    const refreshStatus = async (initial: boolean) => {
      if (initial) {
        setDesktopSpeechTunnelLoading(true);
      }
      try {
        const next = await readDesktopSpeechTunnelStatus();
        if (!cancelled) {
          setDesktopSpeechTunnelStatus(next);
        }
      } finally {
        if (initial && !cancelled) {
          setDesktopSpeechTunnelLoading(false);
        }
      }
    };

    void refreshStatus(true);
    const intervalId = window.setInterval(() => {
      void refreshStatus(false);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [options.desktopSpeechTunnelEnabled, options.projectId]);

  const desktopVoiceHostLifecycle = useMemo(() => {
    if (!options.desktopVoiceHostBridgeEnabled) {
      return null;
    }
    if (desktopVoiceHostLoading) {
      return {
        badgeLabel: "Checking Desktop host",
        badgeTone: "neutral" as const,
        detail: "Instafy Desktop is checking speech hosting on this Mac.",
        actionLabel: "Restart Desktop host",
      };
    }
    return describeDesktopVoiceHostLifecycle(desktopVoiceHostStatus);
  }, [desktopVoiceHostLoading, desktopVoiceHostStatus, options.desktopVoiceHostBridgeEnabled]);

  const desktopSpeechTunnelLifecycle = useMemo(() => {
    if (!options.desktopSpeechTunnelEnabled) {
      return null;
    }
    const activeProjectId = options.projectId?.trim() ?? "";
    if (desktopSpeechTunnelLoading) {
      return {
        badgeLabel: "Checking Desktop tunnel",
        badgeTone: "neutral" as const,
        detail:
          "Instafy Desktop is checking whether this space already has an active speech tunnel.",
        actionLabel: "Refresh Desktop tunnel",
      };
    }
    if (
      desktopSpeechTunnelStatus?.projectId &&
      activeProjectId &&
      desktopSpeechTunnelStatus.projectId !== activeProjectId
    ) {
      return {
        badgeLabel: "Desktop tunnel active elsewhere",
        badgeTone: "neutral" as const,
        detail:
          "Instafy Desktop already has a speech tunnel open for another space. Keeping this space active here will move the tunnel to this space automatically, or you can refresh it now.",
        actionLabel: "Refresh Desktop tunnel",
      };
    }
    return describeDesktopSpeechTunnelLifecycle(desktopSpeechTunnelStatus);
  }, [
    desktopSpeechTunnelLoading,
    desktopSpeechTunnelStatus,
    options.desktopSpeechTunnelEnabled,
    options.projectId,
  ]);

  return {
    desktopVoiceHostStatus,
    desktopVoiceHostLifecycle,
    desktopVoiceHostToggleBusy,
    desktopVoiceHostRestarting,
    desktopVoiceHostBootstrapBusy,
    desktopVoiceHostRemoveBusy,
    desktopVoiceHostBootstrapResult,
    desktopSpeechTunnelStatus,
    desktopSpeechTunnelLifecycle,
    desktopSpeechTunnelBusy,
    handleSetDesktopVoiceHostEnabled,
    handleRestartDesktopVoiceHost,
    handleBootstrapDesktopVoiceHost,
    handleRemoveDesktopVoiceRuntime,
    handleStartDesktopSpeechTunnel,
  };
}
