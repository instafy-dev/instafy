import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  attachProjectProviderMock,
  detachProjectProviderMock,
  upsertProjectIntegrationMock,
  resolveNativeExtensionRegistrationMock,
} = vi.hoisted(() => ({
  attachProjectProviderMock: vi.fn(),
  detachProjectProviderMock: vi.fn(),
  upsertProjectIntegrationMock: vi.fn(),
  resolveNativeExtensionRegistrationMock: vi.fn(),
}));

vi.mock("../../../../capabilities/projectProviderAccess", async () => {
  const actual = await vi.importActual<typeof import("../../../../capabilities/projectProviderAccess")>(
    "../../../../capabilities/projectProviderAccess",
  );
  return {
    ...actual,
    attachProjectProvider: attachProjectProviderMock,
    detachProjectProvider: detachProjectProviderMock,
  };
});

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    integrations: {
      upsert: upsertProjectIntegrationMock,
    },
  },
}));

vi.mock("../../../../extensions/nativeExtensionRegistry", () => ({
  resolveNativeExtensionRegistration: resolveNativeExtensionRegistrationMock,
}));

import { createExtensionsPanelActionController } from "../useExtensionsPanelActions";

function createStateBox<T>(initialValue: T) {
  let value = initialValue;
  const set = vi.fn((next: T | ((current: T) => T)) => {
    value = typeof next === "function" ? (next as (current: T) => T)(value) : next;
  });
  return {
    set,
    get value() {
      return value;
    },
  };
}

function createCameraEntry() {
  const provider = {
    id: "camera:pixel-test",
    title: "Kitchen camera",
    capabilityIds: ["camera_observation"],
  };
  const integration = {
    id: "integration-camera-1",
    projectId: "project-1",
    provider: "camera:pixel-test",
    status: "connected",
    connectionType: "native_runtime",
    credentialId: null,
    metadata: {},
    requiredScopes: [],
    capabilities: ["camera_observation"],
    createdBy: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
  };

  return {
    provider,
    integration,
    entry: {
      provider,
      source: "native_runtime",
      integration,
      mutationProviderId: "camera:pixel-test",
      discoverable: true,
      attached: false,
      selectedDevice: null,
      cameraState: {
        selectedLens: null,
        lastCapture: null,
        updatedAt: null,
      },
      assistantDefinitions: [],
      capabilityIds: ["camera_observation"],
      providerCapabilityIds: ["camera_observation"],
      attachedCapabilityIds: ["camera_observation"],
    },
  };
}

function createInput(overrides?: Record<string, unknown>) {
  const pendingProvider = createStateBox<string | null>(null);
  const expandedProviderDetails = createStateBox<Record<string, boolean>>({});
  const nativeRuntimeStatusState = createStateBox({});
  const nativeAuxiliaryStatusState = createStateBox({});
  const nativeCameraHealthState = createStateBox({});
  const currentNativeCameraStatus = createStateBox<unknown>(null);
  const showStatus = vi.fn();
  const refreshProjectIntegrations = vi.fn().mockResolvedValue(undefined);
  const onProviderMutationPendingChange = vi.fn((providerId: string | null) => {
    pendingProvider.set(providerId);
  });
  const expandProviderDetails = vi.fn((providerId: string) => {
    expandedProviderDetails.set((current) => ({
      ...current,
      [providerId]: true,
    }));
  });
  const updateNativeRuntimeStatus = vi.fn(
    (providerId: string, status: unknown) => {
      nativeRuntimeStatusState.set((current) => ({
        ...current,
        [providerId]: {
          status,
          checkedAt: "2026-04-19T10:00:00.000Z",
        },
      }));
    },
  );
  const updateNativeAuxiliaryStatus = vi.fn(
    (providerId: string, status: unknown) => {
      nativeAuxiliaryStatusState.set((current) => ({
        ...current,
        [providerId]: {
          status,
          checkedAt: "2026-04-19T10:00:00.000Z",
        },
      }));
    },
  );
  const updateNativeCameraStatus = vi.fn(
    (providerId: string, status: unknown) => {
      nativeCameraHealthState.set((current) => ({
        ...current,
        [providerId]: {
          status,
          checkedAt: "2026-04-19T10:00:00.000Z",
        },
      }));
      currentNativeCameraStatus.set(status);
    },
  );
  const base = {
    activeProjectId: "project-1",
    activeProjectName: "Kitchen",
    projectExtensions: [],
    projectIntegrations: [],
    refreshProjectIntegrations,
    showStatus,
    onProviderMutationPendingChange,
    expandProviderDetails,
    updateNativeRuntimeStatus,
    updateNativeAuxiliaryStatus,
    updateNativeCameraStatus,
  };

  return {
    input: {
      ...base,
      ...overrides,
    } as Parameters<typeof createExtensionsPanelActionController>[0],
    state: {
      pendingProvider,
      expandedProviderDetails,
      nativeRuntimeStatusState,
      nativeAuxiliaryStatusState,
      nativeCameraHealthState,
      currentNativeCameraStatus,
      showStatus,
      refreshProjectIntegrations,
      onProviderMutationPendingChange,
      expandProviderDetails,
      updateNativeRuntimeStatus,
      updateNativeAuxiliaryStatus,
      updateNativeCameraStatus,
    },
  };
}

describe("useExtensionsPanelActions", () => {
  beforeEach(() => {
    attachProjectProviderMock.mockReset();
    detachProjectProviderMock.mockReset();
    upsertProjectIntegrationMock.mockReset();
    resolveNativeExtensionRegistrationMock.mockReset();
  });

  it("expands native setup details after a successful native attach", async () => {
    const { entry } = createCameraEntry();
    attachProjectProviderMock.mockResolvedValue({
      success: true,
      integration: entry.integration,
    });
    const { input, state } = createInput({
      projectExtensions: [entry],
      projectIntegrations: [entry.integration],
    });
    const controller = createExtensionsPanelActionController(input);

    await controller.handleAttachEntry(
      entry as never,
      {
        connectionType: "native_runtime",
        hasNativeSetup: true,
        nativeCameraAttachMetadata: {
          transport: "lan",
          identifier: "pixel-device",
          address: "192.168.1.20",
          name: "Pixel 9",
        },
      } as never,
    );

    expect(attachProjectProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        providerId: "camera:pixel-test",
        connectionType: "native_runtime",
        metadata: expect.objectContaining({
          attachedFrom: "extensions_panel",
          selectedDevice: expect.objectContaining({
            identifier: "pixel-device",
            name: "Pixel 9",
          }),
        }),
      }),
    );
    expect(state.refreshProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(state.expandedProviderDetails.value).toEqual({
      "camera:pixel-test": true,
    });
    expect(state.expandProviderDetails).toHaveBeenCalledWith("camera:pixel-test");
    expect(state.pendingProvider.value).toBeNull();
  });

  it("updates all attached family integrations when selecting a new default device", async () => {
    const { entry, integration } = createCameraEntry();
    const siblingIntegration = {
      ...integration,
      id: "integration-camera-2",
      provider: "camera:iphone-test",
      metadata: {
        selectedDevice: {
          transport: "lan",
          identifier: "iphone-device",
          address: "192.168.1.30",
          name: "iPhone 16",
        },
      },
    };
    const defaultEntry = {
      ...entry,
      attached: true,
      selectedDevice: {
        transport: "lan",
        identifier: "pixel-device",
        address: "192.168.1.20",
        name: "Pixel 9",
      },
      integration,
    };
    upsertProjectIntegrationMock.mockResolvedValue({
      success: true,
      integration,
    });
    const { input, state } = createInput({
      projectExtensions: [defaultEntry],
      projectIntegrations: [integration, siblingIntegration],
    });
    const controller = createExtensionsPanelActionController(input);

    await controller.handleSetFamilyDefault(defaultEntry as never);

    expect(upsertProjectIntegrationMock).toHaveBeenCalledTimes(2);
    const payloadByProvider = new Map(
      upsertProjectIntegrationMock.mock.calls.map((call) => [call[1], call[2]]),
    );
    expect(payloadByProvider.get("camera:pixel-test")).toMatchObject({
      status: "connected",
      connectionType: "native_runtime",
      metadata: expect.objectContaining({
        defaultForFamily: true,
        preferredProviderId: "camera:pixel-test",
      }),
    });
    expect(payloadByProvider.get("camera:iphone-test")).toMatchObject({
      status: "connected",
      connectionType: "native_runtime",
      metadata: expect.objectContaining({
        preferredProviderId: "camera:pixel-test",
      }),
    });
    expect(payloadByProvider.get("camera:iphone-test")?.metadata).not.toHaveProperty("defaultForFamily");
    expect(state.refreshProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(state.showStatus).toHaveBeenCalledWith(
      expect.stringContaining("will prefer Pixel 9"),
      "success",
      3000,
    );
    expect(state.pendingProvider.value).toBeNull();
  });

  it("delegates live native status updates through semantic panel data updaters", () => {
    const { input, state } = createInput();
    const controller = createExtensionsPanelActionController(input);

    controller.handleRuntimeStatusChange("demo", {
      connected: true,
      source: "native",
    } as never);
    controller.handleAuxiliaryStatusChange("demo", "charging" as never);
    controller.handleCameraStatusChange("camera:pixel-test", {
      providerId: "camera:pixel-test",
      connected: true,
    } as never);

    expect(state.updateNativeRuntimeStatus).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({ connected: true }),
    );
    expect(state.updateNativeAuxiliaryStatus).toHaveBeenCalledWith("demo", "charging");
    expect(state.updateNativeCameraStatus).toHaveBeenCalledWith(
      "camera:pixel-test",
      expect.objectContaining({ connected: true }),
    );
    expect(state.currentNativeCameraStatus.value).toEqual(
      expect.objectContaining({ providerId: "camera:pixel-test" }),
    );
  });

  it("delegates runtime probes to the selected extension registration", async () => {
    const { provider } = createCameraEntry();
    const runRuntimeProbe = vi.fn().mockResolvedValue({
      connected: true,
    });
    resolveNativeExtensionRegistrationMock.mockReturnValue({
      runRuntimeProbe,
    });
    const { input, state } = createInput();
    const controller = createExtensionsPanelActionController(input);

    await expect(controller.handleRuntimeProbe(provider)).resolves.toEqual({
      connected: true,
    });

    expect(resolveNativeExtensionRegistrationMock).toHaveBeenCalledWith({
      provider,
    });
    expect(runRuntimeProbe).toHaveBeenCalledWith({
      projectId: "project-1",
      provider,
    });
    expect(state.showStatus).toHaveBeenCalledWith(
      "Runtime probe completed for Camera.",
      "success",
      3000,
    );
  });
});
