import { describe, expect, it, vi } from "vitest";
import { handleProviderHostSurfaceSandboxMessage } from "../providerHostSurfaceSandboxMessages";
import type { ProviderSandboxHostStatePayload } from "../../../../utils/providerSandboxBridge";
import type { ProviderHostSurfaceSandboxStateProjection } from "../providerHostSurfaceSandboxState";

const TARGET_WINDOW = { postMessage: vi.fn() } as unknown as Window;

function createSandboxMessageEvent(
  data: unknown,
  source: Window | null = TARGET_WINDOW,
) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", {
    configurable: true,
    value: source,
  });
  return event;
}

function createHostState(
  overrides: Partial<ProviderSandboxHostStatePayload> = {},
): ProviderSandboxHostStatePayload {
  return {
    version: 1,
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
    hostPushSnapshot: "push-snapshot",
    hostResourceSnapshot: "resource-snapshot",
    hostStateToken: hostState.stateToken ?? "state-token",
    hostState,
  };
}

describe("providerHostSurfaceSandboxMessages", () => {
  it("routes resize and openExternal only when those capabilities are granted", () => {
    const setIframeHeight = vi.fn();
    const openExternal = vi.fn();
    const hostState = createHostState({
      grantedCapabilities: ["resize", "open_external"],
    });

    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent({
          type: "instafy:providerSandboxResize",
          payload: { height: 512 },
        }),
        targetWindow: TARGET_WINDOW,
        projection: createProjection(hostState),
        setIframeHeight,
        openExternal,
      }),
    ).toBe(true);
    expect(setIframeHeight).toHaveBeenCalledWith(512);

    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent({
          type: "instafy:providerSandboxOpenExternal",
          url: "https://example.com/docs",
        }),
        targetWindow: TARGET_WINDOW,
        projection: createProjection(hostState),
        setIframeHeight,
        openExternal,
      }),
    ).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("routes host actions and controls through declared bindings only", async () => {
    const onPress = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn().mockResolvedValue(undefined);
    const hostState = createHostState({
      grantedCapabilities: ["host_actions", "host_controls"],
      hostActions: [{ id: "refresh", label: "Refresh", disabled: false }],
      hostControls: [{ id: "power", kind: "toggle", label: "Power", value: false }],
    });

    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent({
          type: "instafy:providerSandboxInvokeHostAction",
          payload: { actionId: "refresh" },
        }),
        targetWindow: TARGET_WINDOW,
        projection: createProjection(hostState),
        hostActionBindings: {
          refresh: { label: "Refresh", onPress },
        },
        setIframeHeight: vi.fn(),
        openExternal: vi.fn(),
      }),
    ).toBe(true);

    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent({
          type: "instafy:providerSandboxUpdateHostControl",
          payload: { controlId: "power", value: true },
        }),
        targetWindow: TARGET_WINDOW,
        projection: createProjection(hostState),
        hostControlBindings: {
          power: { value: false, onChange },
        },
        setIframeHeight: vi.fn(),
        openExternal: vi.fn(),
      }),
    ).toBe(true);

    await Promise.resolve();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("ignores messages from other sources and unknown message shapes", () => {
    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent(
          { type: "instafy:providerSandboxResize", payload: { height: 500 } },
          { postMessage: vi.fn() } as unknown as Window,
        ),
        targetWindow: TARGET_WINDOW,
        projection: createProjection({ grantedCapabilities: ["resize"] }),
        setIframeHeight: vi.fn(),
        openExternal: vi.fn(),
      }),
    ).toBe(false);

    expect(
      handleProviderHostSurfaceSandboxMessage({
        event: createSandboxMessageEvent("not-an-object"),
        targetWindow: TARGET_WINDOW,
        projection: createProjection(),
        setIframeHeight: vi.fn(),
        openExternal: vi.fn(),
      }),
    ).toBe(false);
  });
});
