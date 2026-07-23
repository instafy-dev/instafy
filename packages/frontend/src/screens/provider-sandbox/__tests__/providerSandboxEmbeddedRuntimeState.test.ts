import { describe, expect, it } from "vitest";
import {
  createEmbeddedProviderSandboxRuntimeSnapshot,
  createEmbeddedProviderSandboxRuntimeState,
  resolveEmbeddedProviderSandboxRuntimeMessage,
} from "../providerSandboxEmbeddedRuntimeState";

describe("providerSandboxEmbeddedRuntimeState", () => {
  it("builds a grouped snapshot from runtime state and fallback route ids", () => {
    const snapshot = createEmbeddedProviderSandboxRuntimeSnapshot(
      {
        hostState: null,
        pendingInvalidatedResourceIds: ["attachment_status"],
      },
      {
        fallbackProviderId: "fallback-provider",
        fallbackSurfaceId: "fallback-surface",
      },
    );

    expect(snapshot.providerId).toBe("fallback-provider");
    expect(snapshot.surfaceId).toBe("fallback-surface");
    expect(snapshot.pendingInvalidatedResourceIds).toEqual(["attachment_status"]);
    expect(snapshot.hostData).toEqual({
      sections: [],
      resources: [],
    });
    expect(snapshot.hostMutations).toEqual({
      actions: [],
      controls: [],
    });
  });

  it("resolves runtime message state transitions through the shared helper", () => {
    const result = resolveEmbeddedProviderSandboxRuntimeMessage(
      {
        ...createEmbeddedProviderSandboxRuntimeState(),
        pendingInvalidatedResourceIds: ["attachment_status"],
      },
      new MessageEvent("message", {
        data: {
          type: "instafy:providerSandboxHostState",
          payload: {
            version: 1,
            stateToken: "state-1",
            providerId: "camera",
            providerTitle: "Camera",
            familyId: "camera",
            surfaceId: "detail_view",
            resolvedTheme: "dark",
            grantedCapabilities: ["host_sections"],
            hostSections: [
              {
                id: "runtime_status",
                title: "Runtime",
                items: ["Ready"],
              },
            ],
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([{ type: "apply_theme", theme: "dark" }]);
    expect(result.nextState.pendingInvalidatedResourceIds).toEqual([]);
    expect(result.nextState.hostState).toEqual(
      expect.objectContaining({
        providerId: "camera",
        surfaceId: "detail_view",
      }),
    );
  });
});
