import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { listBuiltInAssistantDefinitions } from "../../../assistants/localBuiltInAssistantCatalog";
import {
  isLocalProviderHostUnavailableOnThisClient,
  listLocalProviders,
  type LocalProviderSummary,
} from "../../../capabilities/localProviderHostClient";
import { listCurrentClientNativeRuntimeProviders } from "../../../capabilities/projectProviderAccess";
import { getNativeCameraStatus } from "../../../camera/nativeCameraBridge";
import type { CameraStatusSnapshot } from "../../../camera/types";
import {
  listCameraExtensionAttachedDeviceItems,
  type CameraExtensionAttachedDeviceItem,
} from "../../../extensions/cameraExtensionFamilyPresentation";
import {
  resolveExtensionFamilyCurrentNativeProviderId,
  supportsExtensionRemoteDeviceUi,
} from "../../../extensions/extensionFamilyUiRegistry";
import {
  NATIVE_EXTENSION_STATE_UPDATED_EVENT,
  readNativeExtensionStateUpdateDetail,
} from "../../../extensions/nativeExtensionStateChannel";
import { controllerClient } from "../../../sdk/instafy";
import type { ControllerProjectIntegration } from "../../../services/runtimeController/integrations";
import type { ControllerProviderRequestRecord } from "../../../services/runtimeController";
import type { ControllerProviderDeviceRecord } from "../../../services/runtimeController/providerDevices";
import type { NativeExtensionStatusValue } from "../../../extensions/nativeExtensionTypes";
import type { ProjectExtensionEntry } from "./extensionsPanelRowModel";
import {
  buildProjectExtensionEntries,
  countAttachedExtensionFamilies,
  listAttachedCameraProviderIds,
} from "./extensionsPanelData";

const runtimeControllerEnabled = controllerClient.core.enabled;

type CheckedStatus<T> = {
  status: T | null;
  checkedAt: string | null;
};

function createCheckedStatus<T>(status: T | null): CheckedStatus<T> {
  return {
    status,
    checkedAt: new Date().toISOString(),
  };
}

export function useExtensionsPanelData({ activeProjectId }: { activeProjectId: string | null }) {
  const [localProviders, setLocalProviders] = useState<LocalProviderSummary[]>([]);
  const [nativeRuntimeProviders, setNativeRuntimeProviders] = useState<LocalProviderSummary[]>([]);
  const [localProvidersLoading, setLocalProvidersLoading] = useState(false);
  const [localProvidersError, setLocalProvidersError] = useState<string | null>(null);
  const [projectIntegrations, setProjectIntegrations] = useState<ControllerProjectIntegration[]>([]);
  const [projectIntegrationsLoading, setProjectIntegrationsLoading] = useState(false);
  const [projectIntegrationsError, setProjectIntegrationsError] = useState<string | null>(null);
  const [nativeRuntimeStatusByProvider, setNativeRuntimeStatusByProvider] = useState<
    Record<string, CheckedStatus<NativeExtensionStatusValue>>
  >({});
  const [nativeAuxiliaryStatusByProvider, setNativeAuxiliaryStatusByProvider] = useState<
    Record<string, CheckedStatus<NativeExtensionStatusValue>>
  >({});
  const [nativeCameraHealthStateByProvider, setNativeCameraHealthStateByProvider] = useState<
    Record<string, CheckedStatus<CameraStatusSnapshot>>
  >({});
  const [currentNativeCameraStatus, setCurrentNativeCameraStatus] = useState<CameraStatusSnapshot | null>(null);
  const [remoteCameraRequestsByProvider, setRemoteCameraRequestsByProvider] = useState<
    Record<string, ControllerProviderRequestRecord[]>
  >({});
  const [remoteCameraDevicesByProvider, setRemoteCameraDevicesByProvider] = useState<
    Record<string, ControllerProviderDeviceRecord>
  >({});

  const localProvidersRequestVersionRef = useRef(0);
  const nativeRuntimeProvidersRequestVersionRef = useRef(0);
  const localProviderHostUnavailableOnThisClient = isLocalProviderHostUnavailableOnThisClient();
  const builtInAssistants = useMemo(() => listBuiltInAssistantDefinitions(), []);

  const currentNativeCameraProviderId = useMemo(
    () =>
      resolveExtensionFamilyCurrentNativeProviderId({
        familyId: CAMERA_PROVIDER_FAMILY.id,
        nativeRuntimeProviders,
        currentNativeCameraStatus,
      }),
    [currentNativeCameraStatus, nativeRuntimeProviders],
  );

  const updateNativeRuntimeStatus = useCallback(
    (providerId: string, status: NativeExtensionStatusValue) => {
      setNativeRuntimeStatusByProvider((current) => ({
        ...current,
        [providerId]: createCheckedStatus(status),
      }));
    },
    [],
  );

  const updateNativeAuxiliaryStatus = useCallback(
    (providerId: string, status: NativeExtensionStatusValue) => {
      setNativeAuxiliaryStatusByProvider((current) => ({
        ...current,
        [providerId]: createCheckedStatus(status),
      }));
    },
    [],
  );

  const updateNativeCameraStatus = useCallback(
    (providerId: string, status: CameraStatusSnapshot | null) => {
      setNativeCameraHealthStateByProvider((current) => ({
        ...current,
        [providerId]: createCheckedStatus(status),
      }));
      if (supportsExtensionRemoteDeviceUi(providerId)) {
        setCurrentNativeCameraStatus(status);
      }
    },
    [],
  );

  const refreshLocalProviders = useCallback(async () => {
    const requestVersion = localProvidersRequestVersionRef.current + 1;
    localProvidersRequestVersionRef.current = requestVersion;
    setLocalProvidersLoading(true);
    setLocalProvidersError(null);
    try {
      const result = await listLocalProviders();
      if (localProvidersRequestVersionRef.current === requestVersion) {
        setLocalProviders(result.providers ?? []);
      }
    } catch (error: unknown) {
      if (localProvidersRequestVersionRef.current === requestVersion) {
        setLocalProviders([]);
        setLocalProvidersError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (localProvidersRequestVersionRef.current === requestVersion) {
        setLocalProvidersLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshLocalProviders();
  }, [refreshLocalProviders]);

  const loadCurrentNativeRuntimeProviders = useCallback(async () => {
    const requestVersion = nativeRuntimeProvidersRequestVersionRef.current + 1;
    nativeRuntimeProvidersRequestVersionRef.current = requestVersion;
    try {
      const [providers, cameraStatus] = await Promise.all([
        listCurrentClientNativeRuntimeProviders(),
        getNativeCameraStatus().catch(() => null),
      ]);
      if (nativeRuntimeProvidersRequestVersionRef.current !== requestVersion) {
        return;
      }
      setNativeRuntimeProviders(providers);
      setCurrentNativeCameraStatus(cameraStatus);
      const cameraProviderId = resolveExtensionFamilyCurrentNativeProviderId({
        familyId: CAMERA_PROVIDER_FAMILY.id,
        nativeRuntimeProviders: providers,
        currentNativeCameraStatus: cameraStatus,
      });
      const cameraProvider =
        (cameraProviderId
          ? providers.find((provider) => provider.id === cameraProviderId)
          : null) ?? null;
      if (cameraProvider) {
        updateNativeCameraStatus(cameraProvider.id, cameraStatus);
      }
    } catch {
      if (nativeRuntimeProvidersRequestVersionRef.current === requestVersion) {
        setNativeRuntimeProviders([]);
        setCurrentNativeCameraStatus(null);
      }
    }
  }, [updateNativeCameraStatus]);

  useEffect(() => {
    void loadCurrentNativeRuntimeProviders();
  }, [loadCurrentNativeRuntimeProviders]);

  const refreshProjectIntegrations = useCallback(async () => {
    if (!runtimeControllerEnabled || !activeProjectId) {
      setProjectIntegrations([]);
      setProjectIntegrationsError(null);
      setProjectIntegrationsLoading(false);
      return;
    }

    setProjectIntegrationsLoading(true);
    setProjectIntegrationsError(null);
    try {
      const result = await controllerClient.integrations.listForProject(activeProjectId);
      if (!result.success) {
        throw new Error(result.error ?? "Unable to load project integrations.");
      }
      setProjectIntegrations(result.integrations);
    } catch (error) {
      setProjectIntegrations([]);
      setProjectIntegrationsError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectIntegrationsLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void refreshProjectIntegrations();
  }, [refreshProjectIntegrations]);

  useEffect(() => {
    const handleFocus = () => {
      void loadCurrentNativeRuntimeProviders();
      void refreshProjectIntegrations();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadCurrentNativeRuntimeProviders();
        void refreshProjectIntegrations();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadCurrentNativeRuntimeProviders, refreshProjectIntegrations]);

  useEffect(() => {
    const handleNativeExtensionStateUpdated = (event: Event) => {
      const detail = readNativeExtensionStateUpdateDetail(event);
      if (!detail || detail.projectId !== activeProjectId) {
        return;
      }

      if (detail.cameraStatus && supportsExtensionRemoteDeviceUi(detail.providerId)) {
        updateNativeCameraStatus(detail.providerId, detail.cameraStatus);
      }

      if (detail.integrationUpdated) {
        void refreshProjectIntegrations();
      }
    };

    window.addEventListener(
      NATIVE_EXTENSION_STATE_UPDATED_EVENT,
      handleNativeExtensionStateUpdated,
    );
    return () => {
      window.removeEventListener(
        NATIVE_EXTENSION_STATE_UPDATED_EVENT,
        handleNativeExtensionStateUpdated,
      );
    };
  }, [activeProjectId, refreshProjectIntegrations, updateNativeCameraStatus]);

  const projectExtensions = useMemo<ProjectExtensionEntry[]>(
    () =>
      buildProjectExtensionEntries({
        builtInAssistants,
        localProviders,
        nativeRuntimeProviders,
        projectIntegrations,
        currentNativeCameraProviderId,
      }),
    [
      builtInAssistants,
      currentNativeCameraProviderId,
      localProviders,
      nativeRuntimeProviders,
      projectIntegrations,
    ],
  );

  const attachedCameraProviderIds = useMemo(
    () => listAttachedCameraProviderIds(projectExtensions),
    [projectExtensions],
  );

  const attachedExtensionFamilyCounts = useMemo(
    () => countAttachedExtensionFamilies(projectExtensions),
    [projectExtensions],
  );

  useEffect(() => {
    if (!runtimeControllerEnabled || !activeProjectId || attachedCameraProviderIds.length === 0) {
      setRemoteCameraRequestsByProvider({});
      setRemoteCameraDevicesByProvider({});
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timerId = window.setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      try {
        const [nextEntries, deviceRecords] = await Promise.all([
          Promise.all(
            attachedCameraProviderIds.map(async (providerId) => {
              const requests = await controllerClient.providerRequests
                .list({
                  projectId: activeProjectId,
                  providerId,
                  statuses: ["pending", "claimed", "failed", "expired"],
                  limit: 20,
                })
                .catch(() => []);
              return [providerId, requests] as const;
            }),
          ),
          controllerClient.providerDevices
            .list({
              projectId: activeProjectId,
              providerFamilyId: CAMERA_PROVIDER_FAMILY.id,
              limit: 50,
            })
            .catch(() => []),
        ]);
        if (cancelled) {
          return;
        }
        setRemoteCameraRequestsByProvider(Object.fromEntries(nextEntries));
        setRemoteCameraDevicesByProvider(
          Object.fromEntries(deviceRecords.map((device) => [device.providerId, device] as const)),
        );
      } finally {
        schedule(3_000);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeProjectId, attachedCameraProviderIds]);

  const cameraAttachedDeviceItems = useMemo<CameraExtensionAttachedDeviceItem[]>(
    () =>
      listCameraExtensionAttachedDeviceItems({
        entries: projectExtensions
          .filter((entry) => entry.attached && supportsExtensionRemoteDeviceUi(entry.mutationProviderId))
          .map((entry) => ({
            attached: entry.attached,
            mutationProviderId: entry.mutationProviderId,
            source: entry.source,
            selectedDevice: entry.selectedDevice,
            integration: entry.integration,
          })),
        currentNativeCameraProviderId,
        currentNativeCameraStatus,
        remoteCameraDevicesByProvider,
        remoteCameraRequestsByProvider,
      }),
    [
      currentNativeCameraProviderId,
      currentNativeCameraStatus,
      projectExtensions,
      remoteCameraDevicesByProvider,
      remoteCameraRequestsByProvider,
    ],
  );

  return {
    localProviderHostUnavailableOnThisClient,
    localProvidersLoading,
    localProvidersError,
    projectIntegrations,
    projectIntegrationsLoading,
    projectIntegrationsError,
    refreshLocalProviders,
    refreshProjectIntegrations,
    nativeRuntimeStatusByProvider,
    updateNativeRuntimeStatus,
    nativeAuxiliaryStatusByProvider,
    updateNativeAuxiliaryStatus,
    nativeCameraHealthStateByProvider,
    updateNativeCameraStatus,
    currentNativeCameraStatus,
    remoteCameraRequestsByProvider,
    remoteCameraDevicesByProvider,
    projectExtensions,
    attachedExtensionFamilyCounts,
    cameraAttachedDeviceItems,
  };
}
