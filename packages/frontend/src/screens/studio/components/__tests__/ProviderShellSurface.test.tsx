import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderSummary,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfacePolicy,
  createProviderUiSurfaceSandboxContainer,
} from "@instafy/provider-contract";
import type { ProviderHostSurfaceEntry } from "../../../../providers/providerHostSurfaces";
import { ProviderShellSurface } from "../ProviderShellSurface";

function createEntry(
  metadata: Record<string, unknown> | undefined,
  overrides: Partial<ProviderHostSurfaceEntry["surface"]> = {},
): ProviderHostSurfaceEntry {
  const provider = createProviderSummary({
    id: "camera:pixel-test",
    title: "Kitchen camera",
    capabilityIds: ["camera_observation"],
    manifest: {
      familyId: "camera",
      hostSurfaces: [
        {
          surface: "detail_view",
          title: "Kitchen camera details",
          metadata,
          ...overrides,
        },
      ],
    },
  });

  return {
    provider,
    familyId: "camera",
    surface: provider.manifest?.hostSurfaces?.[0] as ProviderHostSurfaceEntry["surface"],
  };
}

describe("ProviderShellSurface", () => {
  it("renders the shared host card for non-sandboxed surfaces", () => {
    const entry = createEntry({
      policy: {
        trustLevel: "first_party",
        renderMode: "host_declarative",
      },
      elements: [
        {
          element: "actions",
          actions: [
            {
              label: "Attachment",
              variant: "outline",
              binding: {
                hostBindingId: "extension_attachment_action",
              },
            },
          ],
        },
      ],
    });

    const html = renderToStaticMarkup(
      <ProviderShellSurface
        entry={entry}
        hostActionBindings={{
          extension_attachment_action: {
            label: "Attach to this space",
            onPress: vi.fn(),
          },
        }}
      />,
    );

    expect(html).toContain("Kitchen camera details");
    expect(html).toContain("Attach to this space");
    expect(html).not.toContain("isolated provider UI container");
  });

  it("renders embedded host content without repeating the surface header", () => {
    const entry = createEntry({
      policy: {
        trustLevel: "first_party",
        renderMode: "host_declarative",
      },
      elements: [
        {
          element: "controls",
          controls: [
            {
              kind: "readonly",
              label: "Attachment",
              value: "Attached",
            },
          ],
        },
      ],
    });

    const html = renderToStaticMarkup(
      <ProviderShellSurface
        entry={entry}
        presentation="embedded"
      />,
    );

    expect(html).toContain("Attachment");
    expect(html).toContain("Attached");
    expect(html).not.toContain("Kitchen camera details");
  });

  it("renders an isolated iframe container for sandboxed surfaces with a container descriptor", () => {
    const entry = createEntry(
      createProviderUiSurfaceMetadata({
        policy: createProviderUiSurfacePolicy({
          trustLevel: "untrusted",
          renderMode: "sandboxed",
        }),
        sandbox: createProviderUiSurfaceSandboxContainer({
          kind: "iframe",
          src: "https://providers.instafy.dev/camera/surface",
          title: "Kitchen camera sandbox",
          allow: "camera; microphone",
        }),
      }),
    );

    const html = renderToStaticMarkup(<ProviderShellSurface entry={entry} />);

    expect(html).toContain("Kitchen camera sandbox");
    expect(html).toContain("iframe");
    expect(html).toContain("https://providers.instafy.dev/camera/surface");
    expect(html).toContain("isolated iframe container");
    expect(html).toContain("sandboxed");
  });

  it("falls back to the policy notice for sandboxed surfaces without a container descriptor", () => {
    const entry = createEntry(
      createProviderUiSurfaceMetadata({
        policy: createProviderUiSurfacePolicy({
          trustLevel: "untrusted",
          renderMode: "sandboxed",
        }),
      }),
    );

    const html = renderToStaticMarkup(<ProviderShellSurface entry={entry} />);

    expect(html).toContain("Kitchen camera details");
    expect(html).toContain("isolated provider UI container");
    expect(html).toContain("sandboxed");
  });
});
