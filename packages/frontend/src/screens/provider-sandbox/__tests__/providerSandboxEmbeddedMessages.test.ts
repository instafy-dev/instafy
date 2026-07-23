import { describe, expect, it } from "vitest";
import { resolveEmbeddedProviderSandboxMessage } from "../providerSandboxEmbeddedMessages";

describe("providerSandboxEmbeddedMessages", () => {
  it("applies host state payloads and clears pending invalidations", () => {
    const result = resolveEmbeddedProviderSandboxMessage(
      {
        hostState: null,
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
                id: "extension_runtime_status",
                title: "Current runtime",
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
        resolvedTheme: "dark",
      }),
    );
  });

  it("merges resource deltas into the current host state and clears resolved invalidations", () => {
    const result = resolveEmbeddedProviderSandboxMessage(
      {
        hostState: {
          version: 1,
          stateToken: "state-1",
          providerId: "camera",
          providerTitle: "Camera",
          familyId: "camera",
          surfaceId: "detail_view",
          resolvedTheme: "light",
          grantedCapabilities: ["host_resources", "host_resource_deltas"],
          hostResources: [
            {
              id: "attachment_status",
              title: "Attachment",
              facts: [{ label: "Status", value: "Attached" }],
            },
          ],
        },
        pendingInvalidatedResourceIds: ["attachment_status", "runtime_status"],
      },
      new MessageEvent("message", {
        data: {
          type: "instafy:providerSandboxHostResourceDelta",
          payload: {
            stateToken: "state-2",
            resources: [
              {
                id: "attachment_status",
                title: "Attachment",
                facts: [{ label: "Status", value: "Waiting" }],
              },
            ],
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([]);
    expect(result.nextState.pendingInvalidatedResourceIds).toEqual(["runtime_status"]);
    expect(result.nextState.hostState).toEqual(
      expect.objectContaining({
        stateToken: "state-2",
        hostResources: [
          {
            id: "attachment_status",
            title: "Attachment",
            facts: [{ label: "Status", value: "Waiting" }],
          },
        ],
      }),
    );
  });

  it("requests a full host-state refresh when a delta arrives before the initial state", () => {
    const result = resolveEmbeddedProviderSandboxMessage(
      {
        hostState: null,
        pendingInvalidatedResourceIds: [],
      },
      new MessageEvent("message", {
        data: {
          type: "instafy:providerSandboxHostResourceDelta",
          payload: {
            resources: [
              {
                id: "attachment_status",
                title: "Attachment",
                facts: [{ label: "Status", value: "Waiting" }],
              },
            ],
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([{ type: "request_host_state" }]);
    expect(result.nextState.hostState).toBeNull();
    expect(result.nextState.pendingInvalidatedResourceIds).toEqual([]);
  });

  it("tracks invalidated resources and requests a refresh", () => {
    const result = resolveEmbeddedProviderSandboxMessage(
      {
        hostState: null,
        pendingInvalidatedResourceIds: ["attachment_status"],
      },
      new MessageEvent("message", {
        data: {
          type: "instafy:providerSandboxHostResourcesInvalidated",
          payload: {
            resourceIds: ["runtime_status", "attachment_status"],
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.effects).toEqual([{ type: "request_host_state" }]);
    expect(result.nextState.pendingInvalidatedResourceIds).toEqual([
      "attachment_status",
      "runtime_status",
    ]);
  });
});
