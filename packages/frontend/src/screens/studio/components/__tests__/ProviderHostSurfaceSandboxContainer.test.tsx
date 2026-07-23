// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderSummary,
  createProviderUiSurfaceActions,
  createProviderUiSurfaceControls,
  createProviderUiSurfaceElements,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfacePolicy,
  createProviderUiSurfaceSandboxContainer,
} from "@instafy/provider-contract";
import type { ProviderHostSurfaceEntry } from "../../../../providers/providerHostSurfaces";
import { ProviderHostSurfaceSandboxContainer } from "../ProviderHostSurfaceSandboxContainer";

function createEntry(): ProviderHostSurfaceEntry {
  const provider = createProviderSummary({
    id: "simulated-devices",
    title: "Simulated devices",
    capabilityIds: ["device_toggle"],
    manifest: {
      familyId: "simulated-devices",
      hostSurfaces: [
        {
          surface: "settings_card",
          title: "Simulated device controls",
          metadata: createProviderUiSurfaceMetadata({
            policy: createProviderUiSurfacePolicy({
              trustLevel: "local_trusted",
              renderMode: "sandboxed",
            }),
            sandbox: createProviderUiSurfaceSandboxContainer({
              kind: "iframe",
              src: "/provider-sandbox/simulated-devices/settings_card",
              title: "Simulated devices sandbox",
              capabilities: ["resize", "open_external"],
            }),
          }),
        },
      ],
    },
  });

  return {
    provider,
    familyId: "simulated-devices",
    surface: provider.manifest?.hostSurfaces?.[0] as ProviderHostSurfaceEntry["surface"],
  };
}

describe("ProviderHostSurfaceSandboxContainer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("sends host state to the iframe and handles resize/openExternal bridge messages", async () => {
    const entry = createEntry();
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await act(async () => {
      root.render(<ProviderHostSurfaceSandboxContainer entry={entry} />);
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostState",
          payload: expect.objectContaining({
            version: 1,
            providerId: "simulated-devices",
            surfaceId: "settings_card",
            resolvedTheme: "light",
            grantedCapabilities: ["resize", "open_external"],
          }),
        }),
      "*",
    );
    expect(iframe?.getAttribute("src")).toContain("mode=provider-sandbox");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxResize",
            payload: { height: 480 },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(iframe?.style.height).toBe("480px");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxOpenExternal",
            url: "https://example.com/providers/simulated-devices",
          },
        }),
      );
      await Promise.resolve();
    });

    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/providers/simulated-devices",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("resends host state when the sandbox explicitly requests a refresh", async () => {
    const entry = createEntry();
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;

    await act(async () => {
      root.render(<ProviderHostSurfaceSandboxContainer entry={entry} />);
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    postMessage.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxRequestHostState",
          },
        }),
      );
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostState",
        payload: expect.objectContaining({
          version: 1,
          providerId: "simulated-devices",
          surfaceId: "settings_card",
          stateToken: expect.any(String),
        }),
      }),
      "*",
    );
  });

  it("ignores bridge requests for capabilities the sandbox surface did not declare", async () => {
    const entry = createEntry();
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/settings_card",
        title: "Simulated devices sandbox",
        capabilities: ["resize"],
      }),
    });
    const iframeWindow = { postMessage: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await act(async () => {
      root.render(<ProviderHostSurfaceSandboxContainer entry={entry} />);
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxOpenExternal",
            url: "https://example.com/providers/simulated-devices",
          },
        }),
      );
      await Promise.resolve();
    });

    expect(openSpy).not.toHaveBeenCalled();
  });

  it("invokes only declared host actions when the sandbox surface has the host_actions capability", async () => {
    const entry = createEntry();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/settings_card",
        title: "Simulated devices sandbox",
        capabilities: ["host_actions"],
      }),
      elements: createProviderUiSurfaceElements([
        createProviderUiSurfaceActions([
          {
            label: "Refresh host",
            variant: "outline",
            binding: {
              hostBindingId: "simulated_refresh",
            },
          },
        ]),
      ]),
    });

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostActionBindings={{
            simulated_refresh: {
              label: "Refresh host",
              onPress: onRefresh,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(onRefresh).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostState",
        payload: expect.objectContaining({
          grantedCapabilities: ["host_actions"],
          hostActions: [
            expect.objectContaining({
              id: "simulated_refresh",
              label: "Refresh host",
              disabled: false,
            }),
          ],
        }),
      }),
      "*",
    );

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxInvokeHostAction",
            payload: {
              actionId: "simulated_refresh",
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("invokes only declared host controls when the sandbox surface has the host_controls capability", async () => {
    const entry = createEntry();
    const onChange = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/settings_card",
        title: "Simulated devices sandbox",
        capabilities: ["host_controls"],
      }),
      elements: createProviderUiSurfaceElements([
        createProviderUiSurfaceControls([
          {
            kind: "toggle",
            label: "Desk lamp power",
            description: "Toggle the simulated desk lamp.",
            binding: {
              hostBindingId: "simulated_device_power_state",
            },
          },
        ]),
      ]),
    });

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostControlBindings={{
            simulated_device_power_state: {
              value: false,
              description: "Toggle the simulated desk lamp.",
              onChange,
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostState",
        payload: expect.objectContaining({
          grantedCapabilities: ["host_controls"],
          hostControls: [
            expect.objectContaining({
              id: "simulated_device_power_state",
              kind: "toggle",
              label: "Desk lamp power",
              value: false,
            }),
          ],
        }),
      }),
      "*",
    );

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframeWindow,
          data: {
            type: "instafy:providerSandboxUpdateHostControl",
            payload: {
              controlId: "simulated_device_power_state",
              value: true,
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("posts only declared host resources when the sandbox surface has the host_resources capability", async () => {
    const entry = createEntry();
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/detail_view",
        title: "Simulated devices sandbox",
        capabilities: ["host_resources"],
        resources: [
          {
            id: "attachment_status",
            title: "Current attachment",
            binding: {
              hostBindingId: "extension_attachment_status",
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostSectionBindings={{
            extension_attachment_status: {
              facts: [
                {
                  label: "Status",
                  value: "Attached to this space",
                },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostState",
        payload: expect.objectContaining({
          grantedCapabilities: ["host_resources"],
          hostResources: [
            expect.objectContaining({
              id: "attachment_status",
              title: "Current attachment",
              facts: [
                expect.objectContaining({
                  label: "Status",
                  value: "Attached to this space",
                }),
              ],
            }),
          ],
        }),
      }),
      "*",
    );
  });

  it("posts host resource invalidations instead of a full host-state refresh for resource-only updates", async () => {
    const entry = createEntry();
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/detail_view",
        title: "Simulated devices sandbox",
        capabilities: ["host_resources"],
        resources: [
          {
            id: "attachment_status",
            title: "Current attachment",
            binding: {
              hostBindingId: "extension_attachment_status",
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostSectionBindings={{
            extension_attachment_status: {
              facts: [
                {
                  label: "Status",
                  value: "Attached to this space",
                },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    postMessage.mockClear();

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostSectionBindings={{
            extension_attachment_status: {
              facts: [
                {
                  label: "Status",
                  value: "Waiting for attachment",
                },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostResourcesInvalidated",
        payload: expect.objectContaining({
          resourceIds: ["attachment_status"],
          stateToken: expect.any(String),
        }),
      }),
      "*",
    );
    expect(
      postMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "instafy:providerSandboxHostState",
      ),
    ).toBe(false);
  });

  it("posts typed host resource deltas when the sandbox surface opts into host_resource_deltas", async () => {
    const entry = createEntry();
    const postMessage = vi.fn();
    const iframeWindow = { postMessage } as unknown as Window;
    entry.surface.metadata = createProviderUiSurfaceMetadata({
      policy: createProviderUiSurfacePolicy({
        trustLevel: "local_trusted",
        renderMode: "sandboxed",
      }),
      sandbox: createProviderUiSurfaceSandboxContainer({
        kind: "iframe",
        src: "/provider-sandbox/simulated-devices/detail_view",
        title: "Simulated devices sandbox",
        capabilities: ["host_resources", "host_resource_deltas"],
        resources: [
          {
            id: "attachment_status",
            title: "Current attachment",
            binding: {
              hostBindingId: "extension_attachment_status",
            },
          },
        ],
      }),
    });

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostSectionBindings={{
            extension_attachment_status: {
              facts: [
                {
                  label: "Status",
                  value: "Attached to this space",
                },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    const iframe = container.querySelector(
      '[data-testid="provider-host-sandbox-frame-simulated-devices"]',
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: iframeWindow,
    });

    await act(async () => {
      iframe?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    postMessage.mockClear();

    await act(async () => {
      root.render(
        <ProviderHostSurfaceSandboxContainer
          entry={entry}
          hostSectionBindings={{
            extension_attachment_status: {
              facts: [
                {
                  label: "Status",
                  value: "Waiting for attachment",
                },
              ],
            },
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "instafy:providerSandboxHostResourceDelta",
        payload: expect.objectContaining({
          resources: [
            expect.objectContaining({
              id: "attachment_status",
              facts: [
                expect.objectContaining({
                  label: "Status",
                  value: "Waiting for attachment",
                }),
              ],
            }),
          ],
          stateToken: expect.any(String),
        }),
      }),
      "*",
    );
    expect(
      postMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "instafy:providerSandboxHostState",
      ),
    ).toBe(false);
  });
});
