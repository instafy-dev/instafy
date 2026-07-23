// @vitest-environment jsdom

import {
  createProviderUiSurfaceSandboxCapabilityProfile,
  createProviderUiSurfaceSandboxBridgeMessage,
  createProviderUiSurfaceSandboxHostResourceDeltaPayload,
  normalizeProviderUiSurfaceSandboxCapabilities,
  providerUiSurfaceSandboxHasCapability,
} from "@instafy/provider-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderSandboxHostStatePayload,
  postProviderSandboxHostResourceDelta,
  postProviderSandboxHostResourcesInvalidated,
  providerSandboxHostStateHasCapability,
  readProviderSandboxHostData,
  readProviderSandboxHostMutations,
  replaceProviderSandboxHostStateResources,
  requestProviderSandboxInvokeHostAction,
  requestProviderSandboxOpenExternal,
  requestProviderSandboxUpdateHostControl,
} from "../providerSandboxBridge";

describe("providerSandboxBridge protocol shaping", () => {
  it("normalizes sandbox bridge messages through the contract helper", () => {
    expect(
      createProviderUiSurfaceSandboxBridgeMessage({
        type: "instafy:providerSandboxOpenExternal",
        url: "  https://example.com/docs  ",
      }),
    ).toEqual({
      type: "instafy:providerSandboxOpenExternal",
      url: "https://example.com/docs",
    });

    expect(
      createProviderUiSurfaceSandboxBridgeMessage({
        type: "instafy:providerSandboxInvokeHostAction",
        payload: { actionId: "   " },
      }),
    ).toBeUndefined();

    expect(
      createProviderUiSurfaceSandboxHostResourceDeltaPayload({
        resources: [
          {
            id: " attachment_status ",
            title: " Current attachment ",
            facts: [{ label: "Status", value: "Attached" }],
          },
          {
            id: "   ",
            title: "Invalid",
          },
        ],
        removedResourceIds: [" gone ", "gone", "  "],
      }),
    ).toEqual({
      resources: [
        {
          id: "attachment_status",
          title: "Current attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      ],
      removedResourceIds: ["gone"],
    });
  });

  it("centralizes sandbox capability normalization and semantics in the contract layer", () => {
    const normalizedCapabilities = normalizeProviderUiSurfaceSandboxCapabilities([
      "resize",
      "host_resources",
      "invalid",
      "host_resource_deltas",
    ]);

    expect(normalizedCapabilities).toEqual(["resize", "host_resources", "host_resource_deltas"]);

    expect(
      createProviderUiSurfaceSandboxCapabilityProfile([
        "host_actions",
        "host_resources",
        "host_resource_deltas",
      ]),
    ).toEqual({
      capabilities: ["host_actions", "host_resources", "host_resource_deltas"],
      canResize: false,
      canOpenExternal: false,
      canInvokeHostActions: true,
      canUpdateHostControls: false,
      canReadHostSections: false,
      canReadHostResources: true,
      canReadHostData: true,
      canMutateHost: true,
      supportsHostResourceDeltas: true,
    });

    expect(providerUiSurfaceSandboxHasCapability(["host_controls"], "host_controls")).toBe(true);
    expect(
      providerSandboxHostStateHasCapability(
        { grantedCapabilities: ["host_controls"] },
        "host_controls",
      ),
    ).toBe(true);
  });

  it("posts sanitized messages from the embedded sandbox helpers", () => {
    const parentPostMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: {
        postMessage: parentPostMessage,
      },
    });
    window.history.replaceState({}, "", "/provider-sandbox?mode=provider-sandbox");

    expect(requestProviderSandboxOpenExternal("  https://example.com/docs  ")).toBe(true);
    expect(requestProviderSandboxInvokeHostAction("  refresh  ")).toBe(true);
    expect(requestProviderSandboxUpdateHostControl(" power ", true)).toBe(true);

    expect(parentPostMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "instafy:providerSandboxOpenExternal",
        url: "https://example.com/docs",
      },
      "*",
    );
    expect(parentPostMessage).toHaveBeenNthCalledWith(
      2,
      {
        type: "instafy:providerSandboxInvokeHostAction",
        payload: { actionId: "refresh" },
      },
      "*",
    );
    expect(parentPostMessage).toHaveBeenNthCalledWith(
      3,
      {
        type: "instafy:providerSandboxUpdateHostControl",
        payload: { controlId: "power", value: true },
      },
      "*",
    );
  });

  it("posts sanitized host-side resource bridge messages", () => {
    const targetWindow = {
      postMessage: vi.fn(),
    };

    expect(
      postProviderSandboxHostResourcesInvalidated(targetWindow, {
        resourceIds: [" attachment_status ", "attachment_status", "  "],
        stateToken: "  token-1  ",
      }),
    ).toBe(true);
    expect(
      postProviderSandboxHostResourceDelta(targetWindow, {
        resources: [
          {
            id: " attachment_status ",
            title: " Current attachment ",
            facts: [{ label: "Status", value: "Waiting" }],
          },
        ],
        removedResourceIds: [" old_status ", "old_status"],
        stateToken: "  token-2  ",
      }),
    ).toBe(true);

    expect(targetWindow.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "instafy:providerSandboxHostResourcesInvalidated",
        payload: {
          resourceIds: ["attachment_status"],
          stateToken: "token-1",
        },
      },
      "*",
    );
    expect(targetWindow.postMessage).toHaveBeenNthCalledWith(
      2,
      {
        type: "instafy:providerSandboxHostResourceDelta",
        payload: {
          resources: [
            {
              id: "attachment_status",
              title: "Current attachment",
              facts: [{ label: "Status", value: "Waiting" }],
            },
          ],
          removedResourceIds: ["old_status"],
          stateToken: "token-2",
        },
      },
      "*",
    );
  });

  it("projects grouped host data and host mutations from host state payloads", () => {
    expect(
      readProviderSandboxHostData({
        hostSections: [
          {
            id: "runtime_status",
            title: "Runtime",
            items: ["Ready"],
          },
        ],
        hostResources: [
          {
            id: "attachment_status",
            title: "Attachment",
            facts: [{ label: "Status", value: "Attached" }],
          },
        ],
      }),
    ).toEqual({
      sections: [
        {
          id: "runtime_status",
          title: "Runtime",
          items: ["Ready"],
        },
      ],
      resources: [
        {
          id: "attachment_status",
          title: "Attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      ],
    });

    expect(
      readProviderSandboxHostMutations({
        hostActions: [{ id: "refresh", label: "Refresh" }],
        hostControls: [
          {
            id: "power",
            kind: "toggle",
            label: "Power",
            value: true,
          },
        ],
      }),
    ).toEqual({
      actions: [{ id: "refresh", label: "Refresh" }],
      controls: [
        {
          id: "power",
          kind: "toggle",
          label: "Power",
          value: true,
        },
      ],
    });

    expect(readProviderSandboxHostData(null)).toEqual({
      sections: [],
      resources: [],
    });
    expect(readProviderSandboxHostMutations(undefined)).toEqual({
      actions: [],
      controls: [],
    });
  });

  it("creates and rewrites host-state payloads from grouped host data and mutations", () => {
    const hostState = createProviderSandboxHostStatePayload({
      stateToken: " token-1 ",
      providerId: "camera",
      providerTitle: "Camera",
      familyId: "camera",
      surfaceId: "detail_view",
      resolvedTheme: "dark",
      grantedCapabilities: ["host_actions", "host_resources"],
      hostData: {
        sections: [
          {
            id: "runtime_status",
            title: "Runtime",
            items: ["Ready"],
          },
        ],
        resources: [
          {
            id: "attachment_status",
            title: "Attachment",
            facts: [{ label: "Status", value: "Attached" }],
          },
        ],
      },
      hostMutations: {
        actions: [{ id: "refresh", label: "Refresh" }],
        controls: [],
      },
    });

    expect(hostState).toEqual({
      version: 1,
      stateToken: "token-1",
      providerId: "camera",
      providerTitle: "Camera",
      familyId: "camera",
      surfaceId: "detail_view",
      resolvedTheme: "dark",
      grantedCapabilities: ["host_actions", "host_resources"],
      hostActions: [{ id: "refresh", label: "Refresh" }],
      hostSections: [
        {
          id: "runtime_status",
          title: "Runtime",
          items: ["Ready"],
        },
      ],
      hostResources: [
        {
          id: "attachment_status",
          title: "Attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      ],
    });

    expect(
      replaceProviderSandboxHostStateResources(
        hostState,
        [
          {
            id: "attachment_status",
            title: "Attachment",
            facts: [{ label: "Status", value: "Waiting" }],
          },
        ],
        { stateToken: "token-2" },
      ),
    ).toEqual({
      ...hostState,
      stateToken: "token-2",
      hostResources: [
        {
          id: "attachment_status",
          title: "Attachment",
          facts: [{ label: "Status", value: "Waiting" }],
        },
      ],
    });

    expect(replaceProviderSandboxHostStateResources(hostState, [])).toEqual({
      version: 1,
      stateToken: "token-1",
      providerId: "camera",
      providerTitle: "Camera",
      familyId: "camera",
      surfaceId: "detail_view",
      resolvedTheme: "dark",
      grantedCapabilities: ["host_actions", "host_resources"],
      hostActions: [{ id: "refresh", label: "Refresh" }],
      hostSections: [
        {
          id: "runtime_status",
          title: "Runtime",
          items: ["Ready"],
        },
      ],
    });
  });
});
