// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExtensionsPanelData } from "../useExtensionsPanelData";

const {
  listBuiltInAssistantDefinitionsMock,
  isLocalProviderHostUnavailableOnThisClientMock,
  listLocalProvidersMock,
  listCurrentClientNativeRuntimeProvidersMock,
  getNativeCameraStatusMock,
  listForProjectMock,
  providerRequestsListMock,
  providerDevicesListMock,
} = vi.hoisted(() => ({
  listBuiltInAssistantDefinitionsMock: vi.fn(),
  isLocalProviderHostUnavailableOnThisClientMock: vi.fn(),
  listLocalProvidersMock: vi.fn(),
  listCurrentClientNativeRuntimeProvidersMock: vi.fn(),
  getNativeCameraStatusMock: vi.fn(),
  listForProjectMock: vi.fn(),
  providerRequestsListMock: vi.fn(),
  providerDevicesListMock: vi.fn(),
}));

vi.mock("../../../../assistants/localBuiltInAssistantCatalog", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../assistants/localBuiltInAssistantCatalog")
  >()),
  listBuiltInAssistantDefinitions: listBuiltInAssistantDefinitionsMock,
}));

vi.mock("../../../../capabilities/localProviderHostClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../capabilities/localProviderHostClient")>()),
  isLocalProviderHostUnavailableOnThisClient: isLocalProviderHostUnavailableOnThisClientMock,
  listLocalProviders: listLocalProvidersMock,
}));

vi.mock("../../../../capabilities/projectProviderAccess", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../capabilities/projectProviderAccess")
  >("../../../../capabilities/projectProviderAccess");
  return {
    ...actual,
    listCurrentClientNativeRuntimeProviders: listCurrentClientNativeRuntimeProvidersMock,
  };
});

vi.mock("../../../../camera/nativeCameraBridge", () => ({
  getNativeCameraStatus: getNativeCameraStatusMock,
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    core: {
      enabled: true,
    },
    integrations: {
      listForProject: listForProjectMock,
    },
    providerRequests: {
      list: providerRequestsListMock,
    },
    providerDevices: {
      list: providerDevicesListMock,
    },
  },
}));

type HarnessValue = ReturnType<typeof useExtensionsPanelData>;

function Harness(props: {
  activeProjectId: string | null;
  onValue: (value: HarnessValue) => void;
}) {
  const value = useExtensionsPanelData({
    activeProjectId: props.activeProjectId,
  });
  props.onValue(value);
  return null;
}

describe("useExtensionsPanelData", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;

    listBuiltInAssistantDefinitionsMock.mockReset();
    isLocalProviderHostUnavailableOnThisClientMock.mockReset();
    listLocalProvidersMock.mockReset();
    listCurrentClientNativeRuntimeProvidersMock.mockReset();
    getNativeCameraStatusMock.mockReset();
    listForProjectMock.mockReset();
    providerRequestsListMock.mockReset();
    providerDevicesListMock.mockReset();

    listBuiltInAssistantDefinitionsMock.mockReturnValue([
      {
        mentionToken: "@camera",
        capabilityBindings: [{ capabilityId: "camera_observation", enabled: true }],
      },
    ]);
    isLocalProviderHostUnavailableOnThisClientMock.mockReturnValue(false);
    listLocalProvidersMock.mockResolvedValue({
      providers: [
        {
          id: "camera:pixel-test",
          title: "Kitchen camera",
          capabilityIds: ["camera_observation"],
          discoverable: true,
        },
      ],
    });
    listCurrentClientNativeRuntimeProvidersMock.mockResolvedValue([
      {
        id: "demo:native",
        title: "Demo arm",
        capabilityIds: ["robot_motion"],
        discoverable: true,
      },
    ]);
    getNativeCameraStatusMock.mockResolvedValue(null);
    listForProjectMock.mockResolvedValue({
      success: true,
      integrations: [
        {
          id: "integration-speech-1",
          projectId: "project-123",
          provider: "speech:remote-host",
          status: "attached",
          connectionType: "local_provider",
          credentialId: null,
          metadata: {},
          requiredScopes: [],
          capabilities: ["speech_transcription"],
          createdBy: null,
          createdAt: "2026-04-19T08:00:00.000Z",
          updatedAt: "2026-04-19T08:00:00.000Z",
        },
      ],
    });
    providerRequestsListMock.mockResolvedValue([]);
    providerDevicesListMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("returns normalized extension entries and semantic refresh or native-status update methods", async () => {
    await act(async () => {
      root.render(
        <Harness
          activeProjectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestValue?.localProvidersLoading).toBe(false);
    expect(latestValue?.projectIntegrationsLoading).toBe(false);
    expect(latestValue?.localProvidersError).toBeNull();
    expect(latestValue?.projectIntegrationsError).toBeNull();
    expect(providerRequestsListMock).not.toHaveBeenCalled();
    expect(providerDevicesListMock).not.toHaveBeenCalled();
    expect(latestValue?.projectExtensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mutationProviderId: "camera:pixel-test",
          source: "host",
          discoverable: true,
        }),
        expect.objectContaining({
          mutationProviderId: "demo:native",
          source: "native_runtime",
          discoverable: true,
        }),
        expect.objectContaining({
          mutationProviderId: "speech:remote-host",
          source: "project_integration",
          attached: true,
          discoverable: false,
        }),
      ]),
    );
    expect(Array.from(latestValue?.attachedExtensionFamilyCounts.entries() ?? [])).toEqual([
      ["speech:remote-host", 1],
    ]);
    expect(latestValue?.cameraAttachedDeviceItems).toEqual([]);

    await act(async () => {
      latestValue?.updateNativeRuntimeStatus("demo:native", {
        connected: true,
        source: "native",
      } as never);
      latestValue?.updateNativeAuxiliaryStatus("demo:native", "charging" as never);
      latestValue?.updateNativeCameraStatus("camera:pixel-test", {
        providerId: "camera:pixel-test",
        connected: true,
      } as never);
      await latestValue?.refreshLocalProviders();
      await latestValue?.refreshProjectIntegrations();
    });

    expect(latestValue?.nativeRuntimeStatusByProvider["demo:native"]?.status).toEqual(
      expect.objectContaining({ connected: true }),
    );
    expect(latestValue?.nativeAuxiliaryStatusByProvider["demo:native"]?.status).toBe("charging");
    expect(latestValue?.nativeCameraHealthStateByProvider["camera:pixel-test"]?.status).toEqual(
      expect.objectContaining({ providerId: "camera:pixel-test" }),
    );
    expect(latestValue?.currentNativeCameraStatus).toEqual(
      expect.objectContaining({ providerId: "camera:pixel-test" }),
    );
    expect(listLocalProvidersMock).toHaveBeenCalledTimes(2);
    expect(listForProjectMock).toHaveBeenCalledTimes(2);
  });
});
