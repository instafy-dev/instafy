import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPlatformMock, getNativeCameraStatusMock } = vi.hoisted(() => ({
  getPlatformMock: vi.fn(() => "web"),
  getNativeCameraStatusMock: vi.fn(async () => ({
    supported: true,
    platform: "android",
    backend: "phone_camera",
    deviceId: "android-test-device",
    deviceLabel: "Pixel Test",
    providerId: "camera:android-test-device",
    permission: "granted",
    permissionGranted: true,
    canCapture: true,
    availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
    selectedLens: "rear",
    lastCapture: null,
  })),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: getPlatformMock,
  },
}));

vi.mock("../../camera/nativeCameraBridge", () => ({
  getNativeCameraStatus: getNativeCameraStatusMock,
  supportsCurrentClientNativeCameraBridge: vi.fn(() => true),
}));

import {
  attachProjectProvider,
  detachProjectProvider,
  getProjectIntegrationByProvider,
  getProjectProviderFamilyPreferredProviderId,
  getProjectProviderFamilySelection,
  getNativeRuntimeFallbackProvider,
  getProjectProviderSelectedDevice,
  isProjectIntegrationAttached,
  listProjectIntegrationAssistantHandles,
  resolveProjectCapabilityProviderAccess,
  resolveProjectProviderAccess,
  withProjectProviderSelectedDevice,
  withoutProjectProviderSelectedDevice,
} from "../projectProviderAccess";

describe("project provider access", () => {
  beforeEach(() => {
    getPlatformMock.mockReturnValue("web");
    getNativeCameraStatusMock.mockClear();
    getNativeCameraStatusMock.mockResolvedValue({
      supported: true,
      platform: "android",
      backend: "phone_camera",
      deviceId: "android-test-device",
      deviceLabel: "Pixel Test",
      providerId: "camera:android-test-device",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: null,
    });
  });

  it("treats no-project local usage as an explicit unscoped runtime path", async () => {
    const listIntegrations = vi.fn();

    const result = await resolveProjectProviderAccess(
      {
        projectId: null,
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      listIntegrations,
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: true,
      source: "unscoped_local_runtime",
    });
    expect(listIntegrations).not.toHaveBeenCalled();
  });

  it("denies project-scoped provider use when policy cannot be loaded", async () => {
    const result = await resolveProjectProviderAccess(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: false,
        integrations: [],
        error: "controller offline",
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: false,
      source: "project_policy_unavailable",
    });
    expect(result.reason).toContain("controller offline");
  });

  it("resolves the attached discovered provider for a capability", async () => {
    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              attached: true,
              selectedDevice: {
                transport: "native_camera",
                identifier: "android-test-device",
                address: "android-test-device",
                name: "Pixel Test",
                nativePlatform: "android",
              },
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      async () => ({
        providers: [
          {
            id: "demo",
            title: "Demo",
            capabilityIds: ["robot_embodiment"],
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: true,
      source: "project_integration",
      provider: {
        id: "demo",
      },
    });
  });

  it("denies capability access when the provider is attached but not discoverable", async () => {
    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              attached: true,
              selectedDevice: {
                transport: "native_camera",
                identifier: "android-test-device",
                address: "android-test-device",
                name: "Pixel Test",
                nativePlatform: "android",
              },
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      async () => ({
        providers: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: false,
      source: "project_policy_unavailable",
    });
    expect(result.reason).toContain("not currently discoverable");
  });

  it.each(["android", "ios"])(
    "denies an attached provider without a registered native runtime fallback on %s",
    async (platform) => {
      getPlatformMock.mockReturnValue(platform);

      const result = await resolveProjectCapabilityProviderAccess(
        {
          projectId: "project-1",
          assistantHandle: "demo",
          capabilityId: "robot_embodiment",
        },
        async () => ({
          success: true,
          integrations: [
            {
              id: "integration-demo",
              projectId: "project-1",
              provider: "demo",
              status: "connected",
              connectionType: "native_runtime",
              credentialId: null,
              metadata: {
                attached: true,
              },
              requiredScopes: [],
              capabilities: ["robot_embodiment"],
              createdBy: null,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }),
        async () => ({
          providers: [],
        }),
      );

      expect(getNativeRuntimeFallbackProvider("demo")).toBeNull();
      expect(result).toMatchObject({
        providerId: "demo",
        allowed: false,
        source: "project_policy_unavailable",
        unavailableReason: "not_discoverable",
        provider: null,
      });
      expect(result.reason).toContain("not currently discoverable");
    },
  );

  it.each(["android", "ios"])(
    "allows an attached Camera provider through native runtime fallback on %s",
    async (platform) => {
      getPlatformMock.mockReturnValue(platform);

      const result = await resolveProjectCapabilityProviderAccess(
        {
          projectId: "project-1",
          assistantHandle: "octo",
          capabilityId: "camera_observation",
        },
        async () => ({
          success: true,
          integrations: [
            {
              id: "integration-camera",
              projectId: "project-1",
              provider: "camera",
              status: "connected",
              connectionType: "native_runtime",
              credentialId: null,
              metadata: {
                attached: true,
              },
              requiredScopes: [],
              capabilities: ["camera_observation"],
              createdBy: null,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }),
        async () => ({
          providers: [],
        }),
      );

      expect(getNativeRuntimeFallbackProvider("camera")).toMatchObject({
        id: "camera",
        providerType: "phone_camera",
      });
      expect(result).toMatchObject({
        providerId: "camera",
        allowed: true,
        source: "project_integration",
        provider: {
          id: "camera",
          providerType: "phone_camera",
        },
      });
    },
  );

  it.each(["android", "ios"])(
    "allows an attached Camera device instance through native runtime fallback on %s",
    async (platform) => {
      getPlatformMock.mockReturnValue(platform);
      getNativeCameraStatusMock.mockResolvedValue({
        supported: true,
        platform,
        backend: "phone_camera",
        deviceId: "android-test-device",
        deviceLabel: "Pixel Test",
        providerId: "camera:android-test-device",
        permission: "granted",
        permissionGranted: true,
        canCapture: true,
        availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
        selectedLens: "rear",
        lastCapture: null,
      });

      const result = await resolveProjectCapabilityProviderAccess(
        {
          projectId: "project-1",
          assistantHandle: "octo",
          capabilityId: "camera_observation",
        },
        async () => ({
          success: true,
          integrations: [
            {
              id: "integration-camera-instance",
              projectId: "project-1",
              provider: "camera:android-test-device",
              status: "connected",
              connectionType: "native_runtime",
              credentialId: null,
              metadata: {
                attached: true,
              },
              requiredScopes: [],
              capabilities: ["camera_observation"],
              createdBy: null,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }),
        async () => ({
          providers: [],
        }),
      );

      expect(getNativeRuntimeFallbackProvider("camera:android-test-device")).toMatchObject({
        id: "camera:android-test-device",
        providerType: "phone_camera",
      });
      expect(result).toMatchObject({
        providerId: "camera:android-test-device",
        allowed: true,
        source: "project_integration",
        provider: {
          id: "camera:android-test-device",
          providerType: "phone_camera",
        },
      });
    },
  );

  it("denies an attached Camera device instance when this client is a different device", async () => {
    getPlatformMock.mockReturnValue("android");
    getNativeCameraStatusMock.mockResolvedValue({
      supported: true,
      platform: "android",
      backend: "phone_camera",
      deviceId: "android-other-device",
      deviceLabel: "Other Device",
      providerId: "camera:android-other-device",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: null,
    });

    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "octo",
        capabilityId: "camera_observation",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-instance",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              selectedDevice: {
                transport: "native_camera",
                identifier: "android-test-device",
                address: "android-test-device",
                name: "Pixel Test",
                nativePlatform: "android",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      async () => ({
        providers: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "camera:android-test-device",
      allowed: true,
      source: "project_integration",
    });
    expect(result.reason).toContain("can be reached remotely");
  });

  it("prefers the family default camera instance when multiple are attached", async () => {
    getPlatformMock.mockReturnValue("android");
    getNativeCameraStatusMock.mockResolvedValue({
      supported: true,
      platform: "android",
      backend: "phone_camera",
      deviceId: "android-test-device",
      deviceLabel: "Pixel Test",
      providerId: "camera:android-test-device",
      permission: "granted",
      permissionGranted: true,
      canCapture: true,
      availableLenses: [{ id: "rear", title: "Rear camera", available: true }],
      selectedLens: "rear",
      lastCapture: null,
    });

    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "octo",
        capabilityId: "camera_observation",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-local",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-01T12:00:00.000Z",
            updatedAt: "2026-04-01T12:00:00.000Z",
          },
          {
            id: "integration-camera-default",
            projectId: "project-1",
            provider: "camera:ios-remote-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              defaultForFamily: true,
              selectedDevice: {
                transport: "native_camera",
                identifier: "ios-remote-device",
                address: "ios-remote-device",
                name: "Marcus iPhone",
                nativePlatform: "ios",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-01T12:05:00.000Z",
            updatedAt: "2026-04-01T12:05:00.000Z",
          },
        ],
      }),
      async () => ({
        providers: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "camera:ios-remote-device",
      allowed: true,
      source: "project_integration",
    });
    expect(result.reason).toContain("can be reached remotely");
  });

  it("prefers the explicit family preferred camera instance over legacy defaults", async () => {
    getPlatformMock.mockReturnValue("android");

    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "octo",
        capabilityId: "camera_observation",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-local",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              defaultForFamily: true,
              preferredProviderId: "camera:ios-remote-device",
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-01T12:00:00.000Z",
            updatedAt: "2026-04-01T12:00:00.000Z",
          },
          {
            id: "integration-camera-remote",
            projectId: "project-1",
            provider: "camera:ios-remote-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              preferredProviderId: "camera:ios-remote-device",
              selectedDevice: {
                transport: "native_camera",
                identifier: "ios-remote-device",
                address: "ios-remote-device",
                name: "Marcus iPhone",
                nativePlatform: "ios",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-01T12:05:00.000Z",
            updatedAt: "2026-04-01T12:05:00.000Z",
          },
        ],
      }),
      async () => ({
        providers: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "camera:ios-remote-device",
      allowed: true,
      source: "project_integration",
    });
  });

  it("prefers explicit provider family selection metadata over legacy preferred flags", async () => {
    getPlatformMock.mockReturnValue("android");

    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "octo",
        capabilityId: "camera_observation",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-local",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              defaultForFamily: true,
              preferredProviderId: "camera:android-test-device",
              providerFamilySelection: {
                familyId: "camera",
                preferredProviderId: "camera:ios-remote-device",
                updatedAt: "2026-04-04T09:05:00.000Z",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-04T09:00:00.000Z",
            updatedAt: "2026-04-04T09:05:00.000Z",
          },
          {
            id: "integration-camera-remote",
            projectId: "project-1",
            provider: "camera:ios-remote-device",
            status: "connected",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              preferredProviderId: "camera:android-test-device",
              providerFamilySelection: {
                familyId: "camera",
                preferredProviderId: "camera:ios-remote-device",
                preferredDevice: {
                  transport: "native_camera",
                  identifier: "ios-remote-device",
                  address: "ios-remote-device",
                  name: "Marcus iPhone",
                  nativePlatform: "ios",
                },
                updatedAt: "2026-04-04T09:05:00.000Z",
              },
              selectedDevice: {
                transport: "native_camera",
                identifier: "ios-remote-device",
                address: "ios-remote-device",
                name: "Marcus iPhone",
                nativePlatform: "ios",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "2026-04-04T09:02:00.000Z",
            updatedAt: "2026-04-04T09:05:00.000Z",
          },
        ],
      }),
      async () => ({
        providers: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "camera:ios-remote-device",
      allowed: true,
      source: "project_integration",
    });
  });

  it("marks only the first attached provider in a family as the default", async () => {
    const upsertIntegration = vi.fn(async (_projectId: string, provider: string, params: { metadata?: Record<string, unknown> }) => ({
      success: true,
      integration: {
        id: `integration-${provider}`,
        projectId: "project-1",
        provider,
        status: "attached",
        connectionType: "native_runtime",
        credentialId: null,
        metadata: params.metadata ?? {},
        requiredScopes: [],
        capabilities: ["camera_observation"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    await attachProjectProvider(
      {
        projectId: "project-1",
        providerId: "camera:android-test-device",
        capabilityId: "camera_observation",
        connectionType: "native_runtime",
      },
      async () => ({
        success: true,
        integrations: [],
      }),
      upsertIntegration,
    );

    await attachProjectProvider(
      {
        projectId: "project-1",
        providerId: "camera:ios-remote-device",
        capabilityId: "camera_observation",
        connectionType: "native_runtime",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-local",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "attached",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              enabled: true,
              defaultForFamily: true,
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      upsertIntegration,
    );

    const firstAttachMetadata = (upsertIntegration.mock.calls[0]?.[2] as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const secondAttachMetadata = (upsertIntegration.mock.calls[1]?.[2] as { metadata?: Record<string, unknown> } | undefined)?.metadata;

    expect(firstAttachMetadata?.defaultForFamily).toBe(true);
    expect(firstAttachMetadata?.preferredProviderId).toBe("camera:android-test-device");
    expect(firstAttachMetadata?.providerFamilySelection).toMatchObject({
      familyId: "camera",
      preferredProviderId: "camera:android-test-device",
      preferredDevice: null,
    });
    expect(secondAttachMetadata?.defaultForFamily).toBe(false);
    expect(secondAttachMetadata?.preferredProviderId).toBe("camera:android-test-device");
    expect(secondAttachMetadata?.providerFamilySelection).toMatchObject({
      familyId: "camera",
      preferredProviderId: "camera:android-test-device",
      preferredDevice: null,
    });
  });

  it("ignores undiscoverable providers returned by the local host list", async () => {
    const result = await resolveProjectCapabilityProviderAccess(
      {
        projectId: "project-1",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              attached: true,
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      async () => ({
        providers: [
          {
            id: "demo",
            title: "Demo",
            capabilityIds: ["robot_embodiment"],
            discoverable: false,
            error: "provider adapter offline",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: false,
      source: "project_policy_unavailable",
    });
    expect(result.reason).toContain("not currently discoverable");
  });

  it("allows attached project integrations that include the assistant and capability", async () => {
    const result = await resolveProjectProviderAccess(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              assistantHandles: ["demo"],
              attached: true,
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: true,
      source: "project_integration",
      integrationId: "integration-demo",
      status: "connected",
    });
  });

  it("denies provider access when the project has no provider attachment yet", async () => {
    const result = await resolveProjectProviderAccess(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: false,
      source: "project_integration_denied",
    });
    expect(result.reason).toContain("not attached");
  });

  it("denies provider access when a project integration restricts assistant handles", async () => {
    const result = await resolveProjectProviderAccess(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              assistantHandles: ["octo"],
              attached: true,
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      providerId: "demo",
      allowed: false,
      source: "project_integration_denied",
      integrationId: "integration-demo",
      status: "connected",
    });
    expect(result.reason).toContain("Assistant demo is not allowed");
  });

  it("attaches a provider to the project with explicit assistant and capability access", async () => {
    const upsertIntegration = vi.fn(async () => ({
      success: true,
      integration: {
        id: "integration-demo",
        projectId: "project-1",
        provider: "demo",
        status: "attached",
        connectionType: "local_provider",
        credentialId: null,
        metadata: {
          attached: true,
          assistantHandles: ["demo"],
        },
        requiredScopes: [],
        capabilities: ["robot_embodiment"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    const result = await attachProjectProvider(
      {
        projectId: "project-1",
        providerId: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [],
      }),
      upsertIntegration,
    );

    expect(result).toMatchObject({
      success: true,
      integration: {
        provider: "demo",
        status: "attached",
      },
    });
    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "demo",
      expect.objectContaining({
        status: "attached",
        connectionType: "local_provider",
        capabilities: ["robot_embodiment"],
        metadata: expect.objectContaining({
          attached: true,
          enabled: true,
          attachedVia: "local_provider_host",
        }),
      }),
    );
    const upsertCall = upsertIntegration.mock.calls[0] as unknown as
      | [string, string, { metadata?: Record<string, unknown> }]
      | undefined;
    const metadata = upsertCall?.[2]?.metadata ?? {};
    expect(metadata.assistantHandles).toBeUndefined();
    expect(metadata.allowedAssistantHandles).toBeUndefined();
    expect(metadata.allowedAgents).toBeUndefined();
  });

  it("merges an existing project integration when attaching a provider", async () => {
    const upsertIntegration = vi.fn(async () => ({
      success: true,
      integration: {
        id: "integration-demo",
        projectId: "project-1",
        provider: "demo",
        status: "connected",
        connectionType: "local_provider",
        credentialId: null,
        metadata: {
          attached: true,
          assistantHandles: ["octo", "demo"],
        },
        requiredScopes: [],
        capabilities: ["robot_embodiment", "device_toggle"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    await attachProjectProvider(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        capabilityId: "robot_embodiment",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              assistantHandles: ["octo"],
              attached: true,
              existingKey: "keep",
            },
            requiredScopes: ["scope:read"],
            capabilities: ["device_toggle"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      upsertIntegration,
    );

    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "demo",
      expect.objectContaining({
        status: "connected",
        connectionType: "local_provider",
        requiredScopes: ["scope:read"],
        capabilities: expect.arrayContaining(["device_toggle", "robot_embodiment"]),
        metadata: expect.objectContaining({
          existingKey: "keep",
          attached: true,
          enabled: true,
          assistantHandles: ["octo", "demo"],
          allowedAssistantHandles: ["octo", "demo"],
          allowedAgents: ["octo", "demo"],
        }),
      }),
    );
  });

  it("can attach a provider for multiple assistants and capabilities", async () => {
    const upsertIntegration = vi.fn(async () => ({
      success: true,
      integration: {
        id: "integration-demo",
        projectId: "project-1",
        provider: "demo",
        status: "attached",
        connectionType: "local_provider",
        credentialId: null,
        metadata: {
          attached: true,
          assistantHandles: ["octo", "demo"],
        },
        requiredScopes: [],
        capabilities: ["robot_embodiment", "device_toggle"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    await attachProjectProvider(
      {
        projectId: "project-1",
        providerId: "demo",
        assistantHandle: "demo",
        assistantHandles: ["octo"],
        capabilityId: "robot_embodiment",
        capabilityIds: ["device_toggle"],
      },
      async () => ({
        success: true,
        integrations: [],
      }),
      upsertIntegration,
    );

    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "demo",
      expect.objectContaining({
        capabilities: expect.arrayContaining(["robot_embodiment", "device_toggle"]),
        metadata: expect.objectContaining({
          assistantHandles: ["demo", "octo"],
          allowedAssistantHandles: ["demo", "octo"],
          allowedAgents: ["demo", "octo"],
        }),
      }),
    );
  });

  it("can detach a provider from the project without deleting its integration", async () => {
    const upsertIntegration = vi.fn(async () => ({
      success: true,
      integration: {
        id: "integration-demo",
        projectId: "project-1",
        provider: "demo",
        status: "available",
        connectionType: "local_provider",
        credentialId: null,
        metadata: {
          attached: false,
          enabled: false,
        },
        requiredScopes: [],
        capabilities: ["robot_embodiment"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    const result = await detachProjectProvider(
      {
        projectId: "project-1",
        providerId: "demo",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-demo",
            projectId: "project-1",
            provider: "demo",
            status: "connected",
            connectionType: "local_provider",
            credentialId: null,
            metadata: {
              attached: true,
              assistantHandles: ["demo"],
            },
            requiredScopes: [],
            capabilities: ["robot_embodiment"],
            createdBy: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
      upsertIntegration,
    );

    expect(result.success).toBe(true);
    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "demo",
      expect.objectContaining({
        status: "available",
        metadata: expect.objectContaining({
          attached: false,
          enabled: false,
        }),
      }),
    );
  });

  it("promotes another attached camera device when detaching the current preferred device", async () => {
    const upsertIntegration = vi.fn(async (_projectId: string, provider: string, params: { metadata?: Record<string, unknown>; status?: string }) => ({
      success: true,
      integration: {
        id: `integration-${provider}`,
        projectId: "project-1",
        provider,
        status: params.status ?? "available",
        connectionType: "native_runtime",
        credentialId: null,
        metadata: params.metadata ?? {},
        requiredScopes: [],
        capabilities: ["camera_observation"],
        createdBy: null,
        createdAt: "",
        updatedAt: "",
      },
    }));

    const result = await detachProjectProvider(
      {
        projectId: "project-1",
        providerId: "camera:android-test-device",
      },
      async () => ({
        success: true,
        integrations: [
          {
            id: "integration-camera-android",
            projectId: "project-1",
            provider: "camera:android-test-device",
            status: "attached",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              enabled: true,
              defaultForFamily: true,
              preferredProviderId: "camera:android-test-device",
              providerFamilySelection: {
                familyId: "camera",
                preferredProviderId: "camera:android-test-device",
                preferredDevice: {
                  transport: "native_camera",
                  identifier: "android-test-device",
                  address: "android-test-device",
                  name: "Pixel Test",
                  nativePlatform: "android",
                },
                updatedAt: "2026-04-04T10:00:00.000Z",
              },
              selectedDevice: {
                transport: "native_camera",
                identifier: "android-test-device",
                address: "android-test-device",
                name: "Pixel Test",
                nativePlatform: "android",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "",
            updatedAt: "2026-04-04T10:00:00.000Z",
          },
          {
            id: "integration-camera-ios",
            projectId: "project-1",
            provider: "camera:ios-remote-device",
            status: "attached",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              enabled: true,
              preferredProviderId: "camera:android-test-device",
              providerFamilySelection: {
                familyId: "camera",
                preferredProviderId: "camera:android-test-device",
                updatedAt: "2026-04-04T10:00:00.000Z",
              },
              selectedDevice: {
                transport: "native_camera",
                identifier: "ios-remote-device",
                address: "ios-remote-device",
                name: "Marcus iPhone",
                nativePlatform: "ios",
              },
            },
            requiredScopes: [],
            capabilities: ["camera_observation"],
            createdBy: null,
            createdAt: "",
            updatedAt: "2026-04-04T10:01:00.000Z",
          },
        ],
      }),
      upsertIntegration,
    );

    expect(result.success).toBe(true);
    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "camera:ios-remote-device",
      expect.objectContaining({
        metadata: expect.objectContaining({
          defaultForFamily: true,
          preferredProviderId: "camera:ios-remote-device",
          providerFamilySelection: expect.objectContaining({
            familyId: "camera",
            preferredProviderId: "camera:ios-remote-device",
            preferredDevice: expect.objectContaining({
              identifier: "ios-remote-device",
              name: "Marcus iPhone",
            }),
          }),
        }),
      }),
    );
    expect(upsertIntegration).toHaveBeenCalledWith(
      "project-1",
      "camera:android-test-device",
      expect.objectContaining({
        status: "available",
        metadata: expect.objectContaining({
          attached: false,
          enabled: false,
          defaultForFamily: false,
          preferredProviderId: "camera:ios-remote-device",
          providerFamilySelection: expect.objectContaining({
            familyId: "camera",
            preferredProviderId: "camera:ios-remote-device",
          }),
        }),
      }),
    );
  });

  it("reads a selected device from provider integration metadata", () => {
    const device = getProjectProviderSelectedDevice({
      id: "integration-demo",
      projectId: "project-1",
      provider: "demo",
      status: "connected",
      connectionType: "local_provider",
      credentialId: null,
      metadata: {
        attached: true,
        selectedDevice: {
          transport: "ble",
          identifier: "AA:BB:CC:DD:EE:FF",
          address: "AA:BB:CC:DD:EE:FF",
          name: "Demo V1",
          nativePlatform: "android",
          savedAt: "2026-03-29T10:00:00.000Z",
          lastConnectedAt: "2026-03-29T10:05:00.000Z",
        },
      },
      requiredScopes: [],
      capabilities: ["robot_embodiment"],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    });

    expect(device).toEqual({
      transport: "ble",
      identifier: "AA:BB:CC:DD:EE:FF",
      address: "AA:BB:CC:DD:EE:FF",
      name: "Demo V1",
      nativePlatform: "android",
      savedAt: "2026-03-29T10:00:00.000Z",
      lastConnectedAt: "2026-03-29T10:05:00.000Z",
    });
  });

  it("reads explicit provider family selection metadata", () => {
    const integration = {
      id: "integration-camera-ios",
      projectId: "project-1",
      provider: "camera:ios-remote-device",
      status: "attached",
      connectionType: "native_runtime",
      credentialId: null,
      metadata: {
        attached: true,
        providerFamilySelection: {
          familyId: "camera",
          preferredProviderId: "camera:ios-remote-device",
          preferredDevice: {
            transport: "native_camera",
            identifier: "ios-remote-device",
            address: "ios-remote-device",
            name: "Marcus iPhone",
            nativePlatform: "ios",
          },
          updatedAt: "2026-04-04T10:05:00.000Z",
        },
      },
      requiredScopes: [],
      capabilities: ["camera_observation"],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    };

    expect(getProjectProviderFamilyPreferredProviderId(integration)).toBe(
      "camera:ios-remote-device",
    );
    expect(getProjectProviderFamilySelection(integration)).toMatchObject({
      familyId: "camera",
      preferredProviderId: "camera:ios-remote-device",
      preferredDevice: {
        identifier: "ios-remote-device",
        name: "Marcus iPhone",
      },
      updatedAt: "2026-04-04T10:05:00.000Z",
    });
  });

  it("ignores an Android BLE address as a reusable saved device on iPhone", () => {
    getPlatformMock.mockReturnValue("ios");

    const device = getProjectProviderSelectedDevice({
      id: "integration-demo",
      projectId: "project-1",
      provider: "demo",
      status: "connected",
      connectionType: "local_provider",
      credentialId: null,
      metadata: {
        attached: true,
        selectedDevice: {
          transport: "ble",
          identifier: "AA:BB:CC:DD:EE:FF",
          address: "AA:BB:CC:DD:EE:FF",
          name: "Demo V1",
        },
      },
      requiredScopes: [],
      capabilities: ["robot_embodiment"],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    });

    expect(device).toBeNull();
  });

  it("prefers the platform-specific saved device when multiple phone entries exist", () => {
    getPlatformMock.mockReturnValue("ios");

    const device = getProjectProviderSelectedDevice({
      id: "integration-demo",
      projectId: "project-1",
      provider: "demo",
      status: "connected",
      connectionType: "local_provider",
      credentialId: null,
      metadata: {
        attached: true,
        selectedDevice: {
          transport: "ble",
          identifier: "AA:BB:CC:DD:EE:FF",
          address: "AA:BB:CC:DD:EE:FF",
          name: "Demo Android",
          nativePlatform: "android",
        },
        selectedDevices: {
          android: {
            transport: "ble",
            identifier: "AA:BB:CC:DD:EE:FF",
            address: "AA:BB:CC:DD:EE:FF",
            name: "Demo Android",
            nativePlatform: "android",
          },
          ios: {
            transport: "ble",
            identifier: "123E4567-E89B-12D3-A456-426614174000",
            address: "123E4567-E89B-12D3-A456-426614174000",
            name: "Demo iPhone",
            nativePlatform: "ios",
          },
        },
      },
      requiredScopes: [],
      capabilities: ["robot_embodiment"],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    });

    expect(device).toMatchObject({
      identifier: "123E4567-E89B-12D3-A456-426614174000",
      nativePlatform: "ios",
      name: "Demo iPhone",
    });
  });

  it("merges and clears selected device metadata", () => {
    getPlatformMock.mockReturnValue("android");

    const withDevice = withProjectProviderSelectedDevice(
      {
        attached: true,
        selectedDevice: {
          transport: "ble",
          identifier: "AA:BB:CC:DD:EE:FF",
          address: "AA:BB:CC:DD:EE:FF",
          name: "Old name",
          nativePlatform: "android",
          savedAt: "2026-03-29T10:00:00.000Z",
        },
      },
      {
        transport: "ble",
        identifier: "AA:BB:CC:DD:EE:FF",
        address: "AA:BB:CC:DD:EE:FF",
        name: "Demo V1",
        connectedAt: "2026-03-29T10:05:00.000Z",
      },
      "2026-03-29T10:05:00.000Z",
    );

    expect(withDevice).toMatchObject({
      attached: true,
      selectedDevice: {
        transport: "ble",
        identifier: "AA:BB:CC:DD:EE:FF",
        address: "AA:BB:CC:DD:EE:FF",
        name: "Demo V1",
        nativePlatform: "android",
        savedAt: "2026-03-29T10:00:00.000Z",
        lastConnectedAt: "2026-03-29T10:05:00.000Z",
      },
      selectedDevices: {
        android: {
          transport: "ble",
          identifier: "AA:BB:CC:DD:EE:FF",
          address: "AA:BB:CC:DD:EE:FF",
          name: "Demo V1",
          nativePlatform: "android",
          savedAt: "2026-03-29T10:00:00.000Z",
          lastConnectedAt: "2026-03-29T10:05:00.000Z",
        },
      },
    });

    expect(withoutProjectProviderSelectedDevice(withDevice)).toEqual({
      attached: true,
    });
  });

  it("exposes attached-state helpers for project integrations", () => {
    const integration = {
      id: "integration-demo",
      projectId: "project-1",
      provider: "demo",
      status: "connected",
      connectionType: "local_provider",
      credentialId: null,
      metadata: {
        attached: true,
        assistantHandles: ["demo", "octo"],
      },
      requiredScopes: [],
      capabilities: ["robot_embodiment"],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    };

    expect(isProjectIntegrationAttached(integration)).toBe(true);
    expect(listProjectIntegrationAssistantHandles(integration)).toEqual(["demo", "octo"]);
    expect(getProjectIntegrationByProvider([integration], "demo")?.id).toBe("integration-demo");
  });
});
