import { describe, expect, it } from "vitest";
import {
  createProviderUiSurfaceActions,
  createProviderUiSurfaceControls,
  createProviderUiSurfaceElements,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfaceSection,
} from "@instafy/provider-contract";
import type { ProviderHostSurfaceEntry } from "../../../../providers/providerHostSurfaceTypes";
import {
  buildProviderHostSurfaceSandboxResourceDelta,
  buildProviderHostSurfaceSandboxState,
} from "../providerHostSurfaceSandboxState";

const TEST_ENTRY: ProviderHostSurfaceEntry = {
  familyId: "test-family",
  provider: {
    id: "test-provider",
    title: "Test Provider",
    manifest: undefined,
  },
  surface: {
    surface: "detail_view",
    metadata: createProviderUiSurfaceMetadata({
      elements: createProviderUiSurfaceElements([
        createProviderUiSurfaceActions([
          {
            label: "Attach",
            binding: { hostBindingId: "extension_attachment_action" },
          },
        ]),
        createProviderUiSurfaceControls([
          {
            kind: "toggle",
            label: "Power",
            binding: { hostBindingId: "power_state" },
          },
        ]),
        createProviderUiSurfaceSection({
          title: "Status",
          binding: { hostBindingId: "attachment_status" },
        }),
      ]),
    }),
  },
};

describe("providerHostSurfaceSandboxState", () => {
  it("builds host state from declared bindings and sandbox capabilities", () => {
    const projection = buildProviderHostSurfaceSandboxState({
      entry: TEST_ENTRY,
      resolvedTheme: "light",
      sandbox: {
        kind: "iframe",
        src: "/provider-sandbox/test-provider/detail_view",
        capabilities: ["host_actions", "host_controls", "host_sections", "host_resources"],
        resources: [
          {
            id: "attachment_resource",
            title: "Attachment",
            binding: { hostBindingId: "attachment_status" },
          },
        ],
      },
      hostActionBindings: {
        extension_attachment_action: {
          label: "Attach now",
          onPress: () => {},
        },
      },
      hostControlBindings: {
        power_state: {
          value: true,
          onChange: () => {},
        },
      },
      hostSectionBindings: {
        attachment_status: {
          title: "Attachment",
          facts: [{ label: "Status", value: "Attached" }],
        },
      },
    });

    expect(projection.hostState.hostActions).toEqual([
      expect.objectContaining({
        id: "extension_attachment_action",
        label: "Attach now",
        disabled: false,
      }),
    ]);
    expect(projection.hostMutations.actions).toEqual([
      expect.objectContaining({
        id: "extension_attachment_action",
        label: "Attach now",
        disabled: false,
      }),
    ]);
    expect(projection.hostState.hostControls).toEqual([
      expect.objectContaining({
        id: "power_state",
        kind: "toggle",
        value: true,
      }),
    ]);
    expect(projection.hostMutations.controls).toEqual([
      expect.objectContaining({
        id: "power_state",
        kind: "toggle",
        value: true,
      }),
    ]);
    expect(projection.hostState.hostSections).toEqual([
      expect.objectContaining({
        id: "attachment_status",
        title: "Attachment",
      }),
    ]);
    expect(projection.hostData.sections).toEqual([
      expect.objectContaining({
        id: "attachment_status",
        title: "Attachment",
      }),
    ]);
    expect(projection.hostState.hostResources).toEqual([
      expect.objectContaining({
        id: "attachment_resource",
        title: "Attachment",
      }),
    ]);
    expect(projection.hostData.resources).toEqual([
      expect.objectContaining({
        id: "attachment_resource",
        title: "Attachment",
      }),
    ]);
  });

  it("computes changed and removed host resources", () => {
    const delta = buildProviderHostSurfaceSandboxResourceDelta(
      [
        { id: "one", title: "One", facts: [{ label: "Status", value: "Old" }] },
        { id: "two", title: "Two", facts: [{ label: "Status", value: "Keep" }] },
      ],
      [
        { id: "one", title: "One", facts: [{ label: "Status", value: "New" }] },
        { id: "three", title: "Three", facts: [{ label: "Status", value: "Added" }] },
      ],
    );

    expect(delta.resources).toEqual([
      expect.objectContaining({ id: "one" }),
      expect.objectContaining({ id: "three" }),
    ]);
    expect(delta.removedResourceIds).toEqual(["two"]);
  });
});
