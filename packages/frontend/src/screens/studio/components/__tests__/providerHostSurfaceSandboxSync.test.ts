import { describe, expect, it } from "vitest";
import type { ProviderSandboxHostStatePayload } from "../../../../utils/providerSandboxBridge";
import type { ProviderHostSurfaceSandboxStateProjection } from "../providerHostSurfaceSandboxState";
import {
  resolveProviderHostSurfaceSandboxHostStateSync,
  resolveProviderHostSurfaceSandboxResourceSync,
} from "../providerHostSurfaceSandboxSync";

function createHostState(
  overrides: Partial<ProviderSandboxHostStatePayload> = {},
): ProviderSandboxHostStatePayload {
  return {
    version: 1,
    stateToken: "token-1",
    providerId: "simulated-devices",
    providerTitle: "Simulated Devices",
    familyId: "simulated-devices",
    surfaceId: "detail_view",
    resolvedTheme: "light",
    grantedCapabilities: [],
    ...overrides,
  };
}

function createProjection(
  overrides: Partial<ProviderSandboxHostStatePayload> = {},
): ProviderHostSurfaceSandboxStateProjection {
  const hostState = createHostState(overrides);
  return {
    hostData: {
      sections: hostState.hostSections ?? [],
      resources: hostState.hostResources ?? [],
    },
    hostMutations: {
      actions: hostState.hostActions ?? [],
      controls: hostState.hostControls ?? [],
    },
    hostPushSnapshot: "snapshot-a",
    hostResourceSnapshot: "resource-snapshot-a",
    hostStateToken: hostState.stateToken ?? "token-1",
    hostState,
  };
}

describe("providerHostSurfaceSandboxSync", () => {
  it("posts host state only after the iframe is loaded and the snapshot changed", () => {
    const hostState = createHostState();
    expect(
      resolveProviderHostSurfaceSandboxHostStateSync({
        iframeLoaded: false,
        targetWindow: {} as Window,
        previousSnapshot: null,
        projection: {
          ...createProjection(hostState),
          hostPushSnapshot: "snapshot-a",
        },
      }),
    ).toEqual({
      nextSnapshot: "snapshot-a",
      action: null,
    });

    expect(
      resolveProviderHostSurfaceSandboxHostStateSync({
        iframeLoaded: true,
        targetWindow: {} as Window,
        previousSnapshot: "snapshot-a",
        projection: {
          ...createProjection(hostState),
          hostPushSnapshot: "snapshot-b",
        },
      }),
    ).toEqual({
      nextSnapshot: "snapshot-b",
      action: {
        kind: "post_host_state",
        hostState,
      },
    });
  });

  it("chooses resource deltas when supported and invalidations otherwise", () => {
    const hostResources = [
      { id: "attachment_status", title: "Attachment", facts: [{ label: "Status", value: "New" }] },
    ];
    const baseInput = {
      iframeLoaded: true,
      targetWindow: {} as Window,
      previousSnapshot: "snapshot-a",
      previousResources: [
        { id: "attachment_status", title: "Attachment", facts: [{ label: "Status", value: "Old" }] },
      ],
    };

    expect(
      resolveProviderHostSurfaceSandboxResourceSync({
        ...baseInput,
        projection: {
          ...createProjection({
            stateToken: "token-delta",
            grantedCapabilities: ["host_resources", "host_resource_deltas"],
            hostResources,
          }),
          hostResourceSnapshot: "snapshot-b",
        },
      }),
    ).toEqual({
      nextSnapshot: "snapshot-b",
      nextResources: hostResources,
      action: {
        kind: "post_host_resource_delta",
        resources: hostResources,
        removedResourceIds: [],
        stateToken: "token-delta",
      },
    });

    expect(
      resolveProviderHostSurfaceSandboxResourceSync({
        ...baseInput,
        projection: {
          ...createProjection({
            stateToken: "token-invalidations",
            grantedCapabilities: ["host_resources"],
            hostResources,
          }),
          hostResourceSnapshot: "snapshot-b",
        },
      }),
    ).toEqual({
      nextSnapshot: "snapshot-b",
      nextResources: hostResources,
      action: {
        kind: "post_host_resource_invalidations",
        resourceIds: ["attachment_status"],
        stateToken: "token-invalidations",
      },
    });
  });
});
